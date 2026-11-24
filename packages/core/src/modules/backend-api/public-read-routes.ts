import { SUI_OBJECT_ID_SOURCE } from "../../lib/sui/ids.ts";
import type { RateBucket } from "../../lib/web-security/rate-limits.ts";
import type { RouteParamPatterns, RoutePath } from "./route-path.ts";

type ReadRoute = Readonly<{
  name: string;
  path: RoutePath;
  params?: RouteParamPatterns;
  prefix: RoutePath;
  bucket: RateBucket;
}>;

export const PARTNER_COIN_SEGMENT_LIMIT = 512;
export const PARTNER_COIN_SEGMENT = `[A-Za-z0-9_:%]{1,${PARTNER_COIN_SEGMENT_LIMIT}}`;

export const COIN_METADATA_READ = {
  name: "coin_metadata",
  path: "/api/v1/market/coins/:coinType/metadata",
  params: { coinType: PARTNER_COIN_SEGMENT },
  prefix: "/api/v1",
  bucket: "launchpad_market_coin",
} as const satisfies ReadRoute;

export const DAILY_STATS_READ = {
  name: "daily_stats",
  path: "/api/v1/market/launchpad/daily-stats",
  prefix: "/api/v1",
  bucket: "defillama_read",
} as const satisfies ReadRoute;

export const PRESALE_READ = {
  name: "presale",
  path: "/api/v1/presales/:presale_id",
  params: { presale_id: SUI_OBJECT_ID_SOURCE },
  prefix: "/api/social",
  bucket: "social_read_presales",
} as const satisfies ReadRoute;

export const PRESALE_PROOF_READ = {
  name: "presale_proof",
  path: "/api/v1/presales/:presale_id/proof",
  params: { presale_id: SUI_OBJECT_ID_SOURCE },
  prefix: "/api/presale",
  bucket: "presale_proof",
} as const satisfies ReadRoute;

export const PRESALE_ALLOWLIST_CSV_READ = {
  name: "presale_allowlist_csv",
  path: "/api/v1/presales/:presale_id/allowlist.csv",
  params: { presale_id: SUI_OBJECT_ID_SOURCE },
  prefix: "/api/v1",
  bucket: "presale_allowlist_csv",
} as const satisfies ReadRoute;

export const WALLET_LAUNCHES_READ = {
  name: "wallet_launches",
  path: "/api/v1/wallets/:address/launches",
  params: { address: SUI_OBJECT_ID_SOURCE },
  prefix: "/api/launchpad",
  bucket: "launchpad_wallet_launches",
} as const satisfies ReadRoute;

export const NON_MARKET_READ_ROUTES = [
  COIN_METADATA_READ,
  DAILY_STATS_READ,
  {
    name: "defillama",
    path: "/api/v1/defillama/:dataset",
    params: { dataset: "(?:metadata|fees|metrics|contracts)" },
    prefix: "/api/v1",
    bucket: "defillama_read",
  },
  {
    name: "presales",
    path: "/api/v1/presales",
    prefix: "/api/social",
    bucket: "social_read_presales",
  },
  {
    name: "featured",
    path: "/api/v1/presales/featured",
    prefix: "/api/social",
    bucket: "social_read_presales",
  },
  PRESALE_READ,
  PRESALE_PROOF_READ,
  PRESALE_ALLOWLIST_CSV_READ,
  {
    name: "prices",
    path: "/api/v1/prices",
    prefix: "/api/social",
    bucket: "social_read_prices",
  },
  {
    name: "discovery",
    path: "/api/v1/discovery",
    prefix: "/api/launchpad",
    bucket: "launchpad_discovery",
  },
  {
    name: "search",
    path: "/api/v1/search",
    prefix: "/api/launchpad",
    bucket: "launchpad_search",
  },
  WALLET_LAUNCHES_READ,
] as const satisfies readonly ReadRoute[];

export type NonMarketReadRoute = (typeof NON_MARKET_READ_ROUTES)[number];
