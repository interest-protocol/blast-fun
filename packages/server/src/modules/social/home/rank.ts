import { socialParameter, socialSingle } from "@blast/server/modules/social/route-kit/validation.ts";
import { z } from "zod";
import { socialCountSchema } from "@blast/core/modules/social/contracts/primitives.ts";

import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

import {
  HOME_AGE_MS,
  HOME_ALMOST_GRADUATED_BPS,
  HOME_DEFAULT_QUERY,
  HOME_PAGE_LAST,
  HOME_PAGE_MAX,
  HOME_MIN_PARTICIPANTS_MAX,
  HOME_WINDOW_MS,
  isHomeAge,
  isHomeSort,
  isHomeStage,
  isHomeWindow,
  type HomeActivity,
  type HomeQuery,
  type HomeSort,
  type HomeWindow,
} from "@blast/core/modules/social/contracts/home.ts";
import { decodeCursor, encodeCursor, invalidCursor } from "@blast/server/modules/social/home/codec.ts";

/**
 * Discover's ranking: deterministic, rule-based, and every input a number
 * the page itself shows. No learned weights, no confidence, no hidden
 * cohort.
 *
 * **Candidate universe.** Shown migrated presales, standalone launch vault
 * coins, live bonding curves, and the tracked pool catalog
 * (`HOME_LIST_COIN_SOURCES`), less the
 * Blast dust (`HOME_DUST_USD`): a Blast coin whose raise (a presale's, or a
 * curve's graduation target) or market cap is under $1,000. Catalog coins
 * are never dust.
 *
 * **Inputs**, all over the chosen window:
 * - `breadth`: distinct participants (accounts and unlinked wallets, each
 *   once). One actor is one, whatever it did: a whale is never breadth.
 * - `volume`: the Volume column's priced dollars (DEX pools included when
 *   the read asks for them; net inflow never includes DEX pools, so a coin
 *   with only DEX trades scores on volume, freshness and holders).
 * - net inflow: priced dollars bought and committed, less dollars sold, 0
 *   when negative. Claims are not money in. Buying and selling in a loop adds
 *   volume but no net inflow.
 * - new holders: blast-infra's holder count now, less its last count at or
 *   before the window's start, 0 when negative. A coin launched inside the
 *   window starts from none; any other coin without both counts gains 0.
 * - freshness: how little of the window has passed since the latest event.
 * - `holders`: blast-infra's holder count now, or 0 without one.
 * - `activity`: confirmed events, capped at three per participant
 *   (`min(events, 3 × breadth)`); a Volume tie-break, not a Relevant input.
 * - `recency`: 2 when the latest event is within a tenth of the window
 *   (6 min of an hour, 2.4 h of a day), 1 within half of it, else 0; a
 *   Volume tie-break.
 *
 * **Relevant score** (shown as Trending), out of 100 (stored ×100 as an integer):
 * `30 × breadth + 20 × net inflow + 15 × volume + 15 × new holders
 * + 15 × freshness + 5 × holders`, each input scaled 0–1 on a log curve
 * that stops at its cap (`RELEVANCE_CAPS`), so neither one wallet's churn
 * nor one large order can lead. Breadth weighs most: many people beat big
 * money. Money that stays and people who stay come next, so churn ranks
 * below real buying. Freshness falls from 1 for a trade this
 * minute to 0 at the window's start, on a clock that ticks once a minute. Missing data is 0.
 * Selling counts as participation and volume; only net inflow treats it as
 * money out.
 *
 * **Idle coins.** A coin with no participants and no dollars in the window
 * ranks after every active one, by market value: FDV (a coin without one
 * last), then holders. A dead $3 coin never sits above a $200K coin.
 *
 * **Ties** break by the latest event (newest first), then by coin type
 * (bytewise), so two reads of the same data give one order.
 *
 * **Other sorts.** `trending`: the Volume column's priced dollars in the window, then breadth, then activity, then recency,
 * then (for idle coins, which tie on all of those) FDV and holders, same
 * ties. `newest`: launch time (newest first), then coin type.
 * `progress`: curves still filling by progress (basis points, highest
 * first), every other coin after them by market cap. `market_cap`: market
 * cap, highest first, a coin without one last. `last_trade`: the window's
 * newest buy or sell first, coins without one after by launch time. Each
 * breaks ties by coin type.
 *
 * **Stages.** `almost` keeps curves still filling at 60% or more
 * (`HOME_ALMOST_GRADUATED_BPS`); `graduated` keeps coins that trade on a
 * DEX (no sale and no curve still filling); `all` keeps everything.
 *
 * **Why shown vs why ranked.** Every coin carries `rank.why`: the inputs in
 * words ("4 participants · 8 trades in the last 24h"; a standalone vault coin
 * adds "in its pool", the only place its trades are counted); a coin with
 * nothing in the window says so.
 */

/**
 * A sale counts trades on every venue and route. A standalone vault counts
 * trades in its registered pool. A catalog coin reports available indexed
 * events with partial coverage.
 */
export type TradeCoverage = "every_venue" | "own_pool" | "indexed";

export type RankInputs = Readonly<{ breadth: number; activity: number; recency: number; /** The window's priced dollars (Trending's first key). */ volume: number }>;

/** The window's priced dollars across every direction, as a number for ordering (the row's figure is `volumeText`). */
export function volumeOf(activity: Pick<HomeActivity, "bought" | "sold" | "committed">): number {
  return [...activity.bought, ...activity.sold, ...activity.committed].reduce((sum, amount) => sum + (amount.usd === null ? 0 : Number(amount.usd)), 0);
}

/** How much of the window had passed since the latest event, as the recency step. */
export function recencyOf(latestMs: number | null, window: HomeWindow, toMs: number): number {
  if (latestMs === null) return 0;
  const age = toMs - latestMs;
  const span = HOME_WINDOW_MS[window];
  if (age <= span / 10) return 2;
  if (age <= span / 2) return 1;
  return 0;
}

/** The rank's inputs of a window (`volume` from the counts row's sum, or the activity's totals). */
export function rankInputs(activity: Pick<HomeActivity, "participants" | "events" | "latest_ms" | "window" | "to_ms"> & Readonly<{ volume_usd?: string | number | null }>): RankInputs {
  const breadth = Math.max(0, activity.participants);
  return {
    breadth,
    activity: Math.min(Math.max(0, activity.events), 3 * breadth),
    recency: recencyOf(activity.latest_ms, activity.window, activity.to_ms),
    volume: Math.max(0, Number(activity.volume_usd ?? 0)) || 0,
  };
}

/** A Blast coin whose raise (a presale's, or a curve's graduation target) or market cap is under this, in USD, stays off Home. */
export const HOME_DUST_USD = 1_000;

/** Relevant's weights, out of 100: who joined counts most, then money that stayed, then dollars, new holders and how recent, then how widely held. */
export const RELEVANCE_WEIGHTS = { breadth: 30, netInflow: 20, volume: 15, newHolders: 15, freshness: 15, holders: 5 } as const;
/** Where each input stops adding: past these, more of the same no longer lifts a coin. */
export const RELEVANCE_CAPS = {
  breadth: { "1h": 10, "24h": 50 },
  netInflow: { "1h": 1_000, "24h": 10_000 },
  volume: { "1h": 2_000, "24h": 20_000 },
  newHolders: { "1h": 10, "24h": 50 },
  holders: 1_000,
} as const satisfies Readonly<{ breadth: Record<HomeWindow, number>; netInflow: Record<HomeWindow, number>; volume: Record<HomeWindow, number>; newHolders: Record<HomeWindow, number>; holders: number }>;

const MINUTE_MS = 60_000;
const saturating = (value: number, cap: number) => Math.log1p(Math.min(cap, Math.max(0, value))) / Math.log1p(cap);

/** The Relevant score (see the ranking notes above), ×100 and rounded so cursors carry an integer. */
export function relevanceScore(
  candidate: Readonly<{ inputs: Pick<RankInputs, "breadth" | "volume">; latestMs: number | null; holders?: number | null; netInflow?: number | null; newHolders?: number | null }>,
  window: HomeWindow,
  toMs: number,
): number {
  const { inputs, latestMs, holders, netInflow, newHolders } = candidate;
  // The clock moves in whole minutes, the same step for every coin: scores hold still within a minute and never swap order on their own.
  // It rounds up, so a trade this minute is never later than the clock (the clamp only catches clock skew).
  const nowMs = Math.ceil(toMs / MINUTE_MS) * MINUTE_MS;
  const freshness = latestMs === null ? 0 : Math.min(1, Math.max(0, 1 - (nowMs - latestMs) / HOME_WINDOW_MS[window]));
  const score = RELEVANCE_WEIGHTS.breadth * saturating(inputs.breadth, RELEVANCE_CAPS.breadth[window])
    + RELEVANCE_WEIGHTS.netInflow * saturating(netInflow ?? 0, RELEVANCE_CAPS.netInflow[window])
    + RELEVANCE_WEIGHTS.volume * saturating(inputs.volume, RELEVANCE_CAPS.volume[window])
    + RELEVANCE_WEIGHTS.newHolders * saturating(newHolders ?? 0, RELEVANCE_CAPS.newHolders[window])
    + RELEVANCE_WEIGHTS.freshness * freshness
    + RELEVANCE_WEIGHTS.holders * saturating(holders ?? 0, RELEVANCE_CAPS.holders);
  return Math.round(score * 100);
}

/**
 * "4 participants · 8 trades in the last 24h", or the honest empty line. A
 * standalone vault coin's line ends "in its pool": its trades elsewhere are
 * not counted. Catalog coins describe the indexed events we have.
 */
export function whyShown(activity: Pick<HomeActivity, "participants" | "events" | "sellers" | "buyers" | "backers" | "claimers" | "window">, coverage: TradeCoverage): string {
  const window = activity.window === "1h" ? "last hour" : "last 24h";
  const where = coverage === "own_pool" ? " in its pool" : "";
  const indexed = coverage === "indexed" ? "indexed " : "";
  if (activity.participants === 0) return `No ${indexed}activity in the ${window}${where}`;
  const people = `${activity.participants.toLocaleString("en-US")} participant${activity.participants === 1 ? "" : "s"}`;
  const market = activity.buyers + activity.sellers + activity.claimers > 0;
  const noun = !market && activity.backers > 0 ? "commitment" : activity.backers + activity.claimers === 0 ? "trade" : "event";
  const trades = `${activity.events.toLocaleString("en-US")} ${indexed}${noun}${activity.events === 1 ? "" : "s"}`;
  const sold = activity.sellers > 0 ? ` · ${activity.sellers.toLocaleString("en-US")} sold` : "";
  return `${people} · ${trades}${sold} in the ${window}${where}`;
}

/** What the orders compare: every candidate carries these (`holders`: blast-infra's count now, `fdvUsd`: its FDV now; null without one). */
export type Rankable = Readonly<{
  coinType: string; score: number; inputs: RankInputs; latestMs: number | null; launchedMs: number | null; holders?: number | null; fdvUsd?: number | null;
  /** A curve still filling: its progress in basis points; null for any other coin, or while its target is unknown. */
  progressBps?: number | null;
  /** Market cap now in USD; null when unknown. */
  marketCapUsd?: number | null;
  /** The window's newest buy or sell; null without one. */
  lastTradeMs?: number | null;
}>;

const text = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const newestFirst = (a: number | null, b: number | null) => (b ?? -1) - (a ?? -1);
const mostFirst = (a: number | null | undefined, b: number | null | undefined) => (b ?? -1) - (a ?? -1);

/** No participants and no dollars in the window. */
export const isIdle = (candidate: Pick<Rankable, "inputs">) => candidate.inputs.breadth === 0 && candidate.inputs.volume === 0;

/** Market value: FDV first, then holders, a coin without either last. */
const byValue = (a: Rankable, b: Rankable) => mostFirst(a.fdvUsd, b.fdvUsd) || mostFirst(a.holders, b.holders);

/** The comparator of a sort: a total order over every candidate. */
export function homeOrder(sort: HomeSort): (a: Rankable, b: Rankable) => number {
  switch (sort) {
    case "relevant":
      // Active coins by score; idle ones after them by market value (a holder-only score would put dust above real coins).
      return (a, b) => Number(isIdle(a)) - Number(isIdle(b))
        || (isIdle(a) ? byValue(a, b) : b.score - a.score)
        || newestFirst(a.latestMs, b.latestMs) || newestFirst(a.launchedMs, b.launchedMs) || text(a.coinType, b.coinType);
    case "trending":
      // The most dollars moved in the window first (the owner's "trending means volume"); breadth breaks ties, so one wallet's churn ranks below many people's.
      return (a, b) =>
        b.inputs.volume - a.inputs.volume || b.inputs.breadth - a.inputs.breadth || b.inputs.activity - a.inputs.activity || b.inputs.recency - a.inputs.recency
        || byValue(a, b) || newestFirst(a.latestMs, b.latestMs) || text(a.coinType, b.coinType);
    case "newest":
      return (a, b) => newestFirst(a.launchedMs, b.launchedMs) || text(a.coinType, b.coinType);
    case "held":
      // The most holders first, a coin without a count last; the window's dollars, then the newest launch, break ties.
      return (a, b) => (b.holders ?? -1) - (a.holders ?? -1) || b.inputs.volume - a.inputs.volume
        || newestFirst(a.launchedMs, b.launchedMs) || text(a.coinType, b.coinType);
    case "progress":
      // A percent, never atoms: a SUI curve and a USDC curve compare fairly.
      return (a, b) => mostFirst(a.progressBps, b.progressBps) || mostFirst(a.marketCapUsd, b.marketCapUsd) || text(a.coinType, b.coinType);
    case "market_cap":
      return (a, b) => mostFirst(a.marketCapUsd, b.marketCapUsd) || text(a.coinType, b.coinType);
    case "last_trade":
      return (a, b) => newestFirst(a.lastTradeMs ?? null, b.lastTradeMs ?? null) || newestFirst(a.launchedMs, b.launchedMs) || text(a.coinType, b.coinType);
  }
}

/**
 * Whether a candidate has data on its sort's keys. Each order puts the
 * candidates without it last, so the ones with it are a prefix: Trending's
 * window dollars, breadth, activity or recency; New's launch time; Relevant's
 * activity, or for an idle coin its FDV or a holder; Most held's holder count;
 * progress, market cap and last trade their own value.
 */
export function hasSortData(sort: HomeSort, candidate: Rankable): boolean {
  switch (sort) {
    case "trending":
      return candidate.inputs.volume > 0 || candidate.inputs.breadth > 0 || candidate.inputs.activity > 0 || candidate.inputs.recency > 0;
    case "newest":
      return candidate.launchedMs !== null;
    case "relevant":
      return !isIdle(candidate) || candidate.fdvUsd != null || (candidate.holders ?? 0) > 0;
    case "held":
      return candidate.holders != null;
    case "progress":
      return candidate.progressBps != null;
    case "market_cap":
      return candidate.marketCapUsd != null;
    case "last_trade":
      return candidate.lastTradeMs != null;
  }
}

/** A keyset position in a sort's order: the last candidate of the previous page. */
export type HomeCursor = Readonly<{
  sort: HomeSort; coinType: string; score: number; breadth: number; activity: number; recency: number; volume: number; latestMs: number | null; launchedMs: number | null;
  holders?: number | null; fdvUsd?: number | null; progressBps?: number | null; marketCapUsd?: number | null; lastTradeMs?: number | null;
}>;

/**
 * Version 5 adds progress, market cap and the last trade (their orders);
 * version 4 added the FDV (idle coins' order); version 3 the holder count
 * (`held`). Older cursors read with the missing fields null.
 */
const VERSION = 5;
const VERSION_WITHOUT_PROGRESS = 4;
const VERSION_WITHOUT_FDV = 3;
const VERSION_WITHOUT_HOLDERS = 2;

export function encodeHomeCursor(position: HomeCursor): string {
  return encodeCursor("discover", [VERSION, position.sort, position.coinType, position.score, position.breadth, position.activity, position.recency, position.volume, position.latestMs, position.launchedMs, position.holders ?? null, position.fdvUsd ?? null,
    position.progressBps ?? null, position.marketCapUsd ?? null, position.lastTradeMs ?? null]);
}

/** The position a cursor names; `invalid_parameter` (`cursor`) for anything `encodeHomeCursor` did not produce, or for another sort. */
export function decodeHomeCursor(cursor: string, sort: HomeSort): HomeCursor {
  const common = [
    z.literal(sort), z.string().min(1).max(300),
    socialCountSchema, socialCountSchema, socialCountSchema, socialCountSchema,
    z.number().nonnegative(), socialCountSchema.nullable(), socialCountSchema.nullable(),
  ] as const;
  const decoded = decodeCursor("discover", cursor);
  const money = z.number().nonnegative().nullable();
  const current = z.tuple([z.literal(VERSION), ...common, socialCountSchema.nullable(), money,
    socialCountSchema.max(10_000).nullable(), money, socialCountSchema.nullable()]).safeParse(decoded);
  if (current.success) {
    const [, , coinType, score, breadth, activity, recency, volume, latestMs, launchedMs, holders, fdvUsd, progressBps, marketCapUsd, lastTradeMs] = current.data;
    return { sort, coinType, score, breadth, activity, recency, volume, latestMs, launchedMs, holders, fdvUsd, progressBps, marketCapUsd, lastTradeMs };
  }
  const withoutProgress = z.tuple([z.literal(VERSION_WITHOUT_PROGRESS), ...common, socialCountSchema.nullable(), money]).safeParse(decoded);
  if (withoutProgress.success) {
    const [, , coinType, score, breadth, activity, recency, volume, latestMs, launchedMs, holders, fdvUsd] = withoutProgress.data;
    return { sort, coinType, score, breadth, activity, recency, volume, latestMs, launchedMs, holders, fdvUsd };
  }
  const withoutFdv = z.tuple([z.literal(VERSION_WITHOUT_FDV), ...common, socialCountSchema.nullable()]).safeParse(decoded);
  if (withoutFdv.success) {
    const [, , coinType, score, breadth, activity, recency, volume, latestMs, launchedMs, holders] = withoutFdv.data;
    return { sort, coinType, score, breadth, activity, recency, volume, latestMs, launchedMs, holders, fdvUsd: null };
  }
  const older = sort === "held" ? null : z.tuple([z.literal(VERSION_WITHOUT_HOLDERS), ...common]).safeParse(decoded);
  if (!older?.success) throw invalidCursor();
  const [, , coinType, score, breadth, activity, recency, volume, latestMs, launchedMs] = older.data;
  return { sort, coinType, score, breadth, activity, recency, volume, latestMs, launchedMs, holders: null, fdvUsd: null };
}

/** The cursor's candidate, as the order compares it. */
export function rankableOfCursor(cursor: HomeCursor): Rankable {
  return { coinType: cursor.coinType, score: cursor.score, inputs: { breadth: cursor.breadth, activity: cursor.activity, recency: cursor.recency, volume: cursor.volume }, latestMs: cursor.latestMs, launchedMs: cursor.launchedMs, holders: cursor.holders ?? null, fdvUsd: cursor.fdvUsd ?? null,
    progressBps: cursor.progressBps ?? null, marketCapUsd: cursor.marketCapUsd ?? null, lastTradeMs: cursor.lastTradeMs ?? null };
}

export function cursorOf(sort: HomeSort, last: Rankable): string {
  return encodeHomeCursor({ sort, coinType: last.coinType, score: last.score, breadth: last.inputs.breadth, activity: last.inputs.activity, recency: last.inputs.recency, volume: last.inputs.volume, latestMs: last.latestMs, launchedMs: last.launchedMs, holders: last.holders ?? null, fdvUsd: last.fdvUsd ?? null,
    progressBps: last.progressBps ?? null, marketCapUsd: last.marketCapUsd ?? null, lastTradeMs: last.lastTradeMs ?? null });
}

/**
 * One page of an ordered candidate list: every candidate strictly after the
 * cursor in the sort's order, the first `limit`, and the next cursor when the
 * list went on. Candidates that moved above the cursor since the previous
 * read are skipped (never shown twice); a client drops any repeat by id.
 * `ranked` counts the candidates with data on the sort's keys (`hasSortData`),
 * which lead the order.
 */
export function pageOf<Candidate extends Rankable>(
  candidates: readonly Candidate[],
  sort: HomeSort,
  cursor: HomeCursor | null,
  limit: number,
  pageNumber = 1,
): Readonly<{ page: readonly Candidate[]; nextCursor: string | null; pageNumber: number; pages: number; total: number; ranked: number }> {
  const order = homeOrder(sort);
  const ordered = [...candidates].sort(order);
  const after = cursor === null ? ordered : ordered.filter((candidate) => order(candidate, rankableOfCursor(cursor)) > 0);
  const start = cursor === null ? (pageNumber - 1) * limit : 0;
  const page = after.slice(start, start + limit);
  const last = page.at(-1);
  return {
    page,
    nextCursor: after.length > start + limit && last ? cursorOf(sort, last) : null,
    pageNumber: cursor === null ? pageNumber : 1,
    pages: Math.max(1, Math.ceil(ordered.length / limit)),
    total: ordered.length,
    ranked: ordered.filter((candidate) => hasSortData(sort, candidate)).length,
  };
}

/**
 * Whether a candidate passes the query's filters and stage. Unknown is never
 * a pass: a coin with no launch time fails an age filter, a curve with no
 * known progress is not almost graduated.
 */
export function passesFilters(
  query: Pick<HomeQuery, "minParticipants" | "age" | "tradable" | "stage">,
  candidate: Readonly<{ participants: number; launchedMs: number | null; tradable: boolean; listed: boolean; progressBps: number | null; nowMs: number }>,
): boolean {
  // Only a curve still filling has a progress; one with an unknown target is never "almost".
  if (query.stage === "almost" && (candidate.progressBps ?? -1) < HOME_ALMOST_GRADUATED_BPS) return false;
  if (query.stage === "graduated" && !candidate.listed) return false;
  if (candidate.participants < query.minParticipants) return false;
  if (query.tradable && !candidate.tradable) return false;
  const span = HOME_AGE_MS[query.age];
  if (span !== null && (candidate.launchedMs === null || candidate.nowMs - candidate.launchedMs > span)) return false;
  return true;
}

const invalid = (parameter: string) => new SocialRouteError("invalid_parameter", { extra: { parameter } });

function single(params: URLSearchParams, name: string): string | null {
  return socialSingle(params, name);
}

/** `min_participants`: absent is 0; else an integer from 0 to `HOME_MIN_PARTICIPANTS_MAX`. */
function parseMinParticipants(raw: string | null): number {
  return socialParameter(z.string().regex(/^(0|[1-9][0-9]{0,4})$/).transform(Number).pipe(z.number().max(HOME_MIN_PARTICIPANTS_MAX)).nullable().transform((value) => value ?? 0), raw, "min_participants");
}

/** `limit`: absent is the default; else an integer from 1 to `HOME_PAGE_MAX`. */
function parseLimit(raw: string | null): number {
  return socialParameter(z.string().regex(/^[1-9][0-9]?$/).transform(Number).pipe(z.number().max(HOME_PAGE_MAX)).nullable().transform((value) => value ?? HOME_DEFAULT_QUERY.limit), raw, "limit");
}

/** `page`: absent is 1; else an integer from 1 to `HOME_PAGE_LAST`. */
function parsePage(raw: string | null): number {
  return socialParameter(z.string().regex(/^[1-9][0-9]{0,3}$/).transform(Number).pipe(z.number().max(HOME_PAGE_LAST)).nullable().transform((value) => value ?? 1), raw, "page");
}

/** `tradable`: absent is false; `1` true; `0` false; anything else refused. */
/** `1` or `0`, absent meaning `0`. */
function parseFlag(raw: string | null, parameter: "tradable" | "ranked"): boolean {
  socialParameter(z.enum(["1", "0"]).nullable(), raw, parameter);
  return raw === "1";
}

/** One of `allowed`, or the default when absent; anything else refused. */
function parseChoice<Value extends string>(raw: string | null, fallback: Value, allowed: (value: unknown) => value is Value, parameter: string): Value {
  if (raw === null) return fallback;
  if (!allowed(raw)) throw invalid(parameter);
  return raw;
}

/**
 * The Discover query (contract in `contracts/home.ts`): each parameter at
 * most once, absent means its default, anything else `invalid_parameter`
 * naming it. Numeric ranges are validated as integers in their bounds; a
 * malformed range is refused, never clamped.
 */
export function parseHomeQuery(params: URLSearchParams): HomeQuery {
  const cursor = single(params, "cursor");
  if (cursor !== null && cursor.length === 0) throw invalid("cursor");
  const page = parsePage(single(params, "page"));
  if (cursor !== null && page > 1) throw invalid("page");
  const window = parseChoice(single(params, "window"), HOME_DEFAULT_QUERY.window, isHomeWindow, "window");
  const sort = parseChoice(single(params, "sort"), HOME_DEFAULT_QUERY.sort, isHomeSort, "sort");
  return {
    window,
    sort,
    stage: parseChoice(single(params, "stage"), HOME_DEFAULT_QUERY.stage, isHomeStage, "stage"),
    minParticipants: parseMinParticipants(single(params, "min_participants")),
    age: parseChoice(single(params, "age"), HOME_DEFAULT_QUERY.age, isHomeAge, "age"),
    tradable: parseFlag(single(params, "tradable"), "tradable"),
    limit: parseLimit(single(params, "limit")),
    page,
    cursor,
    ...(parseFlag(single(params, "ranked"), "ranked") ? { ranked: true } : {}),
  };
}
