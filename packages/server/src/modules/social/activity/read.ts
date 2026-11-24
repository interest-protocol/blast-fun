import { z } from "zod";
import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  ACTIVITY_CURSOR_PATTERN,
  ACTIVITY_KINDS,
  ACTIVITY_PAGE_SIZE,
  type ActivityKind,
  type SocialActivityEvent,
  type SocialActivityPage,
} from "@blast/core/modules/social/contracts/activity.ts";
import type { FeedItemActor } from "@blast/core/modules/social/contracts/items.ts";
import { profilePagePath } from "@blast/core/modules/social/contracts/profiles.ts";
import { wholeUnits } from "@blast/server/modules/social/happening/read.ts";
import { readAsOf } from "@blast/server/modules/social/items/as-of.ts";
import { toUsd } from "@blast/core/modules/social/items/decimal.ts";
import { shortAddress } from "@blast/server/modules/social/items/mapper.ts";
import { SHOWN_PRESALES, SHOWN_ACTIVITY } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { walletNamingSql } from "@blast/core/modules/social/read-model/naming.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

/**
 * Recent activity (contract in `contracts/activity.ts`): one keyset page of
 * `chain_read_v1.activity`, newest first, on the replica and only through
 * `chain_read_v1` views. Two statements, neither of which grows with the
 * number of accounts, sales or activity rows:
 *
 * 1. the watermark (each pipeline's committed checkpoint and time) and `as_of`;
 * 2. the page: blast-infra's `activity_time` index read newest first from the
 *    cursor, each row kept only if its sale is shown (at launch scale the
 *    planner hashes the ~2,000 shown sales once per statement and probes each
 *    scanned row against it; a trade's coin against the shown sales' coins
 *    the same way), stopped at the page size plus one; then the naming rule
 *    once per kept row and the sale's own fields. Measured by
 *    `loadtest/social-activity-scale.ts`.
 *
 * **Hidden sales stay hidden.** blast-infra hides the test sales of the
 * owner's mainnet run from every presale view (T-043) but deliberately not
 * from `chain_read_v1.activity`, so a reader must join a sale to drop them.
 * This one keeps a row only when `SHOWN_PRESALES` has its sale
 * (`SHOWN_ACTIVITY`, shared with Home's tape), which also drops a sale
 * the web cannot show yet (its coin's metadata has not arrived). The filter
 * runs inside the scan, before the limit: a hidden row costs one hash probe
 * and never a short page.
 */

type BoundsRow = {
  market_checkpoint: string | null;
  presale_checkpoint: string | null;
  presale_timestamp_ms: string | null;
};

const BOUNDS_SQL = `SELECT market_checkpoint, presale_checkpoint, presale_timestamp_ms FROM chain_read_v1.watermark`;

/** The keyset order of `alias`'s rows: their cursor, newest first. */
const orderBy = (alias: string) =>
  `${alias}.timestamp_ms DESC, ${alias}.checkpoint DESC, ${alias}.tx_slot DESC, ${alias}.event_slot DESC, ${alias}.part DESC`;

/**
 * $1 clock, $2 kinds, $3 presale checkpoint, $4 market checkpoint, $5 limit;
 * with a cursor, $6..$10 its timestamp, checkpoint, tx slot, event slot and
 * part. The naming lateral is `OFFSET 0` so it stays a per-row lookup by
 * address, as the tape's (`happening/read.ts`).
 */
export function activityPageSql(withCursor: boolean): string {
  return `SELECT l.activity_id, l.kind, l.timestamp_ms::text AS timestamp_ms, l.checkpoint::text AS checkpoint, l.tx_slot::text AS tx_slot,
  l.event_slot::text AS event_slot, l.part::text AS part, l.actor,
  coalesce(p.presale_id, ps.presale_id) AS presale_id, coalesce(p.sale_name, ps.sale_name) AS sale_name,
  coalesce(p.sale_symbol, ps.sale_symbol) AS sale_symbol, coalesce(p.sale_decimals, ps.sale_decimals) AS sale_decimals,
  coalesce(p.quote_symbol, ps.quote_symbol) AS quote_symbol, coalesce(p.quote_decimals, ps.quote_decimals) AS quote_decimals,
  l.usd_value::text AS usd_value, l.quote_amount::text AS quote_amount, l.coin_amount::text AS coin_amount, l.quote_refund::text AS quote_refund,
  i.callsign, i.display_name, i.avatar_url, i.x_handle, i.verified
FROM (
  SELECT a.activity_id, a.checkpoint, a.tx_slot, a.event_slot, a.part, a.kind, a.timestamp_ms, a.actor, a.presale_id, a.coin_type,
    a.usd_value, a.quote_amount, a.coin_amount, a.quote_refund
  FROM ${SHOWN_ACTIVITY} a
  WHERE a.timestamp_ms <= $1::bigint AND a.kind = ANY($2::text[])
    AND a.checkpoint <= CASE WHEN a.kind IN ('presale_commit', 'presale_claim') THEN $3::bigint ELSE $4::bigint END${
      withCursor
        ? `
    AND a.timestamp_ms <= $6::bigint
    AND (a.timestamp_ms, a.checkpoint, a.tx_slot, a.event_slot, a.part) < ($6::bigint, $7::bigint, $8::bigint, $9::bigint, $10::bigint)`
        : ""
    }
  ORDER BY ${orderBy("a")}
  LIMIT $5::int
) AS l
LEFT JOIN LATERAL (SELECT owner.account_id, owner.named_from_ms FROM ${walletNamingSql("l.actor")} AS owner OFFSET 0) AS n
  ON n.named_from_ms <= l.timestamp_ms
LEFT JOIN social_account_identities i ON i.account_id = n.account_id
LEFT JOIN ${SHOWN_PRESALES} p ON p.presale_id = l.presale_id
LEFT JOIN ${SHOWN_PRESALES} ps ON l.presale_id IS NULL AND ps.sale_token = l.coin_type
ORDER BY ${orderBy("l")}`;
}

for (const text of [BOUNDS_SQL, activityPageSql(false), activityPageSql(true)]) assertChainReadThroughViews(text);

type PageRow = {
  activity_id: string;
  kind: string;
  timestamp_ms: string;
  checkpoint: string;
  tx_slot: string;
  event_slot: string;
  part: string;
  actor: string;
  presale_id: string | null;
  sale_name: string | null;
  sale_symbol: string | null;
  sale_decimals: number | null;
  quote_symbol: string | null;
  quote_decimals: number | null;
  usd_value: string | null;
  quote_amount: string | null;
  coin_amount: string | null;
  quote_refund: string | null;
  callsign: string | null;
  display_name: string | null;
  avatar_url: string | null;
  x_handle: string | null;
  verified: boolean | null;
};

export type ActivityCursor = Readonly<{ timestampMs: string; checkpoint: string; txSlot: string; eventSlot: string; part: string }>;

export type ActivityRequest = Readonly<{
  nowMs: number;
  /** `before`: the rows after this cursor; null for the newest page. */
  before: ActivityCursor | null;
  /** Activity kinds left out (the trade kinds while trading is hidden, OA-7). */
  hiddenKinds: readonly string[];
}>;

/** A `before` value, or `invalid_parameter` (`before`). */
export function decodeActivityCursor(raw: string): ActivityCursor {
  const parsed = z.string().regex(ACTIVITY_CURSOR_PATTERN).safeParse(raw);
  if (!parsed.success) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "before" } });
  const match = ACTIVITY_CURSOR_PATTERN.exec(parsed.data)!;
  const [, timestampMs, checkpoint, txSlot, eventSlot, part] = match as unknown as [string, string, string, string, string, string];
  return { timestampMs, checkpoint, txSlot, eventSlot, part };
}

function cursorOf(row: PageRow): string {
  return `${row.timestamp_ms}:${row.checkpoint}:${row.tx_slot}:${row.event_slot}:${row.part}`;
}

function actorOf(row: PageRow): FeedItemActor {
  if (row.callsign) {
    return {
      type: "account",
      callsign: row.callsign,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      x_handle: row.x_handle,
      verified: row.verified === true,
      path: profilePagePath(row.callsign),
    };
  }
  return { type: "address", address: row.actor, short: shortAddress(row.actor) };
}

/** Whole units of `atoms`, or null for none (or zero, when `zeroIsNone`). */
function units(atoms: string | null, decimals: number | null, zeroIsNone: boolean): string | null {
  if (atoms === null || decimals === null || (zeroIsNone && atoms === "0")) return null;
  return wholeUnits(atoms, decimals);
}

const KNOWN: ReadonlySet<string> = new Set(ACTIVITY_KINDS);

/** One row as the contract carries it; null for a row the read cannot describe (no shown sale). */
export function activityEvent(row: PageRow): SocialActivityEvent | null {
  if (!KNOWN.has(row.kind) || row.presale_id === null || row.sale_symbol === null || row.sale_name === null || row.quote_symbol === null) {
    return null;
  }
  const kind = row.kind as ActivityKind;
  const claim = kind === "presale_claim";
  return {
    activity_id: row.activity_id,
    kind,
    occurred_at_ms: Number(row.timestamp_ms),
    actor: actorOf(row),
    presale_id: row.presale_id,
    sale_name: row.sale_name,
    symbol: row.sale_symbol,
    quote_symbol: row.quote_symbol,
    usd: row.usd_value === null ? null : toUsd(row.usd_value),
    quote: claim ? null : units(row.quote_amount, row.quote_decimals, false),
    tokens: kind === "presale_commit" ? null : units(row.coin_amount, row.sale_decimals, true),
    refund: claim ? units(row.quote_refund, row.quote_decimals, true) : null,
  };
}

/** The watermark's per-pipeline bounds, or `service_unavailable` when a pipeline has committed nothing readable. */
async function readBounds(db: ReadableDatabase): Promise<{ presaleCheckpoint: string; presaleMs: number; marketCheckpoint: string }> {
  const row = (await db.read<BoundsRow>(BOUNDS_SQL)).rows[0];
  if (!row || row.presale_checkpoint === null || row.presale_timestamp_ms === null || row.market_checkpoint === null) {
    throw new SocialRouteError("service_unavailable");
  }
  return { presaleCheckpoint: row.presale_checkpoint, presaleMs: Number(row.presale_timestamp_ms), marketCheckpoint: row.market_checkpoint };
}

/** The whole `GET /api/social/activity` body. */
export async function readActivityPage(db: ReadableDatabase, request: ActivityRequest): Promise<SocialActivityPage> {
  const [bounds, asOf] = await Promise.all([readBounds(db), readAsOf(db)]);
  if (!asOf) throw new SocialRouteError("service_unavailable");
  const clockMs = Math.min(request.nowMs, bounds.presaleMs);
  const hidden = new Set(request.hiddenKinds);
  const kinds = ACTIVITY_KINDS.filter((kind) => !hidden.has(kind));
  const values: unknown[] = [clockMs, kinds, bounds.presaleCheckpoint, bounds.marketCheckpoint, ACTIVITY_PAGE_SIZE + 1];
  const before = request.before;
  if (before) values.push(before.timestampMs, before.checkpoint, before.txSlot, before.eventSlot, before.part);
  const { rows } = await db.read<PageRow>(activityPageSql(before !== null), values);
  const page = rows.slice(0, ACTIVITY_PAGE_SIZE);
  const last = page.at(-1);
  return {
    events: page.flatMap((row) => activityEvent(row) ?? []),
    next_cursor: rows.length > ACTIVITY_PAGE_SIZE && last ? cursorOf(last) : null,
    as_of: asOf,
  };
}
