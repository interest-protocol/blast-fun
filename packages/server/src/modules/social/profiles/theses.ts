import { z } from "zod";
import { socialCountSchema } from "@blast/core/modules/social/contracts/primitives.ts";

import { createHash } from "node:crypto";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SHOWN_ACTIVITY } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { entryFromRow, entryIdBranch, type FeedEntry } from "@blast/core/modules/social/read-model/entries.ts";
import { namedOwnerSql } from "@blast/core/modules/social/read-model/naming.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

/**
 * An account's theses (canonical UI §6.5 "Theses"): its named posts that
 * carry its active why, most rockets first, then newest. Paged by keyset on
 * (rockets, occurred_at_ms, entry_id), all descending, with its own opaque
 * cursor (a rocket count can change between pages; a post then may move, as
 * any ranked list's would, and the client drops one it already shows).
 */

export type ThesisPosition = Readonly<{ rockets: number; occurredAtMs: number; entryId: string }>;

const VERSION = 1;
const MAX_CURSOR_LENGTH = 1_024;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

function check(body: string): string {
  return createHash("sha256").update(`social-theses-cursor:${body}`).digest("base64url").slice(0, 8);
}

export function encodeThesisCursor(position: ThesisPosition): string {
  const body = Buffer.from(JSON.stringify([VERSION, position.rockets, position.occurredAtMs, position.entryId]), "utf8")
    .toString("base64url");
  return `${body}.${check(body)}`;
}

function invalidCursor(): SocialRouteError<"invalid_parameter"> {
  return new SocialRouteError("invalid_parameter", { extra: { parameter: "cursor" } });
}

const thesisCursorSchema = z.tuple([
  z.literal(VERSION), socialCountSchema, socialCountSchema,
  z.string().refine((value) => entryIdBranch(value)?.source === "activity"),
]);

export function decodeThesisCursor(cursor: string): ThesisPosition {
  if (typeof cursor !== "string" || cursor.length > MAX_CURSOR_LENGTH) throw invalidCursor();
  const [body, value, ...rest] = cursor.split(".");
  if (rest.length || !body || !value || !BASE64URL.test(body) || value !== check(body)) throw invalidCursor();
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  const parsed = thesisCursorSchema.safeParse(decoded);
  if (!parsed.success) throw invalidCursor();
  const [, rockets, occurredAtMs, entryId] = parsed.data;
  return { rockets, occurredAtMs, entryId };
}

/**
 * The account's active whys (`social_whys_author_idx`) on activity entries,
 * each joined to its activity row by that row's primary key (the entry id
 * `a:<checkpoint>:<tx_slot>:<event_slot>:<part>` names it; the row is shaped
 * as `social_feed_entries`'s activity branch shapes it), kept when it is a
 * commit, claim or trade the naming rule attributes to this account now,
 * of a sale the web shows (`SHOWN_ACTIVITY`, before the `LIMIT`: a why
 * written on a hidden test sale's commit is never a thesis), with its rocket
 * count (the reactions primary key starts with the entry id). Every step is
 * an index lookup. The slots are u32 and read as `bigint` (up to 10 digits):
 * T-038's trade rows carry `event_slot` 4294967295, past `integer`.
 */
const KEY = (n: number) => `CASE WHEN w.entry_id ~ '^a:[0-9]{1,18}:[0-9]{1,10}:[0-9]{1,10}:[0-9]{1,10}$' THEN split_part(w.entry_id, ':', ${n}) END`;
const THESES_SQL = `
  SELECT e.entry_id, e.source, e.kind, e.product, e.occurred_at_ms, e.actor, e.presale_id, e.coin_type,
    e.digest, e.activity_id, e.quote_type, e.quote_amount, e.coin_amount, e.quote_refund, e.usd_value,
    e.usd_price_as_of_ms, e.milestone_value, named.account_id AS named_account_id, rockets.n AS rockets
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
  CROSS JOIN LATERAL (
    SELECT count(*)::int AS n FROM social_reactions r WHERE r.entry_id = w.entry_id AND r.reaction = 'rocket'
  ) rockets
  WHERE w.author_account_id = $1::uuid AND w.state = 'active'
    AND e.entry_id = w.entry_id
    AND e.kind IN ('presale_commit', 'presale_claim', 'trade_buy', 'trade_sell')
    AND named.account_id = $1::uuid
    AND ($2::int IS NULL OR (rockets.n, e.occurred_at_ms, e.entry_id COLLATE "C") < ($2::int, $3::bigint, $4::text COLLATE "C"))
  ORDER BY rockets.n DESC, e.occurred_at_ms DESC, e.entry_id COLLATE "C" DESC
  LIMIT $5`;

export type ThesisEntry = FeedEntry & Readonly<{ rockets: number }>;

export async function thesisEntriesOf(
  db: ReadableDatabase,
  accountId: string,
  window: Readonly<{ limit: number; before: ThesisPosition | null }>,
): Promise<ThesisEntry[]> {
  const { before } = window;
  const { rows } = await db.read<Parameters<typeof entryFromRow>[0] & { rockets: number }>(THESES_SQL, [
    accountId,
    before?.rockets ?? null,
    before?.occurredAtMs ?? null,
    before?.entryId ?? null,
    window.limit,
  ]);
  return rows.map((row) => ({ ...entryFromRow(row), rockets: row.rockets }));
}

/** The next page's cursor: the last entry's position when the page is full, else null. */
export function nextThesisCursor(entries: readonly ThesisEntry[], limit: number): string | null {
  const last = entries.at(-1);
  return last && entries.length >= limit
    ? encodeThesisCursor({ rockets: last.rockets, occurredAtMs: last.occurredAtMs, entryId: last.entryId })
    : null;
}
