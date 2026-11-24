import { homeMarketReadSchema } from "@blast/core/web/contracts/home-read-schemas.ts";
import { homeHoldersPageSchema, homeChartTradesPageSchema } from "@blast/core/web/contracts/home-schemas.ts";
import { WorkspaceDataUnavailable } from "../live-read";
import {
  socialHomeChartTradesPath,
  socialHomeHoldersPath,
  socialHomeMarketPath,
  type HomeChartTradesPage,
  type HomeCoinMarket,
  type HomeHoldersPage,
} from "@blast/core/web/contracts/coin-market.ts";
import { publicJson, publicReadSignal } from "#web/components/social/public-json.ts";
import { callSocialApi, type SocialResponseBody } from "#web/components/social/social-api.ts";
import type { AccessTokenSource } from "#web/components/social/social-fetch.ts";

/**
 * The coin market reads served since interest-protocol/blast-v2#534 (redesign
 * data gaps): one coin's windows and buy/sell pressure (the Flow card), its
 * holders with their cost basis (the Holders table) and the chart's "My
 * trades" and "Big trades" overlays. Public reads without credentials, the
 * viewer's own trades under the account's session.
 */
function readMarketJson<Body>(path: string, what: string, contract: SocialResponseBody<Body>, signal: AbortSignal): Promise<Body> {
  return publicJson(path, what, contract, {
    signal: publicReadSignal(signal),
    notFound: () => new WorkspaceDataUnavailable("Market coverage is unavailable for this asset."),
    invalidResponse: () => new Error(`${what} returned an unreadable response.`),
  });
}

export function fetchCoinMarket(coinType: string, signal: AbortSignal): Promise<HomeCoinMarket> {
  return readMarketJson<HomeCoinMarket>(socialHomeMarketPath(coinType), "The coin's market", homeMarketReadSchema, signal);
}

export function fetchCoinHolders(coinType: string, signal: AbortSignal): Promise<HomeHoldersPage> {
  return readMarketJson<HomeHoldersPage>(socialHomeHoldersPath(coinType), "The holders", homeHoldersPageSchema, signal);
}

/** The chart's big trades (at least $1,000) in `(fromMs, toMs]`. */
export function fetchBigChartTrades(coinType: string, fromMs: number, toMs: number, signal: AbortSignal): Promise<HomeChartTradesPage> {
  return readMarketJson<HomeChartTradesPage>(socialHomeChartTradesPath(coinType, fromMs, toMs), "Big trades", homeChartTradesPageSchema, signal);
}

/** The signed-in viewer's own trades of the coin in `(fromMs, toMs]`, from every linked wallet. */
export async function fetchMyChartTrades(getAccessToken: AccessTokenSource, coinType: string, fromMs: number, toMs: number, signal: AbortSignal): Promise<HomeChartTradesPage> {
  const result = await callSocialApi(
    { getAccessToken, signal },
    socialHomeChartTradesPath(coinType, fromMs, toMs, true),
    { method: "GET" },
    homeChartTradesPageSchema,
  );
  if (result.status !== "ok") throw new Error("Your trades could not load.");
  return result.body;
}
