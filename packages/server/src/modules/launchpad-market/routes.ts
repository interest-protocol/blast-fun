import { z } from "zod";
import { publicJson } from "@blast/core/lib/http-errors.ts";
import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import type { LaunchpadMarketRateBucket, RateBucket, RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import { classifiedActivityPath } from "@blast/core/modules/launchpad-contract/activity.ts";
import { CursorError } from "@blast/core/modules/launchpad-contract/cursor.ts";
import { coinCandlesPath, poolCandlesPath, poolTradesPath, CANDLE_INTERVALS, type CandleInterval, type CandleRequest } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { UNAVAILABLE_RETRY_AFTER_SECONDS } from "@blast/core/modules/database/availability.ts";
import { PRIVATE_NO_STORE } from "@blast/server/modules/read-routing/cache-policy.ts";
import { readBoundedText } from "@blast/server/lib/web-security/request-body.ts";
import {
  LAUNCHPAD_POLICY_PATH,
  creatorClaimsPath,
  launchRewardsPath,
  partnerLaunchesPath,
  partnerPath,
  partnersPath,
  rewardRoundsPath,
  walletHolderRewardsPath,
  walletLaunchesPath,
  walletLaunchRewardsPath,
} from "@blast/core/modules/launchpad-contract/rewards.ts";
import { COIN_TYPE, SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";
import { isVenue, type Venue } from "@blast/core/modules/launchpad-contract/venues.ts";

/**
 * The launchpad's market reads, same-origin (WP2). The browser never talks
 * to blast-infra: every `/v1` request needs a server-only key. Each route
 * here relays exactly one `/v1` read a launchpad page makes — the coin page's
 * Holders, chart, Activity, fees and reward rounds; a wallet's launches,
 * launch fees and holder rewards; a recipient's pending creator claims; the
 * partner reads; the launchpad's policy — and nothing else:
 *
 * | route (under `/api/launchpad/market`)        | blast-infra                                | bucket                      |
 * | --------------------------------------------- | ------------------------------------------ | --------------------------- |
 * | `GET /coins/{coin_type}`                      | `/v1/coins/{coin_type}`                    | `launchpad_market_coin`     |
 * | `GET /coins/{coin_type}/candles`              | `/v1/coins/{coin_type}/candles`            | `launchpad_market_candles`  |
 * | `GET /coins/{coin_type}/holders`              | `/v1/coins/{coin_type}/holders`            | `launchpad_market_holders`  |
 * | `GET /launches/{launch_id}/activity`          | `/v1/launches/{launch_id}/activity`        | `launchpad_market_activity` |
 * | `GET /pools/{blast_curve, cetus or bluefin}/{pool_id}` | `/v1/pools/{venue}/{pool_id}`     | `launchpad_market_pool`     |
 * | `GET /pools/{venue}/{pool_id}/candles`        | `/v1/pools/{venue}/{pool_id}/candles`      | `launchpad_market_candles`  |
 * | `GET /pools/{blast_curve, cetus or bluefin}/{pool_id}/trades` | `/v1/pools/{venue}/{pool_id}/trades`    | `launchpad_market_trades`   |
 * | `GET /status`                                 | `/v1/status`                               | `launchpad_market_status`   |
 * | `GET /launches/{launch_id}/rewards`           | `/v1/launches/{launch_id}/rewards`         | `launchpad_market_rewards`  |
 * | `GET /launches/{launch_id}/reward-rounds`     | `/v1/launches/{launch_id}/reward-rounds`   | `launchpad_market_reward_rounds` |
 * | `GET /wallets/{address}/launch-rewards`       | `/v1/wallets/{address}/launch-rewards`     | `launchpad_market_wallet_launch_rewards` |
 * | `GET /wallets/{address}/vault-rewards` | `/v1/wallets/{address}/vault-rewards` | `launchpad_market_wallet_holder_rewards` |
 * | `GET /wallets/{address}/launches`             | `/v1/wallets/{address}/launches`           | `launchpad_market_wallet_launches` |
 * | `GET /creator-claims?recipient=` or `?account=` | `/v1/creator-claims`                     | `launchpad_market_creator_claims` |
 * | `GET /partners`                               | `/v1/partners`                             | `launchpad_market_partners` |
 * | `GET /partners/{partner_id}`                  | `/v1/partners/{partner_id}`                | `launchpad_market_partner`  |
 * | `GET /partners/{partner_id}/launches`         | `/v1/partners/{partner_id}/launches`       | `launchpad_market_partner_launches` |
 * | `GET /launchpad/policy`                       | `/v1/launchpad/policy`                     | `launchpad_market_policy`   |
 *
 * A visible tab re-reads each destination every 15 s (`useMarketPoll`): one
 * holder page, Activity's pages and flow, and the fees; the chart takes trades
 * from its market stream (`chart-stream.ts`). Reads after the first viewer's
 * are CDN hits and reach no bucket.
 *
 * Each request, in order: the route's rate bucket per client IP (429 with
 * `Retry-After` when full; 503 when the limiter cannot count); strict
 * parameters (a canonical ID or coin type, only the query keys the page
 * sends, each at most once, through the same path builders the validated
 * client uses; otherwise 400 `invalid_parameter`); then one keyed read of
 * blast-infra (3 s). Its answer is relayed as it is, status and JSON body
 * (except `/status`, which keeps only its published fields: the engine's host
 * name `engine_id` and a committed reader's diagnostics are dropped),
 * so the browser's validated `/v1` client parses it unchanged (provenance,
 * deployment check, contract). Unconfigured is 503 `unconfigured`; an
 * unreachable or slow engine, a body that is not JSON, or a refusal of this
 * server's key is 502, never the key or the upstream's own words. A 200 is
 * public on the CDN briefly (`MARKET_CACHE_CONTROL`), a candle page wholly
 * before blast-infra's committed checkpoint longer
 * (`SETTLED_CANDLES_CACHE_CONTROL`), and a wallet's reads and a recipient's
 * creator claims never: they are a reader's own page. Everything else is `private, no-store`.
 *
 * A read a live hint caused names the hint's checkpoint (`at`, every route
 * but `/status`): every viewer of a coin asks the same URL for it, so the CDN
 * answers them from one read. `at` is only that key and never reaches
 * blast-infra. Its 200 is public only when its body's
 * `provenance.checkpoint` reaches `at`; an older answer is still relayed but
 * `private, no-store`, so no key promises more than its body holds.
 */
export const LAUNCHPAD_MARKET_PREFIX = "/api/launchpad/market";
export const MARKET_STATUS_UPSTREAM_PATH = "/v1/status";

/** `/status`'s published fields: blast-infra's `GET /v1/status` without `engine_id`. */
const STATUS_FIELDS = new Set(["checkpoint", "timestamp_ms", "lag_ms", "cursor", "provenance"]);

/** A public 200: the CDN serves it 5 s and revalidates in the background for 5 s more; browsers always revalidate. */
export const MARKET_CACHE_CONTROL = "public, max-age=0, s-maxage=5, stale-while-revalidate=5";
/** A candle page that ends before blast-infra's committed checkpoint: settled history, kept 5 minutes, served stale up to an hour. */
export const SETTLED_CANDLES_CACHE_CONTROL = "public, max-age=0, s-maxage=300, stale-while-revalidate=3600";

/** The most a relayed body may hold: a full candle page is well under it. */
export const MARKET_BODY_LIMIT_BYTES = 4 * 1_024 * 1_024;

export type MarketRouteName =
  | "coin"
  | "holders"
  | "activity"
  | "pool"
  | "candles"
  | "trades"
  | "status"
  | "rewards"
  | "reward_rounds"
  | "wallet_launch_rewards"
  | "wallet_holder_rewards"
  | "wallet_launches"
  | "creator_claims"
  | "partners"
  | "partner"
  | "partner_launches"
  | "policy";

export const MARKET_ROUTE_BUCKETS: Readonly<Record<MarketRouteName, LaunchpadMarketRateBucket>> = Object.freeze({
  coin: "launchpad_market_coin",
  holders: "launchpad_market_holders",
  activity: "launchpad_market_activity",
  pool: "launchpad_market_pool",
  candles: "launchpad_market_candles",
  trades: "launchpad_market_trades",
  status: "launchpad_market_status",
  rewards: "launchpad_market_rewards",
  reward_rounds: "launchpad_market_reward_rounds",
  wallet_launch_rewards: "launchpad_market_wallet_launch_rewards",
  wallet_holder_rewards: "launchpad_market_wallet_holder_rewards",
  wallet_launches: "launchpad_market_wallet_launches",
  creator_claims: "launchpad_market_creator_claims",
  partners: "launchpad_market_partners",
  partner: "launchpad_market_partner",
  partner_launches: "launchpad_market_partner_launches",
  policy: "launchpad_market_policy",
});

/** Where this server reads blast-infra: its origin and the fetch that carries its key (`blastInfraFetch`). */
export type MarketTextResponse = Readonly<{ status: number; text: string }>;
export type MarketUpstream = Readonly<{
  origin: string;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  /** Already bounded text, avoiding a synthetic Response stream on cache hits. */
  readText?: (input: RequestInfo | URL, init?: RequestInit) => Promise<MarketTextResponse>;
}>;

export type MarketRoutesDependencies = Readonly<{
  /** Null counts nothing (development without a rate-limit pepper only; see runtime.ts). */
  limiter: RateLimitPort | null;
  /** This server's blast-infra; throws when it is not configured. */
  upstream: () => MarketUpstream;
  timeoutMs?: number;
}>;

const PAGE_TOKEN = /^[A-Za-z0-9_-]{1,512}$/;
const LIMIT = /^[0-9]{1,4}$/;
const MILLIS = /^[0-9]{1,16}$/;
/** A checkpoint in canonical form: one spelling, one CDN key. */
const CHECKPOINT = /^(0|[1-9][0-9]{0,15})$/;
const SNAPSHOT_PAGE_MAX = 100;

class InvalidParameter extends Error {}

function json(status: number, body: unknown, cacheControl = PRIVATE_NO_STORE, extra: Record<string, string> = {}): Response {
  return publicJson(body, { status, headers: { "Cache-Control": cacheControl, ...extra } });
}

function refusal(status: number, code: string, message: string, extra: Record<string, string> = {}): Response {
  return json(status, { error: { code, message } }, PRIVATE_NO_STORE, extra);
}

export function invalidMarketParameters(): Response {
  return refusal(400, "invalid_parameter", "The market data parameters are invalid.");
}

export function marketParameterFailure(error: unknown): Response {
  if (error instanceof InvalidParameter || error instanceof CursorError) {
    return invalidMarketParameters();
  }
  return refusal(500, "INTERNAL_ERROR", "The market data request could not be completed.");
}

function upstreamFailure(status: number): Response {
  if (status === 404) return refusal(status, "not_found", "Market data was not found.");
  if (status === 429) return refusal(status, "rate_limited", "Too many market reads. Wait before retrying.");
  if (status >= 500) return refusal(status, "unavailable", "Market data is temporarily unavailable. Please retry.");
  return refusal(status, "invalid_parameter", "The market data request is invalid.");
}

/** The query, refused when it repeats a key or holds one `allowed` does not name. */
function query(params: URLSearchParams, allowed: readonly string[]): ReadonlyMap<string, string> {
  const keys = [...params.keys()];
  if (keys.length !== new Set(keys).size) throw new InvalidParameter("a query parameter is repeated");
  const allowedKeys = new Set(allowed);
  const unknown = keys.find((key) => !z.string().refine((value) => allowedKeys.has(value)).safeParse(key).success);
  if (unknown !== undefined) throw new InvalidParameter(`${unknown} is not a parameter of this route`);
  return new Map(params);
}

function number(value: string | undefined, pattern: RegExp, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!z.string().regex(pattern).safeParse(value).success) throw new InvalidParameter(`${name} must be a whole number`);
  return Number(value);
}

type Matched = Readonly<{
  route: MarketRouteName;
  /** The blast-infra path and query, or the refusal of its parameters. */
  path: () => string;
  /** The 200's `Cache-Control`, from its body. */
  cache: (body: unknown) => string;
}>;

const shortCache = () => MARKET_CACHE_CONTROL;
/** A wallet's reads are its reader's own page: never stored on the CDN. */
const privateCache = () => PRIVATE_NO_STORE;

/** A page request's `limit` and `cursor`, the only query keys a list page sends. */
function page(params: URLSearchParams): Readonly<{ limit: string | null; cursor: string | null }> {
  const q = query(params, ["limit", "cursor"]);
  return { limit: q.get("limit") ?? null, cursor: q.get("cursor") ?? null };
}

const WALLET_READS: Readonly<Record<string, Readonly<{ route: MarketRouteName; path: typeof walletLaunchesPath }>>> = Object.freeze({
  "launch-rewards": { route: "wallet_launch_rewards", path: walletLaunchRewardsPath },
  "vault-rewards": { route: "wallet_holder_rewards", path: walletHolderRewardsPath },
  "launch-holder-rewards": { route: "wallet_holder_rewards", path: walletHolderRewardsPath },
  launches: { route: "wallet_launches", path: walletLaunchesPath },
});

/** A launch's rewards reads and a wallet's reads: `[launches|wallets, id, read]`. */
function matchRewardsRead([first, id, read]: readonly string[], params: URLSearchParams): Matched | null {
  if (id === undefined || read === undefined) return null;
  if (first === "launches" && read === "rewards") {
    return { route: "rewards", path: () => (query(params, []), launchRewardsPath(id)), cache: shortCache };
  }
  if (first === "launches" && read === "reward-rounds") {
    return { route: "reward_rounds", path: () => rewardRoundsPath(id, page(params)), cache: shortCache };
  }
  if (first === "wallets" && Object.hasOwn(WALLET_READS, read)) {
    const wallet = WALLET_READS[read];
    return { route: wallet.route, path: () => wallet.path(id, page(params)), cache: privateCache };
  }
  return null;
}

/** The partner reads and the launchpad's policy. */
function matchPartnerRead([first, second, third]: readonly string[], params: URLSearchParams): Matched | null {
  if (first === "launchpad") {
    return second === "policy" && third === undefined
      ? { route: "policy", path: () => (query(params, []), LAUNCHPAD_POLICY_PATH), cache: shortCache }
      : null;
  }
  if (first !== "partners") return null;
  if (second === undefined) return { route: "partners", path: () => partnersPath(page(params)), cache: shortCache };
  if (third === undefined) return { route: "partner", path: () => (query(params, []), partnerPath(second)), cache: shortCache };
  return third === "launches"
    ? { route: "partner_launches", path: () => partnerLaunchesPath(second, page(params)), cache: shortCache }
    : null;
}

/**
 * A recipient's pending creator claims: exactly one of `recipient` (a wallet address) and
 * `account` (a Blast account's commitment, 64 lowercase hex digits), then the page's keys.
 */
export function marketCreatorClaimsPath(
  address: string | undefined,
  commitment: string | undefined,
  request: Parameters<typeof creatorClaimsPath>[1],
): string {
  if (address !== undefined && commitment === undefined) return creatorClaimsPath({ kind: "address", address }, request);
  if (address === undefined && commitment !== undefined) return creatorClaimsPath({ kind: "account", commitment }, request);
  throw new InvalidParameter("name exactly one of recipient and account");
}

function creatorClaimsRead(params: URLSearchParams): Matched {
  return {
    route: "creator_claims",
    path: () => {
      const q = query(params, ["recipient", "account", "limit", "cursor"]);
      return marketCreatorClaimsPath(q.get("recipient"), q.get("account"), { limit: q.get("limit"), cursor: q.get("cursor") });
    },
    cache: privateCache,
  };
}

/** The launchpad's rewards, wallet, creator-claims, partner and policy reads, or null for none of them. */
function matchLaunchpadRead(segments: readonly string[], params: URLSearchParams): Matched | null {
  if (segments.length > 3 || segments.includes("")) return null;
  if (segments[0] === "creator-claims") return segments.length === 1 ? creatorClaimsRead(params) : null;
  return matchRewardsRead(segments, params) ?? matchPartnerRead(segments, params);
}

/** The candle page's `Cache-Control`: settled when it ends (`to`) at or before blast-infra's committed checkpoint time. */
export function candleCache(to: number | undefined, at?: number): (body: unknown) => string {
  return (body) => {
    if (!reachedCheckpoint(body, at)) return PRIVATE_NO_STORE;
    const committed = (body as { provenance?: { timestamp_ms?: unknown } } | null)?.provenance?.timestamp_ms;
    return to !== undefined && typeof committed === "number" && committed >= to ? SETTLED_CANDLES_CACHE_CONTROL : MARKET_CACHE_CONTROL;
  };
}

/** The checkpoint an answer body reflects, or null when it names none. */
function answeredAt(body: unknown): number | null {
  const checkpoint = (body as { provenance?: { checkpoint?: unknown } } | null)?.provenance?.checkpoint;
  return typeof checkpoint === "number" ? checkpoint : null;
}

function reachedCheckpoint(body: unknown, at: number | undefined): boolean {
  return at === undefined || (answeredAt(body) ?? -1) >= at;
}

export function checkpointCache(at: number | undefined): (body: unknown) => string {
  return (body) => reachedCheckpoint(body, at) ? MARKET_CACHE_CONTROL : PRIVATE_NO_STORE;
}

/**
 * The route `segments` name, read for a hint when `params` holds `at`: the
 * route's own parameters without it, and its 200 public only when the body
 * reaches `at`.
 */
function match(segments: readonly string[], params: URLSearchParams): Matched | null {
  if (!params.has("at")) return route(segments, params);
  const own = new URLSearchParams(params);
  own.delete("at");
  const matched = route(segments, own);
  if (!matched) return null;
  let at = Number.POSITIVE_INFINITY;
  return {
    route: matched.route,
    path: () => {
      const values = params.getAll("at");
      const [value] = values;
      if (matched.route === "status") throw new InvalidParameter("at is not a parameter of this route");
      if (values.length !== 1 || !z.string().regex(CHECKPOINT).safeParse(value).success) throw new InvalidParameter("at must be a checkpoint");
      at = Number(value);
      return matched.path();
    },
    cache: (body) => (reachedCheckpoint(body, at) ? matched.cache(body) : PRIVATE_NO_STORE),
  };
}

export function marketCoinPath(coinType: string): string {
  if (!COIN_TYPE.test(coinType)) throw new InvalidParameter("coin_type must be a canonical coin type");
  return `/v1/coins/${coinType}`;
}

export function marketHoldersPath(coinType: string, limitValue: string | undefined, cursor: string | undefined): string {
  const path = marketCoinPath(coinType);
  const limit = number(limitValue, LIMIT, "limit") ?? 25;
  if (limit < 1 || limit > SNAPSHOT_PAGE_MAX) throw new InvalidParameter(`limit must be from 1 to ${SNAPSHOT_PAGE_MAX}`);
  const search = new URLSearchParams({ view: "snapshot", limit: String(limit) });
  if (cursor !== undefined) {
    if (!PAGE_TOKEN.test(cursor)) throw new InvalidParameter("cursor must be a page token");
    search.set("cursor", cursor);
  }
  return `${path}/holders?${search.toString()}`;
}

/** A coin's routes: its summary (the page's live market cap, volume and holder count) and its holder snapshot. */
function coinRoute(coinType: string, sub: string | undefined, params: URLSearchParams): Matched | null {
  if (sub === undefined) {
    return { route: "coin", path: () => (query(params, []), marketCoinPath(coinType)), cache: shortCache };
  }
  if (sub === "candles") return candleRoute(params, (request) => coinCandlesPath(coinType, request));
  if (sub !== "holders") return null;
  return {
    route: "holders",
    path: () => {
      const q = query(params, ["view", "limit", "cursor"]);
      if (q.get("view") !== "snapshot") throw new InvalidParameter("view must be snapshot");
      return marketHoldersPath(coinType, q.get("limit"), q.get("cursor"));
    },
    cache: shortCache,
  };
}

function candleRoute(params: URLSearchParams, path: (request: CandleRequest) => string): Matched {
  let to: number | undefined;
  return {
    route: "candles",
    path: () => {
      const q = query(params, ["interval", "from", "to", "limit"]);
      const interval = q.get("interval");
      if (!z.enum(CANDLE_INTERVALS).safeParse(interval).success) throw new InvalidParameter(`interval must be one of ${CANDLE_INTERVALS.join(", ")}`);
      to = number(q.get("to"), MILLIS, "to");
      return path({
        interval: interval as CandleInterval,
        from: number(q.get("from"), MILLIS, "from"),
        to,
        limit: number(q.get("limit"), LIMIT, "limit"),
      });
    },
    cache: (body) => candleCache(to)(body),
  };
}

export function marketPoolPath(venue: Venue, poolId: string): string {
  if (!SUI_OBJECT_ID_PATTERN.test(poolId)) throw new InvalidParameter("pool_id must be a canonical object id");
  return `/v1/pools/${venue}/${poolId}`;
}

/** A pool's routes: a launch's own pool summaries, a pool's candles, a pool's trades. */
function poolRoute(venue: string, poolId: string, sub: string | undefined, params: URLSearchParams): Matched | null {
  switch (sub) {
  case undefined:
    // The curve's summary (Activity's windowed flow, the page's live price) and its migrated venue pool's.
    if (!isVenue(venue)) return null;
    return {
      route: "pool",
      path: () => (query(params, []), marketPoolPath(venue, poolId)),
      cache: shortCache,
    };
  case "candles":
    return candleRoute(params, (request) => poolCandlesPath(`${venue}:${poolId}`, request));
  case "trades":
    // Live's trace reads a pool's raw executions, on the curve and on a venue.
    if (!isVenue(venue)) return null;
    return {
      route: "trades",
      path: () => {
        const q = query(params, ["before", "limit"]);
        return poolTradesPath(`${venue}:${poolId}`, { before: q.get("before"), limit: number(q.get("limit"), LIMIT, "limit") });
      },
      cache: shortCache,
    };
  default:
    return null;
  }
}

/** The route `segments` name under the prefix, or null for none. */
function route(segments: readonly string[], params: URLSearchParams): Matched | null {
  const launchpad = matchLaunchpadRead(segments, params);
  if (launchpad) return launchpad;
  const [first, second, third, fourth, ...rest] = segments;
  if (rest.length > 0 || (second === undefined && first !== "status")) return null;
  if (first === "status") {
    return segments.length === 1 ? { route: "status", path: () => (query(params, []), MARKET_STATUS_UPSTREAM_PATH), cache: shortCache } : null;
  }
  if (first === "coins") return fourth === undefined ? coinRoute(second, third, params) : null;
  if (first === "launches" && fourth === undefined && third === "activity") {
    return {
      route: "activity",
      path: () => {
        const q = query(params, ["view", "limit", "cursor", "wallet_labels"]);
        if (q.has("wallet_labels") && q.get("wallet_labels") !== "true") throw new InvalidParameter("wallet_labels must be true");
        if (q.get("view") !== "classified") throw new InvalidParameter("view must be classified");
        if (!z.string().regex(SUI_OBJECT_ID_PATTERN).safeParse(second).success) throw new InvalidParameter("launch_id must be a canonical object id");
        return classifiedActivityPath(second, { walletLabels: q.has("wallet_labels"), limit: q.get("limit") ?? null, cursor: q.get("cursor") ?? null });
      },
      cache: shortCache,
    };
  }
  return first === "pools" && third !== undefined ? poolRoute(second, third, fourth, params) : null;
}

function segmentsOf(pathname: string): string[] | null {
  if (!pathname.startsWith(`${LAUNCHPAD_MARKET_PREFIX}/`)) return null;
  try {
    return pathname.slice(LAUNCHPAD_MARKET_PREFIX.length + 1).split("/").map(decodeURIComponent);
  } catch {
    return null;
  }
}

function metric(route: MarketRouteName, outcome: string, fields: Record<string, string | number> = {}): void {
  recordMetric("launchpad.market_route", { route, outcome, ...fields });
}

export function createMarketRelay(dependencies: Pick<MarketRoutesDependencies, "upstream" | "timeoutMs">) {
  const timeoutMs = dependencies.timeoutMs ?? 3_000;

  return async function relay(route: MarketRouteName, path: string, cache: (body: unknown) => string): Promise<Response> {
    let upstream: MarketUpstream;
    try {
      upstream = dependencies.upstream();
    } catch {
      metric(route, "unconfigured");
      return refusal(503, "unconfigured", "Market data is not configured here.", { "Retry-After": String(UNAVAILABLE_RETRY_AFTER_SECONDS) });
    }
    let status: number;
    let text: string;
    try {
      const input = new URL(path, upstream.origin);
      const init: RequestInit = {
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      };
      if (upstream.readText) {
        ({ status, text } = await upstream.readText(input, init));
      } else {
        const response = await upstream.fetch(input, init);
        status = response.status;
        const bounded = await readBoundedText(response, MARKET_BODY_LIMIT_BYTES);
        if (bounded === null) throw new RangeError("Market body exceeds the read limit");
        text = bounded;
      }
    } catch {
      metric(route, "unreachable");
      return refusal(502, "unreachable", "Market data could not be read.");
    }
    if (status === 401 || status === 403) {
      // blast-infra refused this server's key: an operator's problem, never the reader's.
      metric(route, "upstream_refused", { status });
      return refusal(502, "unavailable", "Market data could not be read.");
    }
    let body: unknown;
    try {
      if (text.length > MARKET_BODY_LIMIT_BYTES) throw new RangeError("too large");
      body = JSON.parse(text);
    } catch {
      metric(route, "bad_gateway", { status });
      return refusal(502, "bad_gateway", "Market data could not be read.");
    }
    if (status >= 400) return upstreamFailure(status);
    if (route === "status" && body !== null && typeof body === "object" && !Array.isArray(body)) {
      // The published status is the writer's fields only. Review L13:
      // `engine_id` names the engine's host (its default is the hostname); no
      // client reads it (the status read is for provenance), so it never leaves
      // this server. A committed reader's own diagnostics (`role`, `serveable`,
      // …) are not part of the contract either (#575).
      text = JSON.stringify(Object.fromEntries(Object.entries(body).filter(([key]) => STATUS_FIELDS.has(key))));
    }
    return new Response(text, {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": status === 200 ? cache(body) : PRIVATE_NO_STORE },
    });
  };
}

const routeNames = new Map<RateBucket, MarketRouteName>(
  (Object.keys(MARKET_ROUTE_BUCKETS) as MarketRouteName[]).map((name) => [MARKET_ROUTE_BUCKETS[name], name]),
);

async function marketQuotaRefusal(limiter: RateLimitPort | null, route: MarketRouteName, client: ClientAddress): Promise<Response | null> {
  if (!limiter) return null;
  try {
    const decision = await limiter.consume(MARKET_ROUTE_BUCKETS[route], { ip: client.rateKey });
    if (decision.allowed) return null;
    return refusal(429, "rate_limited", "Too many market reads. Try again shortly.", {
      "Retry-After": String(decision.retryAfterSeconds),
    });
  } catch {
    metric(route, "limiter_unavailable");
    return refusal(503, "unavailable", "Market data is unavailable. Try again shortly.", {
      "Retry-After": String(UNAVAILABLE_RETRY_AFTER_SECONDS),
    });
  }
}

/** Keep market admission ahead of HttpApi decoding, with the same rejection envelope. */
export function createAdmittedMarketRead(
  limiter: RateLimitPort,
  bucketForPath: (path: string) => RateBucket | null,
  read: (request: Request) => Promise<Response>,
) {
  return async (request: Request, client: ClientAddress): Promise<Response> => {
    const pathname = new URL(request.url).pathname;
    const bucket = bucketForPath(pathname);
    const route = bucket === null ? undefined : routeNames.get(bucket);
    if (!route || !segmentsOf(pathname)) return refusal(404, "not_found", "Not found.");
    const refused = await marketQuotaRefusal(limiter, route, client);
    return refused ?? read(request);
  };
}

/** Fetch implementation used by standalone consumers without the backend HttpApi. */
export function createMarketRoutes(dependencies: MarketRoutesDependencies) {
  const relay = createMarketRelay(dependencies);

  return Object.freeze({
    async handle(request: Request, client: ClientAddress): Promise<Response> {
      const url = new URL(request.url);
      const segments = segmentsOf(url.pathname);
      const matched = segments && match(segments, url.searchParams);
      if (!matched) return refusal(404, "not_found", "Not found.");
      const refused = await marketQuotaRefusal(dependencies.limiter, matched.route, client);
      if (refused) return refused;
      let path: string;
      try {
        path = matched.path();
      } catch (error) {
        return marketParameterFailure(error);
      }
      return relay(matched.route, path, matched.cache);
    },
  });
}

export type MarketRoutes = ReturnType<typeof createMarketRoutes>;
