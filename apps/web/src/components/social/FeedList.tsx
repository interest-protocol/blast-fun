"use client";

import { isPinnablePresale } from "@blast/core/web/contracts/presales.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { SkeletonRegion } from "#web/components/blast-ui/Skeleton.tsx";
import { diagnosticMessage, PublicError } from "#web/lib/errors.ts";
import { hashKey, useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Virtuoso, type Components, type ItemContent } from "react-virtuoso";

import { useHydrated } from "#web/components/ui-libraries/use-hydrated.tsx";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { SocialFeedPage } from "@blast/core/web/contracts/feed.ts";
import type { AsOf, FeedItem } from "@blast/core/web/contracts/items.ts";

import { blastModeCovering, onUncover } from "./blast-mode/live/mode-cover";
import { isFeedDelayed } from "./feed-format";
import { feedItems, feedQuery, latestAsOf, type FeedPages } from "./feed-query";
import styles from "./FeedList.module.css";
import { FeedSkeleton, PostSkeleton } from "./FeedSkeleton.tsx";
import { PostCard } from "./post/PostCard";

type Status = "idle" | "loading" | "error";

/** What the list draws from its query's pages. */
type FeedView = Readonly<{ items: readonly FeedItem[]; asOf: AsOf | null; firstPageRows: number }>;

const viewOf = (data: FeedPages): FeedView => ({ items: feedItems(data), asOf: latestAsOf(data), firstPageRows: data.pages[0]?.page.items.length ?? 0 });

const NO_ITEMS: readonly FeedItem[] = [];

/** Relative times refresh every 30 s (FEATURE-MAP §2.4). */
const TICK_MS = 30_000;

/**
 * How far past the window's edges the virtual list keeps posts drawn: a few
 * cards each way, so a fast scroll or a Tab to the next card finds it there.
 */
const DRAWN_BEYOND_PX = 1000;

/** What each drawn row reads: the clock for relative times and the loaded count for `aria-setsize`. */
type RowContext = Readonly<{ now: number; total: number }>;

/**
 * The virtual list's elements are the plain list's: the same `<ol>` (its
 * flex gap, which Virtuoso measures, is the cards' 13 px) and `<li>`s. Only
 * the posts near the window are in the DOM, so each says where it sits in
 * the loaded list.
 */
const ROWS: Components<FeedItem, RowContext, HTMLUListElement> = {
  List: ({ children, style, ref, "data-testid": testId }) => (
    <ol className={styles.list} data-testid={testId} ref={ref as Ref<HTMLOListElement>} style={style}>
      {children}
    </ol>
  ),
  Item: ({ children, item, context, style, "data-index": index, "data-item-index": itemIndex, "data-known-size": knownSize }) => (
    <li
      aria-posinset={index + 1}
      aria-setsize={context.total}
      data-index={index}
      data-item-index={itemIndex}
      data-known-size={knownSize}
      data-post={item.entry_id}
      style={style}
    >
      {children}
    </li>
  ),
};

const row: ItemContent<FeedItem, RowContext> = (_index, item, context) => <PostCard item={item} nowMs={context.now} />;

const rowKey = (_index: number, item: FeedItem) => item.entry_id;

/** Each drawn row's height when Virtuoso last measured it. */
const measured = new WeakMap<Element, number>();

/**
 * A row's height as laid out: fractional, and blind to transforms (Virtuoso's
 * default rounds the box it reads, which puts the list's end a pixel off the
 * plain list's, and reads an animating card at its animated scale).
 *
 * It also keeps the page's scroll anchoring. The plain list had it from the
 * browser: when a card above the window grew (a narrower window rewraps every
 * card), the posts on screen stayed put. Virtuoso turns the browser's
 * anchoring off on its rows (it moves them itself) and makes up for size
 * changes above only while the reader scrolls up. So when a drawn row that
 * ended above the window changes height, the page moves by as much.
 */
function rowHeight(element: HTMLElement): number {
  const height = parseFloat(getComputedStyle(element).height) || 0;
  const before = measured.get(element);
  measured.set(element, height);
  if (before !== undefined && height !== before && element.getBoundingClientRect().bottom - (height - before) <= 0) window.scrollBy(0, height - before);
  return height;
}

/**
 * The posts as a virtual list scrolled by the window. Its first render draws
 * the first page's rows (`firstPageRows`: the plain list's when it takes over
 * after hydration, so nothing moves); then only those near the window.
 * Virtuoso reads the count when it mounts.
 */
function VirtualRows({ items, now, firstPageRows }: Readonly<{ items: readonly FeedItem[]; now: number; firstPageRows: number }>) {
  return (
    <Virtuoso
      components={ROWS}
      computeItemKey={rowKey}
      context={{ now, total: items.length }}
      data={items}
      increaseViewportBy={DRAWN_BEYOND_PX}
      initialItemCount={firstPageRows}
      itemContent={row}
      itemSize={rowHeight}
      useWindowScroll
    />
  );
}

/**
 * A public feed as an endless list of post cards: the server's first page,
 * then each `next_cursor` page from `endpoint` as the reader nears the end
 * (or taps "Show more"). Nothing is gated at any depth. When `as_of.lag_ms`
 * passes 60 s it says "Activity is delayed" and keeps every post it shows.
 * The end is "You're all caught up." (§2.1).
 *
 * The pages are one TanStack infinite query (OA-38, `feed-query.ts`): the
 * server's page is its initial data (nothing is read on the first paint), each
 * page is read once however often the end comes near, and a list that goes
 * away stops the page it was reading.
 *
 * The list is virtual (OA-28, `docs/product/social-feed/ui-libraries.md`
 * §3.9): every page read stays in memory, but only the posts within
 * `DRAWN_BEYOND_PX` of the window are in the DOM, so a long session does not
 * keep thousands of cards on the page. The window scrolls, as before, and
 * paging is unchanged: the sentinel below the list (which sits at the list's
 * full height) still asks for the next page 800 px early. React-virtuoso
 * writes inline styles, which the CSP refuses in server HTML, so the server
 * and hydration draw the plain list; the virtual one takes over in the
 * browser, starting from the same rows.
 */

export function FeedList({
  endpoint,
  initial,
  nowMs,
  heading,
  empty,
}: Readonly<{
  endpoint: string;
  /** The first page, read on the server; null when that read failed (the list then loads it). */
  initial: SocialFeedPage | null;
  /** The clock relative times count from on the first render, so server and client agree. */
  nowMs: number;
  /** The list's accessible name. */
  heading: string;
  /** Complete empty state, replacing the default panel and its spacing. */
  empty?: ReactNode;
}>) {
  const client = useAppQueryClient();
  const feed = useInfiniteQuery({ ...feedQuery(endpoint, initial), select: viewOf }, client);
  const { fetchNextPage, refetch } = feed;
  const asOf = feed.data?.asOf ?? null;
  const loaded = feed.data !== undefined;
  // The last read failed (a page, or the first): kept until the reader asks again.
  const status: Status = feed.isFetching ? "loading" : feed.failureReason !== null ? "error" : "idle";
  const more = feed.hasNextPage;
  const [now, setNow] = useState(nowMs);
  const items = (feed.data?.items ?? NO_ITEMS).filter((item) => !item.pinned || (item.presale !== null && isPinnablePresale(item.presale, now)));
  // Relative times keep counting from the server's clock (the first render's
  // `nowMs`), so a skewed device clock does not age every post at once.
  const skew = useRef(0);
  const clock = useCallback(() => Date.now() + skew.current, []);
  useEffect(() => {
    skew.current = nowMs - Date.now();
  }, [nowMs]);
  const sentinel = useRef<HTMLDivElement>(null);

  /** The next page (or, before any, the first), one request at a time: an ask while one is out joins it. */
  const loadMore = useCallback(() => void (loaded ? fetchNextPage({ cancelRefetch: false }) : refetch({ cancelRefetch: false })), [loaded, fetchNextPage, refetch]);

  // Relative times count from the moment a page is answered, as from each tick.
  useEffect(() => {
    const queryHash = hashKey(queryKeys.feed.list(endpoint));
    return client.getQueryCache().subscribe((event) => {
      if (event.type === "updated" && event.action.type === "success" && event.query.queryHash === queryHash) setNow(clock());
    });
  }, [client, endpoint, clock]);

  // Relative times move on every 30 s; not while Blast mode covers the page, and at once when it leaves (R3-60).
  useEffect(() => {
    const tick = window.setInterval(() => {
      if (!blastModeCovering()) setNow(clock());
    }, TICK_MS);
    const off = onUncover(() => setNow(clock()));
    return () => {
      window.clearInterval(tick);
      off();
    };
  }, [clock]);

  // Load the next page as the end of the list comes near. (A list that goes away stops the page it is reading: the query's signal.)
  useEffect(() => {
    const target = sentinel.current;
    if (!target || !more || status !== "idle" || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { rootMargin: "800px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [more, status, loadMore]);

  return (
    <section aria-busy={status === "loading"} aria-label={heading} className={styles.feed}>
      <FeedRows asOf={asOf} empty={empty} loaded={loaded} status={status} items={items} now={now} firstPageRows={feed.data?.firstPageRows ?? 0} />
      <FeedEnd error={feed.failureReason} status={status} loaded={loaded} more={more} count={items.length} loadMore={loadMore} sentinel={sentinel} />
    </section>
  );
}

function FeedRows({ asOf, empty, loaded, status, items, now, firstPageRows }: Readonly<{
  asOf: AsOf | null; empty?: ReactNode; loaded: boolean; status: Status;
  items: readonly FeedItem[]; now: number; firstPageRows: number;
}>) {
  const hydrated = useHydrated();
  return <>
      {isFeedDelayed(asOf) ? (
        <p className={styles.delayed} role="status">
          <strong>Activity is delayed.</strong> Recent posts may be missing for a moment; everything shown here stays accurate.
        </p>
      ) : null}
      {!loaded && status === "loading" ? (
        <FeedSkeleton />
      ) : null}
      {loaded && items.length === 0 ? (
        empty ?? (
          <EmptyState action={<Link className="btn btn-line" href="/presale">Browse presales</Link>} framed title="Nothing here yet" />
        )
      ) : null}
      {items.length === 0 ? null : hydrated ? (
        <VirtualRows firstPageRows={firstPageRows} items={items} now={now} />
      ) : (
        <ol className={styles.list}>
          {items.map((item) => (
            <li data-post={item.entry_id} key={item.entry_id}>
              <PostCard item={item} nowMs={now} />
            </li>
          ))}
        </ol>
      )}
  </>;
}

function FeedEnd({ status, loaded, more, count, loadMore, sentinel, error }: Readonly<{
  status: Status; loaded: boolean; more: boolean; count: number; loadMore: () => void; sentinel: Ref<HTMLDivElement>; error: unknown;
}>) {
  return (
      <div className={styles.more}>
        {status === "loading" && loaded ? <SkeletonRegion className={styles.moreSkeleton} label="Loading more posts"><PostSkeleton named={false} /><PostSkeleton named={false} /></SkeletonRegion> : null}
        {status === "loading" && !loaded ? <p className={styles.srOnly} role="status">Loading posts…</p> : null}
        {status === "error" ? (
          <>
            <p role="alert">
              {diagnosticMessage(loaded ? "Couldn’t load more posts. What’s shown above is unchanged." : "Couldn’t load posts. Check your connection and try again.", error instanceof PublicError ? error : { code: "request_failed" })}
            </p>
            <Button onClick={loadMore}>Try again</Button>
          </>
        ) : null}
        {status === "idle" && more ? (
          // Scrolling loads the next page; the button is there for the keyboard (shown on focus).
          <Button className={styles.showMore} onClick={loadMore}>Show more</Button>
        ) : null}
        {status === "idle" && loaded && !more && count > 0 ? <p className={styles.end}>You’re all caught up.</p> : null}
        <div aria-hidden="true" ref={sentinel} />
      </div>
  );
}
