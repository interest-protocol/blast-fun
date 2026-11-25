import { createPublicPresaleReader } from "@blast/server/modules/social/presales/public-reads.ts";
import { socialParameter, socialSingle } from "@blast/server/modules/social/route-kit/validation.ts";
import { z } from "zod";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import { SOCIAL_FEED_DEFAULT_TAB, SOCIAL_FEED_NEW_ACTORS, SOCIAL_FEED_NEW_MAX, SOCIAL_FEED_TABS, type SocialFeedNewActor, type SocialFeedNewResponse, type SocialFeedPage, type SocialFeedTab } from "@blast/core/modules/social/contracts/feed.ts";
import { decodeItemCursor, encodeItemCursor, parseItemLimit, readAsOf, toItems } from "@blast/server/modules/social/items/index.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { settledAll } from "@blast/server/lib/settled-all.ts";
import { forYouEntries, forYouNewEntries, forYouNewEntriesFromHead, forYouNewHead, type ForYouCursor, type RankedEntry } from "@blast/server/modules/social/feed/for-you.ts";

/**
 * A page of the home feed: the For You selection mapped to public items,
 * the next cursor and the read's `as_of`, all from one database (the
 * replica in production). The route and the server-rendered home page share
 * it, so both answer the same page.
 */

export type FeedRequest = Readonly<{ tab: SocialFeedTab; limit: number; before: ForYouCursor | null }>;

/**
 * The For You cursor: T-005's item cursor codec with the boosted rank in its
 * time slot, so it stays opaque, versioned and checked. Rank and time are both
 * non-negative integer milliseconds.
 */
export function encodeForYouCursor(position: ForYouCursor): string {
  return encodeItemCursor({ occurredAtMs: position.rankMs, entryId: position.entryId });
}

/** `invalid_parameter` (parameter `cursor`) for anything `encodeForYouCursor` did not produce. */
export function decodeForYouCursor(cursor: string): ForYouCursor {
  const { occurredAtMs, entryId } = decodeItemCursor(cursor);
  return { rankMs: occurredAtMs, entryId };
}

/** The next page's cursor when the selection filled the page, else null. Pass the selection, not the items. */
export function nextForYouCursor(entries: readonly RankedEntry[], limit: number): string | null {
  const last = entries.at(-1);
  return last && entries.length >= limit ? encodeForYouCursor({ rankMs: last.rankMs, entryId: last.entryId }) : null;
}

function single(searchParams: URLSearchParams, name: string): string | null {
  return socialSingle(searchParams, name);
}

/**
 * `tab` (absent means `for_you`; anything else, `following` included, is
 * invalid), `cursor` and `limit`, each at most once. Other parameters are
 * ignored. Every refusal is `invalid_parameter` naming the parameter.
 */
export function parseFeedRequest(searchParams: URLSearchParams): FeedRequest {
  const tab = socialParameter(z.enum(SOCIAL_FEED_TABS), single(searchParams, "tab") ?? SOCIAL_FEED_DEFAULT_TAB, "tab");
  const cursor = single(searchParams, "cursor");
  return {
    tab,
    limit: parseItemLimit(single(searchParams, "limit")),
    before: cursor === null ? null : decodeForYouCursor(cursor),
  };
}

/**
 * One For You page. The watermark is read beside the items; with no readable
 * watermark the freshness is unknown and the read is `service_unavailable`.
 * Lag itself never fails a read: `as_of.lag_ms` reports it.
 */
export async function readForYouPage(
  db: ReadableDatabase,
  request: Readonly<{
    config: SocialConfig;
    nowMs: number;
    limit: number;
    before: ForYouCursor | null;
    /** Kinds the feed leaves out (the trade kinds while trading is hidden). */
    hiddenKinds: readonly string[];
  }>,
): Promise<SocialFeedPage> {
  const { config, nowMs, limit, before, hiddenKinds } = request;
  const [entries, asOf] = await settledAll([forYouEntries(db, { config, nowMs, limit, before, hiddenKinds }), readAsOf(db)]);
  if (!asOf) throw new SocialRouteError("service_unavailable");
  const pins = new Set(entries.filter((entry) => entry.pinned).map((entry) => entry.entryId));
  return {
    items: (await toItems(db, entries, { nowMs, config })).map((item) => pins.has(item.entry_id) ? { ...item, pinned: true } : item),
    next_cursor: nextForYouCursor(entries, limit),
    as_of: asOf,
  };
}

/**
 * `since` of `GET /api/social/feed/new`: required, once, a non-negative safe
 * integer of milliseconds in plain decimal. Other parameters are ignored.
 */
export function parseFeedNewRequest(searchParams: URLSearchParams): Readonly<{ sinceMs: number }> {
  const raw = single(searchParams, "since");
  const sinceMs = socialParameter(z.string().regex(/^(0|[1-9][0-9]{0,15})$/).transform(Number).pipe(z.number().int()), raw, "since");
  return { sinceMs };
}

const NEW_ACTORS_SQL = `SELECT account_id, callsign, display_name, avatar_url
  FROM social_account_identities
  WHERE account_id = ANY($1::uuid[]) AND callsign IS NOT NULL`;

/**
 * How many For You items are newer than `sinceMs`, capped at
 * `SOCIAL_FEED_NEW_MAX`, and the newest named actors' faces. Same database,
 * rule and hidden kinds as the page, and `service_unavailable` without a
 * readable watermark, like the page.
 */
export async function readForYouNew(
  db: ReadableDatabase,
  request: Readonly<{ config: SocialConfig; nowMs: number; sinceMs: number; hiddenKinds: readonly string[] }>,
): Promise<SocialFeedNewResponse> {
  const [found, asOf] = await Promise.all([
    forYouNewEntries(db, { ...request, max: SOCIAL_FEED_NEW_MAX, actors: SOCIAL_FEED_NEW_ACTORS }),
    readAsOf(db),
  ]);
  if (!asOf) throw new SocialRouteError("service_unavailable");
  const byId = await readNewActors(db, found.actorIds);
  return { count: found.count, more: found.more, actors: newActors(found.actorIds, byId), as_of: asOf };
}

async function readNewActors(db: ReadableDatabase, actorIds: readonly string[]): Promise<ReadonlyMap<string, SocialFeedNewActor>> {
  if (actorIds.length === 0) return new Map();
  const { rows } = await db.read<SocialFeedNewActor & { account_id: string }>(NEW_ACTORS_SQL, [actorIds]);
  return new Map(rows.map((row) => [row.account_id, row]));
}

function newActors(actorIds: readonly string[], byId: ReadonlyMap<string, SocialFeedNewActor>): SocialFeedNewActor[] {
  return actorIds.flatMap((id) => {
    const row = byId.get(id);
    return row ? [{ callsign: row.callsign, display_name: row.display_name, avatar_url: row.avatar_url }] : [];
  });
}

/**
 * One source context per route instance, with no retained data or Redis work.
 * Overlapping reads use the producer's exact clock and database observation.
 * The database factory must be service-owned, never a request transaction or signal.
 */
export function createForYouNewReader(database: () => ReadableDatabase, now = Date.now) {
  const share = createPublicPresaleReader(Date.now, "feed_new");
  return async (request: Readonly<{ config: SocialConfig; sinceMs: number; hiddenKinds: readonly string[] }>): Promise<SocialFeedNewResponse> => {
    const config = { ...request.config };
    const hiddenKinds = [...new Set(request.hiddenKinds)].sort();
    const key = JSON.stringify([
      config.big_commit_usd, config.big_trade_usd, config.for_you_window_days,
      config.for_you_migrated_days, config.why_boost_ms, config.big_boost_ms, hiddenKinds,
    ]);
    const shared = await share(key, async () => {
      const db = database();
      const nowMs = now();
      // A failed branch must not release shared ownership while its sibling still uses the database.
      const [selection, watermark] = await Promise.allSettled([
        forYouNewHead(db, { config, nowMs, hiddenKinds, max: SOCIAL_FEED_NEW_MAX }),
        readAsOf(db),
      ]);
      if (selection.status === "rejected") throw selection.reason;
      if (watermark.status === "rejected") throw watermark.reason;
      const head = selection.value;
      const asOf = watermark.value;
      if (!asOf) throw new SocialRouteError("service_unavailable");
      const all = forYouNewEntriesFromHead(head, 0, SOCIAL_FEED_NEW_ACTORS);
      return { head, asOf, actors: await readNewActors(db, all.actorIds) };
    }, 0);
    const found = forYouNewEntriesFromHead(shared.head, request.sinceMs, SOCIAL_FEED_NEW_ACTORS);
    return { count: found.count, more: found.more, actors: newActors(found.actorIds, shared.actors), as_of: { ...shared.asOf } };
  };
}
