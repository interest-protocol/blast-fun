"use client";
import { queryKeys } from "#web/lib/query/keys.ts";
import { FieldGroup, TextField } from "#web/components/blast-ui/TextField.tsx";
import { SearchIcon } from "#web/components/blast-ui/Icons.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { DiagnosticText } from "#web/components/blast-ui/DiagnosticText.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { TRADER_SEARCH_TEXT_LIMIT, useWalletSearchSubmit, WALLET_SEARCH_MAX_LENGTH } from "#web/lib/wallet-search.ts";

import { useEffect, useId, useState } from "react";
import {
  keepPreviousData,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { RowsSkeleton } from "./RowsSkeleton";
import { DelayedNote, LoadFailed, NothingHere, RefreshFailed } from "./DataStates";
import {
  HOME_DEFAULT_WINDOW,
  hasPublicPnl,
  type HomeTradersPage,
} from "@blast/core/web/contracts/home.ts";
import { fetchHomeTraders } from "../../coin-home/home-client";
import { Pager } from "#web/components/blast-ui/Pager.tsx";
import { MetricHelp } from "../../coin-home/MetricHelp";
import { liveFreshness } from "../../home/activity-hints";
import {
  browserGapTimers,
  hintedGap,
  NEW_POSTS_MIN_GAP_MS,
} from "../../home/feed-freshness";
import { useWorkspace } from "./workspace-context";
import { TraderRows } from "./TraderRows";
import { RefreshButton } from "./CoinsRows";
import rowStyles from "./CoinsData.module.css";
import styles from "./TradersData.module.css";

export function TradersData() {
  const { snapshot, presentation } = useWorkspace();
  return presentation.mode_open &&
    presentation.document_visible &&
    !snapshot.data.collapsed &&
    snapshot.data.selected_view === "Traders" ? (
    <TradersContent />
  ) : null;
}

function TradersContent() {
  const { snapshot, dispatch } = useWorkspace();
  const controls = snapshot.data.controls.Traders;
  const [extendedDraft, setExtendedDraft] = useState<string | null>(null);
  const draft = extendedDraft ?? controls.search_draft;
  const id = useId();
  const client = useAppQueryClient();
  const read = useQuery(
    {
      queryKey: queryKeys.workspace.traders(controls.search, controls.page, controls.rows),
      queryFn: ({ signal }) =>
        fetchHomeTraders(HOME_DEFAULT_WINDOW, signal, {
          search: controls.search,
          page: controls.page,
          limit: controls.rows,
        }),
      placeholderData: keepPreviousData,
      retry: false,
      staleTime: 0,
      refetchOnMount: "always",
    },
    client,
  );
  const refetch = read.refetch;
  useEffect(() => {
    if (!controls.live) return;
    const gate = hintedGap(
      NEW_POSTS_MIN_GAP_MS,
      browserGapTimers(),
      () => void refetch({ cancelRefetch: false }),
    );
    const off = liveFreshness("workspace-traders").subscribe((hint) => {
      if (gate.admit(hint)) void refetch({ cancelRefetch: false });
    });
    return () => {
      off();
      gate.cancel();
    };
  }, [controls.live, refetch]);
  useEffect(() => {
    if (
      read.data &&
      !read.isPlaceholderData &&
      read.data.page !== controls.page
    )
      dispatch.patchDataControls("Traders", {
        ...controls,
        page: read.data.page,
      });
  }, [controls, dispatch, read.data, read.isPlaceholderData]);
  const select = (search: string, page = 1, draft = search) =>
    dispatch.patchDataControls("Traders", {
      ...dispatch.getSnapshot().data.controls.Traders,
      search,
      search_draft: draft,
      page,
      navigation: { scroll_top: 0, expanded_ids: [], anchor: null },
    });
  const { cancel, issue, pending, submit } = useWalletSearchSubmit((search, query) => {
    select(search, 1, query.length <= TRADER_SEARCH_TEXT_LIMIT ? query : search);
  });
  return (
    <>
      <div className={styles.searchRow}>
        <form
          role="search"
          aria-label="Search Data traders"
          className={styles.search}
          onSubmit={(event) => {
            event.preventDefault();
            submit(draft);
          }}
        >
          <label htmlFor={`${id}-search`} className={rowStyles.visuallyHidden}>
            Name, handle or wallet
          </label>
          <FieldGroup size="sm" className={rowStyles.search}>
            <SearchIcon />
            <TextField size="sm"
              id={`${id}-search`}
              type="search"
              placeholder="Name, @handle or wallet"
              maxLength={WALLET_SEARCH_MAX_LENGTH}
              autoComplete="off"
              spellCheck={false}
              value={draft}
              onChange={(event) => {
                cancel();
                const value = event.target.value;
                const extended = value.length > TRADER_SEARCH_TEXT_LIMIT;
                setExtendedDraft(extended ? value : null);
                if (extended) return;
                // Clearing the field (its native clear, or deleting the text) clears the search too.
                if (value === "" && controls.search) select("");
                else
                  dispatch.patchDataControls("Traders", {
                    ...controls,
                    search_draft: value,
                  });
              }}
            />
          </FieldGroup>
        </form>
        <RefreshButton
          busy={read.isFetching}
          label="Refresh traders"
          onRefresh={() => void refetch()}
          title="Refresh traders"
        />
      </div>
      {issue ? <EmptyState role="alert" title={<DiagnosticText message={issue.message} />} action={issue.retry ? <Button onClick={issue.retry} size="sm">Try again</Button> : null} /> : <TradersResult
        read={read}
        rows={controls.rows}
        pending={pending}
        onPage={(page) => select(controls.search, page, controls.search_draft)}
      />}
    </>
  );
}

/** Live rankings as a quiet text switch on the note line: a dot and "Live" or "Paused". */
function TradersLive() {
  const { snapshot, dispatch } = useWorkspace();
  const controls = snapshot.data.controls.Traders;
  return (
    <Button variant="ghost" size="sm"
      aria-checked={controls.live}
      aria-label="Live rankings"
      className={styles.live}
      onClick={() => dispatch.patchDataControls("Traders", { ...controls, live: !controls.live })}
      role="switch"
      type="button"
    >
      {controls.live ? "Live" : "Paused"}
    </Button>
  );
}

function traderResultCount(data: HomeTradersPage) {
  if (data.total === 0) return null;
  return `${data.total} ${data.total === 1 ? "trader" : "traders"}${data.search ? " found · Ranks are global" : " ranked"}`;
}

function TradersResult({
  read,
  rows,
  pending,
  onPage,
}: Readonly<{
  read: UseQueryResult<HomeTradersPage>;
  rows: 5 | 10 | 20;
  pending: boolean;
  onPage: (page: number) => void;
}>) {
  const refetch = read.refetch;
  const data = read.data;
  if (!data)
    return read.isError ? (
      <LoadFailed onRetry={() => void refetch()} title="Traders could not load" />
    ) : (
      <RowsSkeleton label="Loading traders" />
    );
  return (
    <>
      {read.isError && (
        <RefreshFailed onRetry={() => void refetch()} title="Traders could not refresh" />
      )}
      {data.as_of.lag_ms > 60_000 && <DelayedNote />}
      <div className={styles.note}>
        {pending ? <LoadingIndicator label="Searching traders" /> : <p role="status">
          {read.isPlaceholderData
            ? "Updating results…"
            : traderResultCount(data)}
        </p>}
        {/* The metric and Live describe rows; an empty board or search has none to describe (audit inventory). */}
        {data.traders.length === 0 ? null : <span className={styles.noteTools}>
          <MetricHelp why="Realized and unrealized PnL from public profiles.">
            PnL · All time
          </MetricHelp>
          <TradersLive />
        </span>}
      </div>
      <div aria-busy={read.isFetching || pending}>
        <TraderRows traders={data.traders.filter(hasPublicPnl)} />
        {!read.isPlaceholderData && data.traders.length === 0 && (
          <NothingHere title={data.search ? "No matching traders" : "No traders with public PnL yet"}>
            {data.search ? "Try another name, handle or wallet." : null}
          </NothingHere>
        )}
      </div>
      <Pager
        what="traders"
        page={data.page}
        pages={Math.max(1, Math.ceil(data.total / rows))}
        onPage={onPage}
      />
    </>
  );
}
