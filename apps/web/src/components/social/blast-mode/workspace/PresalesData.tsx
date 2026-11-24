"use client";
import { queryKeys } from "#web/lib/query/keys.ts";
import { isPinnablePresale } from "@blast/core/web/contracts/presales.ts";
import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { RowsSkeleton } from "./RowsSkeleton";
import { DelayedNote, LoadFailed, NothingHere, RefreshFailed } from "./DataStates";
import { fetchHappening } from "../../happening/happening-store";
import {
  fetchHomeCoins,
  followingPreviewQuery,
} from "../../coin-home/home-client";
import { presaleIdsOf } from "../../coin-home/presale-ids";
import { Pick } from "../../coin-home/HomeControls";
import { Pager } from "#web/components/blast-ui/Pager.tsx";
import { liveFreshness } from "../../home/activity-hints";
import {
  browserGapTimers,
  hintedGap,
  NEW_POSTS_MIN_GAP_MS,
} from "../../home/feed-freshness";
import { useSocialViewer } from "../../SignInGate";
import { useWorkspace } from "./workspace-context";
import { useReportDiscoveryCoins } from "./discovery-preview";
import { CoinsRows, RefreshButton } from "./CoinsRows";
import styles from "./CoinsData.module.css";

export function PresalesData() {
  const { snapshot, presentation } = useWorkspace();
  return presentation.mode_open &&
    presentation.document_visible &&
    !snapshot.data.collapsed &&
    snapshot.data.selected_view === "Presales" ? (
    <PresalesContent />
  ) : null;
}

function usePresalesRows(window: "1h" | "24h") {
  const { owner } = useWorkspace();
  const client = useAppQueryClient();
  const viewer = useSocialViewer();
  // Keep the last complete public result if either composed refresh fails.
  const read = useQuery(
    {
      queryKey: queryKeys.workspace.presales(window),
      queryFn: async ({ signal }) => {
        const happening = await fetchHappening(signal);
        const { ids } = presaleIdsOf(happening, Date.now());
        const coins = ids.length
          ? await fetchHomeCoins(ids, window, signal)
          : null;
        return { happening, coins, ids };
      },
      retry: false,
      staleTime: 0,
      refetchOnMount: "always",
    },
    client,
  );
  const refetch = read.refetch;
  useEffect(() => {
    const gate = hintedGap(NEW_POSTS_MIN_GAP_MS, browserGapTimers(), () => {
      void refetch({ cancelRefetch: false });
    });
    const off = liveFreshness("workspace-presales").subscribe((hint) => {
      if (gate.admit(hint)) void refetch({ cancelRefetch: false });
    });
    return () => {
      off();
      gate.cancel();
    };
  }, [refetch]);
  const ids = read.data?.ids ?? [];
  const options = followingPreviewQuery(
    viewer.getAccessToken ?? (async () => null),
    viewer.callsign ?? "",
    window,
    ids,
  );
  const privatePreview =
    owner.kind === "account" &&
    viewer.signedIn &&
    !!viewer.callsign &&
    !!viewer.getAccessToken;
  const previews = useQuery(
    {
      ...options,
      enabled: privatePreview && ids.length > 0,
      retry: false,
      staleTime: 0,
      refetchOnMount: "always",
    },
    client,
  );
  const coins = ids.flatMap(
    (id) =>
      read.data?.coins?.coins.filter(
        (coin) =>
          coin.presale_id === id &&
          coin.sale !== null &&
          isPinnablePresale(
            { lifecycle: coin.lifecycle, end_ms: coin.sale.end_ms },
            Date.now(),
          ),
      ) ?? [],
  );
  return {
    read,
    coins,
    followed: privatePreview ? previews.data?.previews : undefined,
  };
}

function PresalesContent() {
  const { snapshot, dispatch } = useWorkspace();
  const controls = snapshot.data.controls.Presales;
  const window = controls.window ?? "24h";
  const rows = controls.rows ?? 10;
  const { read, coins, followed } = usePresalesRows(window);
  const refetch = read.refetch;
  const pages = Math.max(1, Math.ceil(coins.length / rows));
  const page = Math.min(controls.page ?? 1, pages);
  useReportDiscoveryCoins("Presales", coins.slice((page - 1) * rows, page * rows));
  useEffect(() => {
    if (read.data && !read.isFetching && (controls.page ?? 1) > pages)
      dispatch.patchDataControls("Presales", { ...controls, page: pages });
  }, [controls, dispatch, pages, read.data, read.isFetching]);
  return (
    <>
      <div className={`${styles.pills} ${styles.listTools}`}>
        {/* The window sets the rows' figures, not which presales are open: with none open it cannot help (audit inventory). */}
        {read.data && coins.length === 0 ? null : <Pick
          label="Window"
          value={window}
          options={["1h", "24h"] as const}
          labels={{ "1h": "1h", "24h": "24h" }}
          onPick={(window) =>
            dispatch.patchDataControls("Presales", {
              ...controls,
              window,
              page: 1,
              navigation: {
                ...controls.navigation,
                scroll_top: 0,
                anchor: null,
              },
            })
          }
        />}
        <RefreshButton
          busy={read.isFetching}
          label="Refresh presales"
          onRefresh={() => void refetch()}
          title="Refresh presales"
        />
      </div>
      {!read.data ? (
        read.isError ? (
          <LoadFailed onRetry={() => void refetch()} title="Presales could not load" />
        ) : (
          <RowsSkeleton label="Loading presales" />
        )
      ) : (
        <>
          {read.isError && (
            <RefreshFailed onRetry={() => void refetch()} title="Presales could not refresh" />
          )}
          {Math.max(
            read.data.happening.as_of.lag_ms,
            read.data.coins?.as_of.lag_ms ?? 0,
          ) > 60_000 && <DelayedNote />}
          {coins.length === 0 ? (
            <NothingHere title="No open presales">New presales show here when they open.</NothingHere>
          ) : (
            <>
              <CoinsRows
                coins={coins.slice((page - 1) * rows, page * rows)}
                nowMs={
                  read.data.coins?.clock_ms ?? read.data.happening.clock_ms
                }
                view="Presales"
                followed={followed}
              />
              <Pager
                what="presales"
                page={page}
                pages={pages}
                onPage={(page) =>
                  dispatch.patchDataControls("Presales", {
                    ...controls,
                    page,
                    navigation: {
                      ...controls.navigation,
                      scroll_top: 0,
                      anchor: null,
                    },
                  })
                }
              />
            </>
          )}
        </>
      )}
    </>
  );
}
