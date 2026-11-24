import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";
import { atLeastPow10, exactDecimal, fixedExact, groupedExact } from "@blast/core/web/exact-amount.ts";
import type { CostBasisFigures } from "@blast/core/web/contracts/portfolio.ts";
import type { QueryClient } from "@tanstack/react-query";
import { portfolioQuery } from "#web/components/social/queries.ts";
import type { AccessTokenSource } from "#web/components/social/social-fetch.ts";
import type { CoinAsset } from "./coin-reads";
import { readablePrice } from "#web/lib/market-format.ts";
import { terminalUsd } from "./coin-facts";
import { ACCOUNT_POLL_MS } from "./use-coin-read";
import type { MarketTrade } from "#web/components/launchpad/market-stream-hub.ts";

export type CoinPnl = CostBasisFigures;
export type CoinPnlReader = (asset: CoinAsset) => Promise<CoinPnl | null>;

/** Which streamed trades are the viewer's own: a trade whose trader is one of the account's wallets. */
export function ownTrade(wallets: readonly string[]): (trade: MarketTrade) => boolean {
  const own = new Set(wallets.map((wallet) => normalizeSuiAddress(wallet)));
  return (trade) => trade.trade.trader !== null && own.has(normalizeSuiAddress(trade.trade.trader));
}

/**
 * The existing account cost basis covers all linked wallets, not just the trade wallet.
 * Every coin panel reads one shared full portfolio (the summary view carries no cost
 * basis), kept a minute; the viewer's own trade and wallet hints invalidate it sooner.
 */
export function createCoinPnlReader(client: QueryClient, getAccessToken: AccessTokenSource): CoinPnlReader {
  return async (asset) => {
    if (asset.network !== "mainnet") return null;
    const type = normalizeStructTag(asset.coin_type);
    const portfolio = await client.fetchQuery({ ...portfolioQuery(getAccessToken, undefined, false), staleTime: ACCOUNT_POLL_MS });
    if (portfolio.coins === null) throw new Error("Current PnL unavailable");
    if (portfolio.wallet_sync?.status !== "ready") return null;
    return portfolio.coins.find(coin => normalizeStructTag(coin.coin_type) === type) ?? null;
  };
}

/** Keep the exact signed amount and return; an unknown acquisition cost is not zero PnL. */
export function currentPnl(value: CoinPnl | null) {
  if (value?.basis_complete !== true || typeof value.pnl_usd !== "string" || !exactDecimal(value.basis_usd)?.n) return null;
  const negative = value.pnl_usd.startsWith("-");
  const amount = exactDecimal(value.pnl_usd.replace(/^[+-]/, ""));
  if (!amount) return null;
  const sign = amount.n === 0n ? "" : negative ? "−" : "+";
  return { amount: `${sign}$${groupedExact(amount, amount.scale)}`, percent: pnlPercent(value.pnl_multiple), tone: amount.n === 0n ? "flat" : negative ? "down" : "up" } as const;
}

/** Compact row figures only; currentPnl retains the exact values for inspection. */
export function compactPnl(value: CoinPnl | null) {
  const exact = currentPnl(value);
  if (!exact || typeof value?.pnl_usd !== "string") return null;
  const sign = exact.tone === "up" ? "+" : exact.tone === "down" ? "-" : "";
  return {
    ...exact,
    amount: terminalUsd(`${sign}${value.pnl_usd.replace(/^[+-]/, "")}`),
    percent: compactPnlPercent(value.pnl_multiple),
  };
}

function compactPnlPercent(value: string | null) {
  const multiple = exactDecimal(value);
  if (!multiple) return null;
  const delta = multiple.n - 10n ** BigInt(multiple.scale);
  const sign = delta === 0n ? "" : delta < 0n ? "−" : "+";
  const magnitude = { n: (delta < 0n ? -delta : delta) * 100n, scale: multiple.scale };
  for (const [power, suffix] of [[12, "T"], [9, "B"], [6, "M"], [3, "K"]] as const) {
    if (atLeastPow10(magnitude, power)) {
      const short = fixedExact({ n: magnitude.n, scale: magnitude.scale + power }, 2).replace(/\.?0+$/, "");
      return `${sign}${short}${suffix}%`;
    }
  }
  const text = atLeastPow10(magnitude, 0) ? groupedExact(magnitude, 2) : readablePrice(fixedExact(magnitude, magnitude.scale));
  return `${sign}${text}%`;
}

function pnlPercent(value: string | null) {
  const multiple = exactDecimal(value);
  if (!multiple) return null;
  const delta = multiple.n - 10n ** BigInt(multiple.scale);
  const sign = delta === 0n ? "" : delta < 0n ? "−" : "+";
  return `${sign}${groupedExact({ n: (delta < 0n ? -delta : delta) * 100n, scale: multiple.scale }, multiple.scale)}%`;
}
