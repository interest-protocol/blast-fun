import { socialParameter, socialSingle } from "@blast/server/modules/social/route-kit/validation.ts";
import { z } from "zod";
import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import { entryFromRow } from "@blast/core/modules/social/read-model/entries.ts";
import { SHOWN_PRESALES, SHOWN_ACTIVITY } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { namedOwnerSql, visibleEntrySql } from "@blast/core/modules/social/read-model/naming.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

import type { HomeDiscussionPage } from "@blast/core/modules/social/contracts/home.ts";
import { decodeItemCursor, nextItemCursor, parseItemLimit, readAsOf, toItems } from "@blast/server/modules/social/items/index.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * The Discussion view of a coin (contract in `contracts/home.ts`): the
 * sale's posts that carry an authored why, newest first, as the feed's own
 * items, so attribution, the explorer link, the rocket, the More menu and
 * moderation (an active why only) are the post card's. Nothing is
 * summarised or generated: an empty thread is empty.
 *
 * The active whys of the sale (`social_whys_presale_active_idx`), each
 * joined to its activity row by that row's key (the entry id names it, as
 * the theses read does), kept when the entry is visible
 * (`visibleEntrySql`: named now, or a presale post of a shown sale). Paged
 * by the items' keyset `(occurred_at_ms, entry_id)`.
 */

const KEY = (n: number) => `CASE WHEN w.entry_id ~ '^a:[0-9]{1,18}:[0-9]{1,10}:[0-9]{1,10}:[0-9]{1,10}$' THEN split_part(w.entry_id, ':', ${n}) END`;

/** $1 sale, $2 big commit USD, $3 big trade USD, $4 limit, $5 time and $6 entry id (the cursor; nulls without one), $7 the sale's coin. */
function discussionSql(): string {
  return `SELECT e.entry_id, e.source, e.kind, e.product, e.occurred_at_ms, e.actor, e.presale_id, e.coin_type,
    e.digest, e.activity_id, e.quote_type, e.quote_amount, e.coin_amount, e.quote_refund, e.usd_value,
    e.usd_price_as_of_ms, e.milestone_value, named.account_id AS named_account_id
  FROM social_whys w
  CROSS JOIN LATERAL (
    SELECT 'a:' || a.activity_id AS entry_id, 'activity'::text AS source, a.kind, a.product, a.timestamp_ms AS occurred_at_ms,
      a.actor, a.presale_id, a.coin_type, a.digest, a.activity_id, a.quote_type, a.quote_amount, a.coin_amount, a.quote_refund,
      a.usd_value, a.usd_price_as_of_ms, NULL::numeric AS milestone_value
    FROM ${SHOWN_ACTIVITY} a
    WHERE a.checkpoint = (${KEY(2)})::bigint AND a.tx_slot = (${KEY(3)})::bigint
      AND a.event_slot = (${KEY(4)})::bigint AND a.part = (${KEY(5)})::bigint
  ) e
  CROSS JOIN LATERAL (SELECT ${namedOwnerSql("e")} AS account_id) named
  WHERE w.state = 'active' AND e.entry_id = w.entry_id
    AND (w.presale_id = $1::text OR (w.presale_id IS NULL AND e.coin_type = $7::text))
    AND ${visibleEntrySql("e", "$2", "$3")}
    AND ($5::bigint IS NULL OR (e.occurred_at_ms, e.entry_id COLLATE "C") < ($5::bigint, $6::text COLLATE "C"))
  ORDER BY e.occurred_at_ms DESC, e.entry_id COLLATE "C" DESC
  LIMIT $4::int`;
}

/** $1 sale, $2 big commit USD, $3 big trade USD, $4 the sale's coin. */
const COUNT_SQL = `SELECT count(*)::int AS total
  FROM social_whys w
  CROSS JOIN LATERAL (
    SELECT 'a:' || a.activity_id AS entry_id, 'activity'::text AS source, a.kind, a.timestamp_ms AS occurred_at_ms, a.actor,
      a.presale_id, a.coin_type, a.usd_value
    FROM ${SHOWN_ACTIVITY} a
    WHERE a.checkpoint = (${KEY(2)})::bigint AND a.tx_slot = (${KEY(3)})::bigint
      AND a.event_slot = (${KEY(4)})::bigint AND a.part = (${KEY(5)})::bigint
  ) e
  WHERE w.state = 'active' AND e.entry_id = w.entry_id
    AND (w.presale_id = $1::text OR (w.presale_id IS NULL AND e.coin_type = $4::text))
    AND ${visibleEntrySql("e", "$2", "$3")}`;

const SALE_COIN_SQL = `SELECT p.sale_token FROM ${SHOWN_PRESALES} p WHERE p.presale_id = $1::text`;

const DISCUSSION_SQL = discussionSql();

for (const text of [DISCUSSION_SQL, COUNT_SQL, SALE_COIN_SQL]) assertChainReadThroughViews(text);

export type DiscussionRequest = Readonly<{ presaleId: string; limit: number; cursor: string | null }>;

/** `presale`, `cursor` and `limit` of the discussion route, each at most once. */
export function parseDiscussionQuery(params: URLSearchParams): DiscussionRequest {
  const single = (name: string) => socialSingle(params, name);
  const presaleId = socialParameter(z.string().regex(SUI_OBJECT_ID_PATTERN), single("presale"), "presale");
  return { presaleId, limit: parseItemLimit(single("limit")), cursor: single("cursor") };
}

export async function readHomeDiscussion(
  db: ReadableDatabase,
  request: DiscussionRequest,
  context: Readonly<{ config: SocialConfig; nowMs: number; hiddenKinds: readonly string[] }>,
): Promise<HomeDiscussionPage> {
  const { config } = context;
  const before = request.cursor === null ? null : decodeItemCursor(request.cursor);
  const [sale, asOf] = await Promise.all([db.read<{ sale_token: string }>(SALE_COIN_SQL, [request.presaleId]), readAsOf(db)]);
  if (!asOf) throw new SocialRouteError("service_unavailable");
  // A sale the web does not show has no page here: its posts stay unread, however they were stamped (T-043).
  const coin = sale.rows[0]?.sale_token;
  if (coin === undefined) throw new SocialRouteError("not_found");
  const values: unknown[] = [request.presaleId, config.big_commit_usd, config.big_trade_usd, request.limit, before?.occurredAtMs ?? null, before?.entryId ?? null, coin];
  const [page, total] = await Promise.all([
    db.read<Parameters<typeof entryFromRow>[0]>(DISCUSSION_SQL, values),
    db.read<{ total: number }>(COUNT_SQL, [request.presaleId, config.big_commit_usd, config.big_trade_usd, coin]),
  ]);
  const hidden = new Set(context.hiddenKinds);
  const entries = page.rows.map(entryFromRow);
  const shown = entries.filter((entry) => !hidden.has(entry.kind));
  return {
    presale_id: request.presaleId,
    items: await toItems(db, shown, { nowMs: context.nowMs, config }),
    total: total.rows[0]?.total ?? 0,
    next_cursor: nextItemCursor(entries, request.limit),
    as_of: asOf,
  };
}
