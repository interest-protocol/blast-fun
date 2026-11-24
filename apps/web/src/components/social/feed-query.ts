"use client";

import { infiniteQueryOptions, type InfiniteData } from "@tanstack/react-query";

import { GC_MS, PUBLIC_STALE_MS } from "#web/lib/query/client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import type { SocialFeedPage } from "@blast/core/web/contracts/feed.ts";
import type { AsOf, FeedItem } from "@blast/core/web/contracts/items.ts";

import { fetchFeedPage, HOME_FEED_ENDPOINT } from "./feed-client";

/**
 * A keyset feed as one TanStack infinite query (OA-38): Home's For You and a
 * profile's Theses and Activity, keyed by endpoint (`queryKeys.feed.list`).
 * The read sends no access token and the route answers every caller alike, so
 * the key names no viewer.
 *
 * Each page is the answer to one `next_cursor` (`pageParam`; null is the
 * first page), so every row the list shows is in this one cache entry.
 *
 * Keep the reading session across short route and tab changes:
 * - Home's `staleTime: "static"`: nothing refetches it behind the reader (no mount,
 *   reconnect or invalidation refetch, which would read every page again and
 *   move the list under them). Only the reader's own asks read: the next page
 *   and "Try again".
 * - Profile feeds revalidate stale pages while keeping their last answer visible.
 * - `gcTime: GC_MS`: revisits keep the answered pages, including empty results.
 * - `retry: false`: a failed page says so at once, with "Try again".
 */

/** One answered page, and when it was answered relative to the others (the latest says how far behind the feed is). */
export type FeedRead = Readonly<{ page: SocialFeedPage; answered: number }>;

export type FeedPages = InfiniteData<FeedRead, string | null>;

let answers = 0;
const answered = () => ++answers;

/** The query for `endpoint`'s pages; `initial` (the server's first page) is its data on the server, at hydration and on mount. */
export function feedQuery(endpoint: string, initial: SocialFeedPage | null) {
  return infiniteQueryOptions({
    queryKey: queryKeys.feed.list(endpoint),
    queryFn: async ({ pageParam, signal }): Promise<FeedRead> => ({ page: await fetchFeedPage(endpoint, pageParam, fetch, signal), answered: answered() }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: FeedRead) => last.page.next_cursor,
    initialData: initial === null ? undefined : { pages: [{ page: initial, answered: 0 }], pageParams: [null] },
    staleTime: endpoint === HOME_FEED_ENDPOINT ? "static" : PUBLIC_STALE_MS,
    gcTime: GC_MS,
    retry: false,
    // Pages are kept as answered: sharing structure with the previous data would deep-compare every page.
    structuralSharing: false,
  });
}

/** The rows a feed shows, in order: its pages' items, an entry already shown not shown twice (a rank can move between reads). */
export function feedItems(data: FeedPages | undefined): readonly FeedItem[] {
  if (data === undefined) return [];
  const seen = new Set<string>();
  const items: FeedItem[] = [];
  for (const read of data.pages) {
    for (const item of read.page.items) {
      if (seen.has(item.entry_id)) continue;
      seen.add(item.entry_id);
      items.push(item);
    }
  }
  return items;
}

/** The `as_of` of the page answered last: how far behind the feed was at the latest read. */
export function latestAsOf(data: FeedPages | undefined): AsOf | null {
  let latest: FeedRead | null = null;
  for (const read of data?.pages ?? []) if (latest === null || read.answered > latest.answered) latest = read;
  return latest?.page.as_of ?? null;
}
