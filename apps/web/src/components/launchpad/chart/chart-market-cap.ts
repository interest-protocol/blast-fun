"use client";

import { createContext, useContext } from "react";
import { marketCapRate } from "@blast/core/modules/social/prices/valuation.ts";
import { useCoinPriceCurrency } from "./CoinPriceCurrency";

/** The coin's supply in circulation, in atoms of a coin with `decimals`. */
export type MarketCapSupply = Readonly<{ atoms: bigint | string; decimals: number }>;

/** Set by a coin page that knows its supply in circulation; without it, the headline and the chart show the price. */
export const ChartMarketCapSupply = createContext<MarketCapSupply | null>(null);

/**
 * USD per quote coin times the whole coins in circulation. A whole-token price in the quote times
 * it is the market cap in USD, whichever currency the price line shows, so the headline and the
 * chart's axis read the same figure. Undefined on a page with no supply; null while the supply or
 * the rate is unknown.
 */
export function useMarketCapRate(): string | null | undefined {
  const supply = useContext(ChartMarketCapSupply);
  const rate = useCoinPriceCurrency()?.rate;
  return supply ? marketCapRate(rate, supply.atoms, supply.decimals) : undefined;
}

/**
 * The chart's unit. `quoteUsd` scales every price the chart shows: to market cap in USD when the
 * page has a supply and a rate, else to the price in the chosen currency. `tradeUsd` stays the
 * quote's own rate, for each trade's dollar size.
 */
export function useChartUnits(standaloneRate: string | null = null) {
  const currency = useCoinPriceCurrency();
  const capRate = useMarketCapRate();
  const tradeUsd = currency ? currency.quoteUsd : standaloneRate;
  return { quoteUsd: capRate ?? tradeUsd, tradeUsd, marketCap: capRate != null };
}
