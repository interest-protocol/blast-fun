import { SUI_OBJECT_ID_SOURCE } from "@blast/core/lib/sui/ids.ts";
import { MIGRATOR_VENUES, VENUES } from "@blast/core/modules/launchpad-contract/venues.ts";
import type { RateBucket } from "@blast/core/lib/web-security/rate-limits.ts";
import { NON_MARKET_READ_ROUTES, PRESALE_ALLOWLIST_CSV_READ, PRESALE_PROOF_READ } from "@blast/core/modules/backend-api/public-read-routes.ts";
import {
  routePattern,
  type RouteParamPatterns,
  type RoutePath,
} from "@blast/core/modules/backend-api/route-path.ts";

/** V1 owns this explicit route registry; never derive it from frontend routes. */
const VENUE_SEGMENT = `(?:${VENUES.join("|")})`;
const MIGRATOR_VENUE_SEGMENT = `(?:${MIGRATOR_VENUES.join("|")})`;
export const PARTNER_COIN_SEGMENT_LIMIT = 512;
const COIN_TYPE = `[A-Za-z0-9_:%]{1,${PARTNER_COIN_SEGMENT_LIMIT}}`;

type ReadRoute = Readonly<{
  name: string;
  path: RoutePath;
  params?: RouteParamPatterns;
  prefix: RoutePath;
  bucket: RateBucket;
}>;

export { PRESALE_READ, PRESALE_PROOF_READ, WALLET_LAUNCHES_READ } from "@blast/core/modules/backend-api/public-read-routes.ts";

const COIN_METADATA_READ = { name: "coin_metadata", path: "/api/v1/market/coins/:coinType/metadata", params: { coinType: COIN_TYPE }, prefix: "/api/v1", bucket: "launchpad_market_coin" } as const satisfies ReadRoute;
export const PARTNER_COIN_METADATA_PATH = COIN_METADATA_READ.path;
export const DAILY_STATS_READ = { name: "daily_stats", path: "/api/v1/market/launchpad/daily-stats", prefix: "/api/v1", bucket: "defillama_read" } as const satisfies ReadRoute;

const ROUTES = [
  ...NON_MARKET_READ_ROUTES,
  DAILY_STATS_READ,
  { name: "market", path: "/api/v1/market/status", prefix: "/api/launchpad", bucket: "launchpad_market_status" },
  { name: "market", path: "/api/v1/market/coins/:coinType", params: { coinType: COIN_TYPE }, prefix: "/api/launchpad", bucket: "launchpad_market_coin" },
  COIN_METADATA_READ,
  { name: "market", path: "/api/v1/market/coins/:coinType/candles", params: { coinType: COIN_TYPE }, prefix: "/api/launchpad", bucket: "launchpad_market_candles" },
  { name: "market", path: "/api/v1/market/coins/:coinType/holders", params: { coinType: COIN_TYPE }, prefix: "/api/launchpad", bucket: "launchpad_market_holders" },
  { name: "market", path: "/api/v1/market/launches/:launchId/activity", params: { launchId: SUI_OBJECT_ID_SOURCE }, prefix: "/api/launchpad", bucket: "launchpad_market_activity" },
  { name: "market", path: "/api/v1/market/pools/:venue/:poolId", params: { venue: VENUE_SEGMENT, poolId: SUI_OBJECT_ID_SOURCE }, prefix: "/api/launchpad", bucket: "launchpad_market_pool" },
  { name: "market", path: "/api/v1/market/pools/:venue/:poolId/candles", params: { venue: VENUE_SEGMENT, poolId: SUI_OBJECT_ID_SOURCE }, prefix: "/api/launchpad", bucket: "launchpad_market_candles" },
  { name: "market", path: "/api/v1/market/pools/:venue/:poolId/trades", params: { venue: MIGRATOR_VENUE_SEGMENT, poolId: SUI_OBJECT_ID_SOURCE }, prefix: "/api/launchpad", bucket: "launchpad_market_trades" },
  // The launchpad's rewards, wallet, partner and policy reads (LP-14). A wallet read names its
  // address in the path and returns public chain data about it: no viewer state.
  { name: "market", path: "/api/v1/market/launches/:launchId/rewards", params: { launchId: SUI_OBJECT_ID_SOURCE }, prefix: "/api/launchpad", bucket: "launchpad_market_rewards" },
  { name: "market", path: "/api/v1/market/launches/:launchId/reward-rounds", params: { launchId: SUI_OBJECT_ID_SOURCE }, prefix: "/api/launchpad", bucket: "launchpad_market_reward_rounds" },
  { name: "market", path: "/api/v1/market/wallets/:address/launches", params: { address: SUI_OBJECT_ID_SOURCE }, prefix: "/api/launchpad", bucket: "launchpad_market_wallet_launches" },
  { name: "market", path: "/api/v1/market/wallets/:address/launch-rewards", params: { address: SUI_OBJECT_ID_SOURCE }, prefix: "/api/launchpad", bucket: "launchpad_market_wallet_launch_rewards" },
  { name: "market", path: "/api/v1/market/wallets/:address/launch-holder-rewards", params: { address: SUI_OBJECT_ID_SOURCE }, prefix: "/api/launchpad", bucket: "launchpad_market_wallet_holder_rewards" },
  { name: "market", path: "/api/v1/market/partners", prefix: "/api/launchpad", bucket: "launchpad_market_partners" },
  { name: "market", path: "/api/v1/market/partners/:partnerId", params: { partnerId: SUI_OBJECT_ID_SOURCE }, prefix: "/api/launchpad", bucket: "launchpad_market_partner" },
  { name: "market", path: "/api/v1/market/partners/:partnerId/launches", params: { partnerId: SUI_OBJECT_ID_SOURCE }, prefix: "/api/launchpad", bucket: "launchpad_market_partner_launches" },
  { name: "market", path: "/api/v1/market/launchpad/policy", prefix: "/api/launchpad", bucket: "launchpad_market_policy" },
] as const satisfies readonly ReadRoute[];

/** Existing public frontend reads omitted from the published partner catalog. */
const FIRST_PARTY_ROUTES = [
  { name: "market", path: "/api/v1/market/creator-claims", prefix: "/api/launchpad", bucket: "launchpad_market_creator_claims" },
] as const satisfies readonly ReadRoute[];

/** The browser client's older name for a wallet's holder rewards; it reads the canonical route. */
const VAULT_REWARDS = {
  path: "/api/v1/market/wallets/:address/vault-rewards",
  params: { address: SUI_OBJECT_ID_SOURCE },
  prefix: "/api/launchpad",
} as const;
const VAULT_REWARDS_PATTERN = routePattern(VAULT_REWARDS.path, VAULT_REWARDS.params);

/** Each first-party read's web path, such as `/api/launchpad/market/status`; the web app has one relay file per path. */
export const FIRST_PARTY_WEB_PATHS: readonly RoutePath[] = [...ROUTES, ...FIRST_PARTY_ROUTES, VAULT_REWARDS]
  .filter((route) => route.prefix !== "/api/v1" && route !== PRESALE_PROOF_READ)
  .map(webPath);

type WebPath<Route> = Route extends { path: `/api/v1${infer Rest}`; prefix: infer Prefix extends RoutePath } ? `${Prefix}${Rest}` : never;

/** The path a read's handler sees: its v1 path under its first-party prefix, such as `/api/social/presales/:presale_id`. */
export function webPath<Route extends Pick<ReadRoute, "path" | "prefix">>(route: Route): WebPath<Route> {
  return `${route.prefix}${route.path.slice("/api/v1".length)}` as WebPath<Route>;
}

/** A v1 read path with the vault-rewards alias resolved to its canonical route. */
export function canonicalFirstPartyAlias(path: string): string {
  const address = VAULT_REWARDS_PATTERN.exec(path)?.groups?.address;
  return address === undefined ? path : `/api/v1/market/wallets/${address}/launch-holder-rewards`;
}

const PARTNER_MATCHERS = ROUTES.map(withPattern);
const FIRST_PARTY_MATCHERS = [
  ...FIRST_PARTY_ROUTES,
  ...ROUTES.filter((route) => route !== PRESALE_PROOF_READ && route !== COIN_METADATA_READ && route !== DAILY_STATS_READ && route !== PRESALE_ALLOWLIST_CSV_READ),
].map(withPattern);

const MARKET_SOURCE_MATCHERS = FIRST_PARTY_MATCHERS.filter((route) => route.name === "market")
  .map((route) => ({ bucket: route.bucket, pattern: routePattern(webPath(route), "params" in route ? route.params : undefined) }));

export function marketSourceBucket(path: string): RateBucket | null {
  return MARKET_SOURCE_MATCHERS.find(({ pattern }) => pattern.test(path))?.bucket ?? null;
}

function withPattern<Route extends ReadRoute>(route: Route): Route & { pattern: RegExp } {
  return { ...route, pattern: routePattern(route.path, route.params) };
}

export type PartnerV1Read = (typeof ROUTES)[number]["name"];

export function partnerV1Route(path: string): { name: PartnerV1Read; sourcePath: string } | null {
  const route = PARTNER_MATCHERS.find(({ pattern }) => pattern.test(path));
  return route ? { name: route.name, sourcePath: route.prefix + path.slice("/api/v1".length) } : null;
}


/** Only exact v1 reads/preflights move to the regional authentication boundary. */
export function isRegionalPartnerRead(request: Request): boolean {
  return ["GET", "HEAD", "OPTIONS"].includes(request.method) && partnerV1Route(new URL(request.url).pathname) !== null;
}

/** Frontend-only reads still require signed gateway admission and endpoint quota. */
export function firstPartyReadRoute(path: string): ReturnType<typeof partnerV1Route> {
  const route = FIRST_PARTY_MATCHERS.find(({ pattern }) => pattern.test(path));
  return route ? { name: route.name, sourcePath: route.prefix + path.slice("/api/v1".length) } : null;
}

/** Same existing endpoint counters, resolved before the public data cache. */
export function partnerEndpointBucket(path: string): RateBucket | null {
  return PARTNER_MATCHERS.find(({ pattern }) => pattern.test(path))?.bucket ?? null;
}

export function firstPartyEndpointBucket(path: string): RateBucket | null {
  return FIRST_PARTY_MATCHERS.find(({ pattern }) => pattern.test(path))?.bucket ?? null;
}
