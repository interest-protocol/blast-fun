"use client";

import clsx from "clsx";
import Link from "next/link";
import { useRef, type ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";

import { Button } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { FeedItem } from "@blast/core/web/contracts/items.ts";
import { SOCIAL_FEED_DELAYED_LAG_MS, type SocialFeedPage } from "@blast/core/web/contracts/feed.ts";
import { HOME_FEED_ENDPOINT } from "../feed-client";
import { feedItems, feedQuery, latestAsOf, type FeedPages } from "../feed-query";
import { ago, walletHue } from "../post/post-format";
import { postView } from "../post/post-model";
import { Avatar, PresaleMark, WalletAvatar } from "../post/PostMedia";
import { postIdOf } from "@blast/core/web/contracts/item-routes.ts";
import { presaleHref } from "../feed-ui/shell-bridge-model";
import { ListSkeleton } from "./sources";
import { TableCard, TableFooter } from "./TableFooter";
import { useTablePagination } from "./use-table-pagination";
import styles from "./CoinHome.module.css";

const viewOf = (data: FeedPages) => ({ items: feedItems(data), asOf: latestAsOf(data) });

/** Who posted: a face (a person's circle, a coin's tile) and the name; the workspace's sidebar adds the @handle under it. */
function PostAuthor({ item, handle = false }: Readonly<{ item: FeedItem; handle?: boolean }>) {
  const actor = item.actor;
  const coin = item.presale;
  const author = actor?.type === "account" ? actor.display_name ?? actor.callsign : actor?.type === "address" ? actor.short : coin?.name ?? "Blast";
  return <div className={styles.postAuthor}>
    {actor?.type === "account" ? <Avatar callsign={actor.callsign} size={30} src={actor.avatar_url} /> : actor?.type === "address" ? <WalletAvatar hue={walletHue(actor.short)} /> : coin ? <PresaleMark coinType={coin.coin_type} presaleId={coin.presale_id} src={coin.icon_url} size={34} /> : <Avatar callsign="blast" size={30} src={null} />}
    <div className={styles.identText}>{actor?.type === "account" ? <Link className={styles.tName} title={author} href={actor.path}>{author}</Link> : <span className={styles.tName} title={author}>{author}</span>}{handle && actor?.type === "account" ? <span className={styles.coinName} title={`@${actor.callsign}`}>@{actor.callsign}</span> : null}</div>
  </div>;
}

export function PostRow({ item, nowMs, onRead, assetAction }: Readonly<{
  item: FeedItem;
  nowMs: number;
  onRead?: () => void;
  assetAction?: ReactNode;
}>) {
  const post = postView(item, null);
  const coin = item.presale;
  const body = post?.body;
  const summary = body?.kind === "news" ? body.headline : body?.kind === "action" ? [body.chip, body.amount, body.tail].filter(Boolean).join(" · ") : "Activity";
  if (onRead) return <WorkspacePostRow item={item} summary={summary} nowMs={nowMs} onRead={onRead} assetAction={assetAction} />;
  const href = `/p/${postIdOf(item.entry_id)}`;
  // One line, as the board's table draws it: what happened, then the author's own words after it.
  return <li className={styles.item}>
    <article className={clsx(styles.row, styles.postCols)}>
      <PostAuthor item={item} />
      <Link className={styles.postSummary} href={href} title={[summary, item.why?.text, coin?.symbol].filter(Boolean).join(" · ")}><span>{summary}</span>{item.why ? <small> {item.why.text}</small> : null}</Link>
      <div className={styles.postCoin}>{coin ? <Link className={styles.postCoinLink} title={coin.symbol} href={presaleHref(coin.presale_id)}><PresaleMark coinType={coin.coin_type} presaleId={coin.presale_id} src={coin.icon_url} size={20} /><span className={styles.holdingSymbol}>{coin.symbol}</span>{coin.verified_team ? <CoinVerifiedMark size="sm" /> : null}</Link> : null}</div>
      <Link className={styles.postWhen} href={href}><time dateTime={new Date(item.occurred_at_ms).toISOString()} title={new Date(item.occurred_at_ms).toUTCString()}>{ago(item.occurred_at_ms, nowMs)}</time></Link>
    </article>
  </li>;
}

function WorkspacePostRow({ item, summary, nowMs, onRead, assetAction }: Readonly<{
  item: FeedItem; summary: string; nowMs: number; onRead: () => void; assetAction?: ReactNode;
}>) {
  return <li className={styles.item} data-workspace-post={item.entry_id}>
    <article className={clsx(styles.row, styles.postCols, styles.workspacePost)}>
      <PostAuthor handle item={item} />
      <button className={clsx(styles.postSummary, styles.workspaceRead)} type="button" onClick={onRead} aria-label={`Read post ${item.entry_id}`}>
        {item.pinned ? <small>Pinned by Blast</small> : null}
        <span>{summary}{item.presale ? ` · ${item.presale.symbol}` : ""}{item.presale?.verified_team ? <>{"\u00a0"}<CoinVerifiedMark size="sm" /></> : null}</span>
        {item.why ? <small>{item.why.text}</small> : null}
      </button>
      <time className={styles.postWhen} dateTime={new Date(item.occurred_at_ms).toISOString()} title={new Date(item.occurred_at_ms).toUTCString()}>{ago(item.occurred_at_ms, nowMs)}</time>
      {assetAction ? <div className={styles.workspaceAsset}>{assetAction}</div> : null}
    </article>
  </li>;
}

/** Public posts (the Main board's Posts): Author · Post · Coin · Time in the section's table card, with the shared footer. */
export function PostsSection({ initial, nowMs }: Readonly<{ initial: SocialFeedPage | null; nowMs: number }>) {
  const query = useInfiniteQuery({ ...feedQuery(HOME_FEED_ENDPOINT, initial), select: viewOf }, useAppQueryClient());
  const items = query.data?.items ?? [];
  const pagination = useTablePagination("posts", items.length, "feed", query.hasNextPage);
  const turn = useRef(0);
  const onPage = async (page: number) => {
    const requested = ++turn.current;
    if ((page - 1) * pagination.rows >= items.length && query.hasNextPage) {
      const next = await query.fetchNextPage({ cancelRefetch: false });
      if (next.isError || requested !== turn.current) return;
    }
    pagination.onPage(page);
  };
  if (!query.data || (items.length === 0 && query.isError)) return <TableCard>{query.isError ? <EmptyState action={<Button onClick={() => void query.refetch()} size="sm">Retry</Button>} listEmpty role="alert" title="Posts couldn’t load" /> : <ListSkeleton rows={3} />}</TableCard>;
  const delayed = (query.data.asOf?.lag_ms ?? 0) > SOCIAL_FEED_DELAYED_LAG_MS;
  return <TableCard>
    {delayed ? <p className={styles.marketNotice} role="status">Activity is delayed.</p> : null}
    {query.isError ? <p className={styles.marketNotice} role="alert">Posts couldn’t load. Showing the previous result. <Button onClick={() => void (query.isFetchNextPageError ? query.fetchNextPage() : query.refetch())} size="xs">Retry</Button></p> : null}
    {items.length === 0 ? <EmptyState listEmpty title="No posts yet" /> : <>
      <div aria-hidden="true" className={clsx(styles.listHead, styles.postCols)}><span>Author</span><span>Post</span><span className={styles.postCoin}>Coin</span><span className={styles.hEnd}>Time</span></div>
      <ol aria-label="Posts" aria-busy={query.isFetching || undefined} className={styles.list}>{items.slice(pagination.start, pagination.start + pagination.rows).map(item => <PostRow item={item} nowMs={nowMs} key={item.entry_id} />)}</ol>
    </>}
    {items.length > 0 ? <TableFooter pending={query.isFetching} what="posts" {...pagination} onPage={page => void onPage(page)} /> : null}
  </TableCard>;
}
