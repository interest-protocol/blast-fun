import { accountIdOf } from "../accounts/lookup.ts";
import { socialParameter, socialSingle } from "@blast/server/modules/social/route-kit/validation.ts";
import { z } from "zod";
import { socialCountSchema } from "@blast/core/modules/social/contracts/primitives.ts";

import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { activityEntryId } from "@blast/core/modules/social/contracts/feed-entries.ts";
import { toUsd } from "@blast/core/modules/social/items/decimal.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

import {
  HOME_PARTICIPANT_EVENTS,
  HOME_THREAD_PAGE,
  isHomeWindow,
  type HomeEvent,
  type HomeParticipant,
  type HomeThreadPage,
  type HomeWindow,
} from "@blast/core/modules/social/contracts/home.ts";
import { readAsOf } from "@blast/server/modules/social/items/as-of.ts";
import { activityOf, countsOf, isHomeKind, participantOf, quoteAssetOf } from "@blast/server/modules/social/home/aggregate.ts";
import { decodeCursor, encodeCursor, invalidCursor } from "@blast/server/modules/social/home/codec.ts";
import { readPeople, readSides } from "@blast/server/modules/social/home/coins.ts";
import {
  GROUPED_GROUP,
  GROUPED_SELECT,
  Params,
  ROW_ORDER,
  homeSpan,
  readHomeBounds,
  rowsWithSql,
  selectHome,
  visibleKinds,
  type ActorScope,
  type GroupedRow,
  type HomeBounds,
  type HomeSpan,
  type RowsRequest,
  type SideRow,
} from "@blast/server/modules/social/home/sql.ts";
import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * The thread under one coin or presale (contract in `contracts/home.ts`):
 * its participants in the window grouped by identity, newest first, each
 * with its totals per direction and its newest underlying events.
 *
 * Statements: the bounds; the window's sums for the sale (every
 * participant, so the totals and counts are the whole window's); one page
 * of grouped participants by keyset `(latest_ms DESC, who)`; the page's
 * events (the newest `HOME_PARTICIPANT_EVENTS` of each, by one window
 * function); the identities and follower counts of the page's accounts.
 *
 * The cursor carries the public key of the last participant
 * (`c:<callsign>` or `w:<address>`), never an account id; the read turns a
 * callsign back into the identity the order uses.
 */

export type ThreadCursor = Readonly<{ latestMs: number; key: string }>;

const CURSOR_TAG = "thread";

export function encodeThreadCursor(position: ThreadCursor): string {
  return encodeCursor(CURSOR_TAG, [1, position.latestMs, position.key]);
}

const threadCursorSchema = z.tuple([
  z.literal(1), socialCountSchema, z.string().regex(/^(c:[a-z0-9_]{3,20}|w:0x[0-9a-f]{64})$/),
]).rest(z.unknown());

export function decodeThreadCursor(cursor: string): ThreadCursor {
  const parsed = threadCursorSchema.safeParse(decodeCursor(CURSOR_TAG, cursor));
  if (!parsed.success) throw invalidCursor();
  return { latestMs: parsed.data[1], key: parsed.data[2] };
}

/** The `who` of a public participant key: `w:<address>` as is; `c:<callsign>` through the account's id, or null for an unknown callsign. */
async function whoOfKey(db: ReadableDatabase, key: string): Promise<string | null> {
  if (key.startsWith("w:")) return key;
  const accountId = await accountIdOf(db, key.slice(2));
  return accountId ? `a:${accountId}` : null;
}

export type EventRow = Readonly<{
  who: string;
  activity_id: string;
  kind: string;
  timestamp_ms: string;
  digest: string | null;
  quote_type: string;
  sale_quote: string;
  sale_quote_symbol: string;
  sale_quote_decimals: number;
  quote_amount: string | null;
  coin_amount: string | null;
  quote_refund: string | null;
  usd_value: string | null;
  has_why: boolean;
}>;

export function eventOf(row: EventRow): HomeEvent | null {
  if (!isHomeKind(row.kind)) return null;
  const asset = quoteAssetOf(row.quote_type, row);
  const claim = row.kind === "presale_claim";
  const quoteAtoms = claim ? null : row.quote_amount;
  return {
    activity_id: row.activity_id,
    entry_id: activityEntryId(row.activity_id),
    kind: row.kind,
    occurred_at_ms: Number(row.timestamp_ms),
    digest: row.digest,
    quote: quoteAtoms === null
      ? null
      : { quote_type: row.quote_type, quote_symbol: asset.symbol, quote_decimals: asset.decimals, atoms: quoteAtoms, usd: row.usd_value === null ? null : toUsd(row.usd_value), usd_complete: row.usd_value !== null },
    tokens: row.coin_amount === null || row.coin_amount === "0" ? null : row.coin_amount,
    refund: claim && row.quote_refund !== null && row.quote_refund !== "0" ? row.quote_refund : null,
    has_why: row.has_why === true,
  };
}

/** The newest events of each `who` in the page, at most `HOME_PARTICIPANT_EVENTS` each, plus one to say there are more. */
async function readEvents(db: ReadableDatabase, request: RowsRequest, whos: readonly string[]): Promise<ReadonlyMap<string, readonly EventRow[]>> {
  if (whos.length === 0) return new Map();
  const params = new Params();
  const list = params.add([...whos]);
  const limit = params.add(HOME_PARTICIPANT_EVENTS + 1);
  const text = selectHome(rowsWithSql(request, params), `SELECT ranked.who, ranked.activity_id, ranked.kind, ranked.timestamp_ms::text AS timestamp_ms, ranked.digest, ranked.quote_type,
    ranked.sale_quote, ranked.sale_quote_symbol, ranked.sale_quote_decimals,
    ranked.quote_amount::text AS quote_amount, ranked.coin_amount::text AS coin_amount, ranked.quote_refund::text AS quote_refund,
    ranked.usd_value::text AS usd_value,
    EXISTS (SELECT 1 FROM social_whys wy WHERE wy.entry_id = 'a:' || ranked.activity_id AND wy.state = 'active') AS has_why
  FROM (
    SELECT w.*, row_number() OVER (PARTITION BY w.who ORDER BY ${ROW_ORDER("w")}) AS rn
    FROM home_who w WHERE w.who = ANY(${list}::text[])
  ) ranked
  WHERE ranked.rn <= ${limit}::int
  ORDER BY ranked.who, ranked.rn`);
  assertChainReadThroughViews(text);
  const { rows } = await db.read<EventRow>(text, params.values);
  const byWho = new Map<string, EventRow[]>();
  for (const row of rows) byWho.set(row.who, [...(byWho.get(row.who) ?? []), row]);
  return byWho;
}

/** One keyset page of grouped participants of the sale: newest first, then by identity. */
async function readParticipantPage(db: ReadableDatabase, request: RowsRequest, after: Readonly<{ latestMs: number; who: string }> | null): Promise<readonly GroupedRow[]> {
  const params = new Params();
  const limit = params.add(HOME_THREAD_PAGE + 1);
  const keyset = after === null ? "" : ` WHERE (g.latest_ms::bigint, g.who) < (${params.add(after.latestMs)}::bigint, ${params.add(after.who)}::text)`;
  const text = selectHome(`${rowsWithSql(request, params)},
  home_grouped AS (${GROUPED_SELECT} ${GROUPED_GROUP})`, `SELECT g.sale, g.who, g.account_id, g.wallet, g.events_total, g.latest_ms, g.latest_kind FROM home_grouped g${keyset}
  ORDER BY g.latest_ms::bigint DESC, g.who LIMIT ${limit}::int`);
  assertChainReadThroughViews(text);
  return (await db.read<GroupedRow>(text, params.values)).rows;
}

/** The coin a thread is under: a sale's by its presale, a curve coin's by its type. */
export type ThreadCoin = Readonly<{ presaleId: string; coinType: null } | { presaleId: null; coinType: string }>;

export type ThreadRequest = Readonly<{
  coin: ThreadCoin;
  window: HomeWindow;
  cursor: string | null;
  nowMs: number;
  hiddenKinds: readonly string[];
  actors: ActorScope;
  minimumMarketCheckpoint?: number;
}>;

/** `presale` or `coin` (exactly one), `window` and `cursor` of the activity route, each at most once. */
export function parseThreadQuery(params: URLSearchParams): Readonly<{ coin: ThreadCoin; window: HomeWindow; cursor: string | null }> {
  const single = (name: string) => socialSingle(params, name);
  const coinType = single("coin");
  const presaleId = single("presale");
  if (coinType !== null && presaleId !== null) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "coin" } });
  const coin: ThreadCoin = coinType !== null
    ? { presaleId: null, coinType: socialParameter(z.string().regex(COIN_TYPE), coinType, "coin") }
    : { presaleId: socialParameter(z.string().regex(SUI_OBJECT_ID_PATTERN), presaleId, "presale"), coinType: null };
  const window = single("window") ?? "24h";
  if (!isHomeWindow(window)) throw new SocialRouteError("invalid_parameter", { extra: { parameter: "window" } });
  const cursor = single("cursor");
  if (cursor !== null && cursor.length === 0) throw invalidCursor();
  return { coin, window, cursor };
}

/** The whole thread page, in the public or the followed scope. */
export async function readHomeThread(db: ReadableDatabase, request: ThreadRequest): Promise<HomeThreadPage> {
  const cursor = request.cursor === null ? null : decodeThreadCursor(request.cursor);
  const [bounds, asOf] = await Promise.all([readHomeBounds(db, request.nowMs), readAsOf(db)]);
  if (!asOf || bounds.marketCheckpoint < (request.minimumMarketCheckpoint ?? 0)) {
    throw new SocialRouteError("service_unavailable");
  }
  const span = homeSpan(request.window, bounds);
  return readThreadIn(db, { ...request, span, bounds, cursor, asOf });
}

/** The thread with its bounds already read (the Following route shares the bounds across modes). */
export async function readThreadIn(
  db: ReadableDatabase,
  input: Readonly<{ coin: ThreadCoin; window: HomeWindow; cursor: ThreadCursor | null; hiddenKinds: readonly string[]; actors: ActorScope; span: HomeSpan; bounds: HomeBounds; asOf: HomeThreadPage["as_of"] }>,
): Promise<HomeThreadPage> {
  const { coin, span, bounds, actors, cursor } = input;
  const key = coin.presaleId ?? coin.coinType;
  const kinds = visibleKinds(input.hiddenKinds);
  const request: RowsRequest = { span, bounds, kinds, sales: { kind: "ids", presaleIds: [key], includeStandalone: coin.presaleId === null }, actors };
  let after: Readonly<{ latestMs: number; who: string }> | null = null;
  if (cursor !== null) {
    const who = await whoOfKey(db, cursor.key);
    if (who === null) throw invalidCursor();
    after = { latestMs: cursor.latestMs, who };
  }
  const [sides, grouped] = await Promise.all([readSides(db, request), readParticipantPage(db, request, after)]);
  const page = grouped.slice(0, HOME_THREAD_PAGE);
  const [people, events] = await Promise.all([
    readPeople(db, page.flatMap((row) => (row.account_id === null ? [] : [row.account_id]))),
    readEvents(db, request, page.map((row) => row.who)),
  ]);
  const sidesOf = new Map<string, SideRow[]>();
  for (const row of sides) sidesOf.set(row.who, [...(sidesOf.get(row.who) ?? []), row]);
  const participants: HomeParticipant[] = page.map((row) => {
    const participant = participantOf({ grouped: row, sides: sidesOf.get(row.who) ?? [], ...people });
    const rows = events.get(row.who) ?? [];
    const kept = rows.slice(0, HOME_PARTICIPANT_EVENTS).flatMap((event) => eventOf(event) ?? []);
    return {
      ...participant,
      events: kept,
      events_more: rows.length > HOME_PARTICIPANT_EVENTS || participant.events_total > kept.length,
      ...(actors.kind === "followed" && participant.actor.type === "account" ? { relation: "followed" as const } : {}),
    };
  });
  const last = page.at(-1);
  const lastParticipant = participants.at(-1);
  const counts = countsOf(sides).get(key);
  const totals = activityOf({ scope: actors.kind === "followed" ? "followed" : "pool", window: span.window, fromMs: span.fromMs, toMs: span.toMs, counts, sides, preview: [] });
  const { preview: _preview, ...rest } = totals;
  void _preview;
  return {
    presale_id: coin.presaleId,
    coin_type: coin.coinType,
    participants,
    totals: rest,
    next_cursor: grouped.length > HOME_THREAD_PAGE && last && lastParticipant ? encodeThreadCursor({ latestMs: Number(last.latest_ms), key: lastParticipant.key }) : null,
    window: span.window,
    clock_ms: bounds.clockMs,
    as_of: input.asOf,
  };
}
