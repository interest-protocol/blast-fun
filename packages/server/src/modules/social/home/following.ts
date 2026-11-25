import { z } from "zod";
import { socialAddressSchema, socialCountSchema } from "@blast/core/modules/social/contracts/primitives.ts";
import { socialInput } from "@blast/server/modules/social/route-kit/validation.ts";
import { assertChainReadThroughViews } from "@blast/core/modules/database/modules.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { coinLabel } from "@blast/core/modules/social/contracts/financial-wire.ts";
import { toUsd } from "@blast/core/modules/social/items/decimal.ts";
import { SHOWN_PRESALES } from "@blast/core/modules/social/read-model/chain-presales.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

import {
  HOME_TAPE_LIMIT,
  HOME_COINS_MAX_IDS,
  HOME_PAGE_DEFAULT,
  HOME_PAGE_LAST,
  HOME_PAGE_MAX,
  HOME_PREVIEW_ROWS,
  homeWindowSchema,
  type HomeActivity,
  type HomeCoin,
  type HomeFollowingRequest,
  type HomeFollowingResponse,
  type HomeWindow,
} from "@blast/core/modules/social/contracts/home.ts";
import { readAsOf } from "@blast/server/modules/social/items/as-of.ts";
import { activityOf, actorOf, countsOf, previewOf, type WindowCountsRow } from "@blast/server/modules/social/home/aggregate.ts";
import { decodeCursor, encodeCursor, invalidCursor } from "@blast/server/modules/social/home/codec.ts";
import { assembleCoins, candidateOf, participantsBySale, readCoinFacts, readPeople, readSides, readTopParticipants, type Candidate, type FactsRow, type HomeReadContext } from "@blast/server/modules/social/home/coins.ts";
import { decodeThreadCursor, eventOf, readThreadIn, type EventRow } from "@blast/server/modules/social/home/thread.ts";
import { Params, ROW_ORDER, homeSpan, readHomeBounds, rowsWithSql, selectHome, visibleKinds, whySalesSql, type ActorScope, type HomeBounds, type HomeSpan } from "@blast/server/modules/social/home/sql.ts";

/**
 * The Following source (contract in `contracts/home.ts`), read on the
 * primary for the signed-in viewer (so a follow just written counts) and
 * never cached:
 *
 * - `coins`: every shown sale (any lifecycle) with a named confirmed event
 *   by an account the viewer follows in the window (`activity`), or with a
 *   why written by one in the window (`discussion`, labelled so and never
 *   counted as buying), ordered by the latest followed activity, then by
 *   coin type; the window's counts, totals and previews are the followed
 *   accounts' only. Nothing outside the viewer's follows is ever added.
 * - `preview`: the followed participation of the sales on screen (Discover
 *   and the Watchlist say "2 people you follow bought" on top of the
 *   public figures).
 * - `thread`: one sale's participants, followed accounts only.
 *
 * The naming rule still applies: a followed account that is private, or
 * that linked its wallet after the event, is not named and so not shown.
 */

const FOLLOW_COUNT_SQL = `SELECT count(*)::int AS following FROM social_follows f
  WHERE f.follower_account_id = $1::uuid AND f.target_kind = 'account'`;

/** $1 viewer, $2 from (ms), $3 to (ms): the sales with an active why by a followed account written in the window, with the count. */
const DISCUSSED_SQL = `SELECT x.sale, count(*)::int AS posts, max(extract(epoch FROM x.created_at) * 1000)::bigint::text AS latest_ms
  FROM (${whySalesSql(`w.author_account_id IN (SELECT f.target_id::uuid FROM social_follows f WHERE f.follower_account_id = $1::uuid AND f.target_kind = 'account')
    AND w.created_at > to_timestamp($2::bigint / 1000.0) AND w.created_at <= to_timestamp($3::bigint / 1000.0)`)}) x
  WHERE x.sale IS NOT NULL GROUP BY x.sale`;

for (const text of [FOLLOW_COUNT_SQL, DISCUSSED_SQL]) assertChainReadThroughViews(text);

const CURSOR_TAG = "following";

type FollowingCursor = Readonly<{ latestMs: number; coinType: string }>;

const followingCursorSchema = z.tuple([z.literal(1), socialCountSchema, z.string().min(1).max(300)]).rest(z.unknown());

function decodeFollowingCursor(cursor: string): FollowingCursor {
  const parsed = followingCursorSchema.safeParse(decodeCursor(CURSOR_TAG, cursor));
  if (!parsed.success) throw invalidCursor();
  return { latestMs: parsed.data[1], coinType: parsed.data[2] };
}

const followingCursorFieldSchema = z.string().min(1).nullish().transform((value) => value ?? null);
export const homeFollowingRequestSchema = z.union([
  z.strictObject({
    mode: z.literal("coins"), window: homeWindowSchema,
    cursor: followingCursorFieldSchema,
    limit: socialCountSchema.min(1).max(HOME_PAGE_MAX).default(HOME_PAGE_DEFAULT),
    page: socialCountSchema.min(1).max(HOME_PAGE_LAST).default(1),
  }).refine((value) => value.cursor === null || value.page === 1),
  z.strictObject({
    mode: z.literal("preview"), window: homeWindowSchema,
    presale_ids: z.array(socialAddressSchema).min(1).max(HOME_COINS_MAX_IDS)
      .transform((ids) => [...new Set(ids)]),
  }),
  z.strictObject({
    mode: z.literal("thread"), window: homeWindowSchema,
    presale_id: socialAddressSchema, cursor: followingCursorFieldSchema,
  }),
  z.strictObject({ mode: z.literal("tape"), window: homeWindowSchema }),
]);

/** The closed request body, or `invalid_request`. */
export function parseFollowingRequest(body: unknown): HomeFollowingRequest {
  return socialInput(homeFollowingRequestSchema, body);
}

type Setup = Readonly<{ bounds: HomeBounds; span: HomeSpan; asOf: NonNullable<Awaited<ReturnType<typeof readAsOf>>>; kinds: readonly string[]; actors: ActorScope }>;

async function setup(db: ReadableDatabase, viewerAccountId: string, window: HomeWindow, context: HomeReadContext): Promise<Setup> {
  const [bounds, asOf] = await Promise.all([readHomeBounds(db, context.nowMs), readAsOf(db)]);
  if (!asOf) throw new SocialRouteError("service_unavailable");
  return { bounds, span: homeSpan(window, bounds), asOf, kinds: visibleKinds(context.hiddenKinds), actors: { kind: "followed", viewerAccountId } };
}

type Qualified = Candidate & Readonly<{ qualified: "activity" | "discussion"; orderMs: number; posts: number }>;

/** The latest followed event or post first, then by coin type: the Following source's one order. */
function byFollowedRecency(a: Qualified, b: Qualified): number {
  return b.orderMs - a.orderMs || (a.coinType < b.coinType ? -1 : a.coinType > b.coinType ? 1 : 0);
}

/** The sales a followed account touched (activity) or wrote about (discussion), each as a candidate. */
function qualifiedOf(
  facts: ReadonlyMap<string, FactsRow>,
  counts: ReadonlyMap<string, WindowCountsRow>,
  discussed: ReadonlyMap<string, Readonly<{ posts: number; latest_ms: string }>>,
  span: HomeSpan,
): Qualified[] {
  const ids = [...new Set([...counts.keys(), ...discussed.keys()])];
  return ids.flatMap((id) => {
    const row = facts.get(id);
    if (!row) return [];
    const candidate = candidateOf(row, counts.get(id), span);
    const post = discussed.get(id);
    const active = candidate.counts !== undefined && Number(candidate.counts.events) > 0;
    const orderMs = Math.max(candidate.latestMs ?? 0, post ? Number(post.latest_ms) : 0);
    return [{ ...candidate, qualified: active ? "activity" : "discussion", orderMs, posts: post?.posts ?? 0 }];
  });
}

/** The Following source's coins: every sale a followed account touched in the window, by the latest followed event. */
async function readFollowingCoins(
  db: ReadableDatabase,
  viewerAccountId: string,
  request: Extract<HomeFollowingRequest, { mode: "coins" }>,
  context: HomeReadContext,
): Promise<HomeFollowingResponse> {
  const cursor = request.cursor === null || request.cursor === undefined ? null : decodeFollowingCursor(request.cursor);
  const limit = request.limit ?? HOME_PAGE_DEFAULT;
  const { bounds, span, asOf, kinds, actors } = await setup(db, viewerAccountId, request.window, context);
  const [following, sides, discussed] = await Promise.all([
    db.read<{ following: number }>(FOLLOW_COUNT_SQL, [viewerAccountId]),
    readSides(db, { span, bounds, kinds, sales: { kind: "all" }, actors }),
    db.read<{ sale: string; posts: number; latest_ms: string }>(DISCUSSED_SQL, [viewerAccountId, span.fromMs, span.toMs]),
  ]);
  const counts = countsOf(sides);
  const discussedOf = new Map(discussed.rows.map((row) => [row.sale, row]));
  const facts = await readCoinFacts(db, { kind: "ids", presaleIds: [...new Set([...counts.keys(), ...discussedOf.keys()])] }, span, context);
  const ordered = qualifiedOf(facts, counts, discussedOf, span).sort(byFollowedRecency);
  const after = cursor === null ? ordered : ordered.filter((candidate) => byFollowedRecency(candidate, { ...candidate, orderMs: cursor.latestMs, coinType: cursor.coinType }) > 0);
  const pageNumber = cursor === null ? request.page ?? 1 : 1;
  const start = (pageNumber - 1) * limit;
  const page = after.slice(start, start + limit);
  const assembled = await assembleCoins(db, { candidates: page, sides, span, bounds, kinds, actors, scope: "followed", context });
  const coins: HomeCoin[] = assembled.map((coin, index) => ({ ...coin, qualified: page[index]!.qualified, discussion: { posts: page[index]!.posts } }));
  const last = page.at(-1);
  return {
    mode: "coins",
    following: following.rows[0]?.following ?? 0,
    coins,
    page: pageNumber,
    pages: Math.max(1, Math.ceil(ordered.length / limit)),
    total: ordered.length,
    next_cursor: after.length > start + limit && last ? encodeCursor(CURSOR_TAG, [1, last.orderMs, last.coinType]) : null,
    window: request.window,
    clock_ms: bounds.clockMs,
    as_of: asOf,
  };
}

/** The followed participation of the sales asked for, keyed by sale (every id asked answers, empty when none). */
async function readFollowingPreview(
  db: ReadableDatabase,
  viewerAccountId: string,
  request: Extract<HomeFollowingRequest, { mode: "preview" }>,
  context: HomeReadContext,
): Promise<HomeFollowingResponse> {
  const { bounds, span, asOf, kinds, actors } = await setup(db, viewerAccountId, request.window, context);
  const rows = { span, bounds, kinds, sales: { kind: "ids" as const, presaleIds: request.presale_ids }, actors };
  const [sides, grouped] = await Promise.all([readSides(db, rows), readTopParticipants(db, rows, HOME_PREVIEW_ROWS * 2)]);
  const people = await readPeople(db, grouped.flatMap((row) => (row.account_id === null ? [] : [row.account_id])));
  const counts = countsOf(sides);
  const perSale = participantsBySale(grouped, sides, people);
  const previews: Record<string, HomeActivity> = {};
  for (const id of request.presale_ids) {
    const preview = previewOf(perSale.get(id) ?? []).map((participant) => (participant.actor.type === "account" ? { ...participant, relation: "followed" as const } : participant));
    previews[id] = activityOf({ scope: "followed", window: span.window, fromMs: span.fromMs, toMs: span.toMs, counts: counts.get(id), sides: sides.filter((row) => row.sale === id), preview });
  }
  return { mode: "preview", window: request.window, clock_ms: bounds.clockMs, previews, as_of: asOf };
}

type TapeRow = EventRow & Readonly<{ market_cap_usd: string | null; account_id: string | null; actor: string; presale_id: string; sale_token: string; sale_symbol: string; sale_name: string; sale_icon_url: string | null; lifecycle: string; verified_team: boolean }>;

/**
 * The tape: the newest `HOME_TAPE_LIMIT` events by the people the viewer
 * follows, across every shown coin, in the window (one statement over the
 * followed rows, newest first), each with who did it and on which coin.
 */
async function readFollowingTape(
  db: ReadableDatabase,
  viewerAccountId: string,
  request: Extract<HomeFollowingRequest, { mode: "tape" }>,
  context: HomeReadContext,
): Promise<Extract<HomeFollowingResponse, { mode: "tape" }>> {
  const { bounds, span, asOf, kinds, actors } = await setup(db, viewerAccountId, request.window, context);
  const params = new Params();
  const limit = params.add(HOME_TAPE_LIMIT);
  const text = selectHome(rowsWithSql({ span, bounds, kinds, sales: { kind: "all" }, actors }, params), `SELECT w.who, w.account_id::text AS account_id, w.actor, w.activity_id, w.kind, w.timestamp_ms::text AS timestamp_ms, w.digest,
    w.quote_type, w.sale_quote, w.sale_quote_symbol, w.sale_quote_decimals,
    w.quote_amount::text AS quote_amount, w.coin_amount::text AS coin_amount, w.quote_refund::text AS quote_refund, w.usd_value::text AS usd_value,
    w.market_cap_usd::text AS market_cap_usd,
    EXISTS (SELECT 1 FROM social_whys wy WHERE wy.entry_id = 'a:' || w.activity_id AND wy.state = 'active') AS has_why,
    w.sale AS presale_id, p.sale_token, p.sale_symbol, p.sale_name, p.sale_icon_url, p.lifecycle,
    coalesce(trust.verified_team, false) AS verified_team
  FROM home_who w JOIN ${SHOWN_PRESALES} p ON p.presale_id = w.sale
  LEFT JOIN social_sale_trust trust ON trust.presale_id = w.sale
  WHERE w.account_id IS NOT NULL
  ORDER BY ${ROW_ORDER("w")}
  LIMIT ${limit}::int`);
  assertChainReadThroughViews(text);
  const { rows } = await db.read<TapeRow>(text, params.values);
  const people = await readPeople(db, rows.flatMap((row) => (row.account_id === null ? [] : [row.account_id])));
  const events = rows.flatMap((row) => {
    const event = eventOf(row);
    const actor = actorOf({ account_id: row.account_id, wallet: row.actor }, people.identities);
    if (!event || actor.type !== "account") return [];
    return [{ ...event, actor, coin: { presale_id: row.presale_id, ...coinLabel({ coinType: row.sale_token, symbol: row.sale_symbol, name: row.sale_name }), icon_url: row.sale_icon_url || null, ...(row.verified_team ? { verified_team: true } : {}), lifecycle: row.lifecycle }, market_cap_usd: row.market_cap_usd === null ? null : toUsd(row.market_cap_usd) }];
  });
  return { mode: "tape", window: request.window, clock_ms: bounds.clockMs, events, as_of: asOf };
}

/** The whole Following route body, by mode. */
export async function readHomeFollowing(
  db: ReadableDatabase,
  viewerAccountId: string,
  request: HomeFollowingRequest,
  context: HomeReadContext,
): Promise<HomeFollowingResponse> {
  switch (request.mode) {
    case "coins":
      return readFollowingCoins(db, viewerAccountId, request, context);
    case "preview":
      return readFollowingPreview(db, viewerAccountId, request, context);
    case "tape":
      return readFollowingTape(db, viewerAccountId, request, context);
    case "thread": {
      const { bounds, span, asOf, actors } = await setup(db, viewerAccountId, request.window, context);
      const cursor = request.cursor === null || request.cursor === undefined ? null : decodeThreadCursor(request.cursor);
      const { coin_type: _coinType, ...thread } = await readThreadIn(db, { coin: { presaleId: request.presale_id, coinType: null }, window: request.window, cursor, hiddenKinds: context.hiddenKinds, actors, span, bounds, asOf });
      void _coinType;
      return { mode: "thread", ...thread, presale_id: request.presale_id };
    }
  }
}

export { Params };
