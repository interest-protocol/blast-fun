"use client";
import { queryKeys } from "#web/lib/query/keys.ts";
import { DelayedNote, LoadFailed, NothingHere, RefreshFailed } from "./DataStates";

import { workspaceScrollOwner } from "./scroll-owner";

import { useId, useLayoutEffect, useRef } from "react";
import {
  keepPreviousData,
  useQuery,
  type UseQueryResult,
} from "@tanstack/react-query";
import { isValidStructTag } from "@mysten/sui/utils";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import {
  Sheet,
  SheetClose,
  SheetHeading,
} from "#web/components/blast-ui/Sheet.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import {
  SOCIAL_FEED_DELAYED_LAG_MS,
  type SocialFeedPage,
} from "@blast/core/web/contracts/feed.ts";
import {
  HOME_DEFAULT_WINDOW,
  type HomeCoin,
  type HomeCoinsByIds,
} from "@blast/core/web/contracts/home.ts";
import type { FeedItem } from "@blast/core/web/contracts/items.ts";
import { fetchFeedPage, HOME_FEED_ENDPOINT } from "../../feed-client";
import { PostRow } from "../../coin-home/PostsSection";
import { Pager } from "#web/components/blast-ui/Pager.tsx";
import { fetchHomeCoins } from "../../coin-home/home-client";
import { PostCard } from "../../post/PostCard";
import { postView } from "../../post/post-model";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { useWorkspace } from "./workspace-context";
import { PanelAddButton, RefreshButton } from "./CoinsRows";
import { assetOnScreen, canonicalCoinType } from "./coin-row-model";
import styles from "./FeedData.module.css";

export function FeedData() {
  const { snapshot, presentation } = useWorkspace();
  return presentation.mode_open &&
    presentation.document_visible &&
    !snapshot.data.collapsed &&
    snapshot.data.selected_view === "Feed" ? (
    <FeedContent />
  ) : null;
}

function FeedContent() {
  const { snapshot, dispatch } = useWorkspace();
  const controls = snapshot.data.controls.Feed;
  const page = controls.page ?? 1;
  const rows = controls.rows ?? 5;
  const cursors = controls.cursors ?? [null];
  const cursor = cursors[page - 1] ?? null;
  const client = useAppQueryClient();
  const read = useQuery(
    {
      queryKey: queryKeys.workspace.feed(rows, cursor),
      queryFn: ({ signal }) =>
        fetchFeedPage(
          `${HOME_FEED_ENDPOINT}&limit=${rows}`,
          cursor,
          fetch,
          signal,
        ),
      placeholderData: keepPreviousData,
      retry: false,
      staleTime: 0,
      refetchOnMount: "always",
    },
    client,
  );
  const items = read.data?.items ?? [];
  const ids = [
    ...new Set(
      items.flatMap((item) => (item.presale ? [item.presale.presale_id] : [])),
    ),
  ];
  const assets = useQuery(
    {
      queryKey: queryKeys.workspace.feedAssets(ids.join(",")),
      queryFn: ({ signal }) => fetchHomeCoins(ids, HOME_DEFAULT_WINDOW, signal),
      enabled: ids.length > 0,
      retry: false,
      staleTime: 0,
      refetchOnMount: "always",
    },
    client,
  );
  const selectPage = (next: number) => {
    if (next > page && read.isPlaceholderData) return;
    const nextCursors = [...cursors];
    if (next === page + 1 && !nextCursors[next - 1] && read.data?.next_cursor)
      nextCursors[next - 1] = read.data.next_cursor;
    dispatch.patchDataControls("Feed", {
      ...controls,
      page: next,
      rows,
      cursors: nextCursors,
      navigation: { ...controls.navigation, scroll_top: 0, anchor: null },
    });
  };
  const open = (entryId: string | null) =>
    dispatch.patchDataControls("Feed", {
      ...controls,
      navigation: {
        ...controls.navigation,
        expanded_ids: entryId ? [entryId] : [],
      },
    });
  return (
    <FeedResult
      read={read}
      assets={assets}
      page={page}
      cursors={cursors}
      onPage={selectPage}
      onOpen={open}
    />
  );
}

function FeedResult({
  read,
  assets,
  page,
  cursors,
  onPage,
  onOpen,
}: Readonly<{
  read: UseQueryResult<SocialFeedPage>;
  assets: UseQueryResult<HomeCoinsByIds>;
  page: number;
  cursors: readonly (string | null)[];
  onPage: (page: number) => void;
  onOpen: (entryId: string | null) => void;
}>) {
  const { snapshot } = useWorkspace();
  const controls = snapshot.data.controls.Feed;
  const items = read.data?.items ?? [];
  const expanded = new Set(controls.navigation.expanded_ids);
  const selected = items.find((item) => expanded.has(item.entry_id));
  const title = useId();
  if (!read.data)
    return read.isError ? (
      <LoadFailed onRetry={() => void read.refetch()} title="Posts could not load" />
    ) : (
      <div role="status" aria-label="Loading posts" aria-busy="true">
        <SkeletonText>Post author, summary and asset</SkeletonText>
      </div>
    );
  return (
    <>
      <div className={styles.controls}>
        <span className={styles.note}>For you</span>
        <RefreshButton
          busy={read.isFetching}
          label="Refresh posts"
          onRefresh={() => void read.refetch()}
          title="Refresh posts"
        />
      </div>
      {read.data.as_of.lag_ms > SOCIAL_FEED_DELAYED_LAG_MS && (
        <DelayedNote />
      )}
      {read.isError && (
        <RefreshFailed onRetry={() => void read.refetch()} title="Posts could not refresh" />
      )}
      {assets.isError && (
        <RefreshFailed onRetry={() => void assets.refetch()} retryLabel="Retry assets" title="Assets could not load">Posts are still shown.</RefreshFailed>
      )}
      <FeedRows
        items={items}
        coins={assets.isError ? [] : (assets.data?.coins ?? [])}
        nowMs={read.data.as_of.timestamp_ms + read.data.as_of.lag_ms}
        busy={read.isFetching}
        pending={read.isPlaceholderData}
        onRead={onOpen}
      />
      {!read.isPlaceholderData && items.length === 0 && (
        <NothingHere title="No posts yet" />
      )}
      <div className={styles.footer}>
        <Pager
          what="posts"
          page={page}
          pages={Math.max(
            page,
            cursors.length,
            page + (read.data.next_cursor ? 1 : 0),
          )}
          onPage={onPage}
        />
      </div>
      <Sheet
        open={Boolean(selected)}
        onRequestClose={() => onOpen(null)}
        labelledBy={title}
      >
        <SheetClose onClick={() => onOpen(null)} />
        <SheetHeading id={title} title="Post" />
        {selected &&
          (postView(selected, null) ? (
            <PostCard
              item={selected}
              nowMs={read.data.as_of.timestamp_ms + read.data.as_of.lag_ms}
              variant="detail"
            />
          ) : (
            <p>Activity from a newer post type.</p>
          ))}
      </Sheet>
    </>
  );
}

function FeedRows({
  items,
  coins,
  nowMs,
  busy,
  pending,
  onRead,
}: Readonly<{
  items: readonly FeedItem[];
  coins: readonly HomeCoin[];
  nowMs: number;
  busy: boolean;
  pending: boolean;
  onRead: (entryId: string) => void;
}>) {
  const { snapshot, dispatch } = useWorkspace();
  const controls = snapshot.data.controls.Feed;
  const list = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const localBody = list.current?.closest<HTMLElement>("#workspace-data-panel");
    const body = localBody ? workspaceScrollOwner(localBody) : null;
    if (!body || pending) return;
    const elements = [
      ...list.current!.querySelectorAll<HTMLElement>("[data-workspace-post]"),
    ];
    const anchor = controls.navigation.anchor;
    const exact =
      anchor &&
      elements.find(
        (element) => element.dataset.workspacePost === anchor.entry_id,
      );
    const row =
      exact ||
      (anchor && elements[Math.min(anchor.index, elements.length - 1)]);
    if (anchor && row) {
      body.scrollTop +=
        row.getBoundingClientRect().top -
        body.getBoundingClientRect().top -
        anchor.offset;
      if (!exact)
        dispatch.patchDataControls("Feed", {
          ...controls,
          navigation: {
            ...controls.navigation,
            anchor: {
              ...anchor,
              entry_id: row.dataset.workspacePost!,
              index: elements.indexOf(row),
            },
          },
        });
    } else body.scrollTop = controls.navigation.scroll_top;
  });
  const assets = new Map(
    coins
      .filter((coin) => isValidStructTag(coin.coin_type))
      .map((coin) => [coin.presale_id, coin]),
  );
  return (
    <ol className={styles.list} ref={list} aria-label="Posts" aria-busy={busy}>
      {items.map((item) => (
        <PostRow
          key={item.entry_id}
          item={item}
          nowMs={nowMs}
          onRead={() => onRead(item.entry_id)}
          assetAction={
            item.presale ? (
              <FeedAsset
                item={item}
                coin={assets.get(item.presale.presale_id)}
              />
            ) : null
          }
        />
      ))}
    </ol>
  );
}

/** The post's coin as its mark and symbol (the full presale id inspects), and the row's add action. */
function FeedAsset({
  item,
  coin,
}: Readonly<{ item: FeedItem; coin?: HomeCoin }>) {
  const { snapshot, dispatch } = useWorkspace();
  if (!item.presale) return null;
  const canonical = coin ? canonicalCoinType(coin.coin_type) : null;
  return (
    <span className={styles.asset}>
      <InspectValue label="presale identifier" value={item.presale.presale_id}>
        <span className={styles.coin}>
          <CoinMark
            coin={{ key: item.presale.presale_id, symbol: item.presale.symbol, iconUrl: item.presale.icon_url || null, round: true }}
            size={16}
          />
          {item.presale.symbol}
          {item.presale.verified_team ? <CoinVerifiedMark size="sm" /> : null}
        </span>
      </InspectValue>
      {coin && (
        <PanelAddButton
          open={assetOnScreen(snapshot, canonical)}
          symbol={coin.symbol}
          onAdd={() => {
            const id = dispatch.add({
              panel_id: crypto.randomUUID(),
              chain: "sui",
              network: "mainnet",
              coin_type: coin.coin_type,
              presale_id: coin.presale_id,
            });
            if (coin.lifecycle === "migrated")
              dispatch.patchPanel(id, { active_namespace: "coin" });
          }}
        />
      )}
    </span>
  );
}
