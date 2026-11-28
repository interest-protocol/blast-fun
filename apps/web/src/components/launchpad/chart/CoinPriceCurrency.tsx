"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useQuoteUsdState } from "#web/components/social/prices/use-quote-usd.ts";

type Currency = "usd" | "quote";
type CoinPriceCurrency = Readonly<{
  currency: Currency;
  setCurrency: (currency: Currency) => void;
  unit: string;
  quoteType: string | null;
  quoteSymbol: string;
  rate: string | null;
  quoteUsd: string | null;
  /** The dollar view is chosen and its rate is still being read: show no quote-coin figure meanwhile. */
  pending: boolean;
}>;

const CurrencyContext = createContext<CoinPriceCurrency | null>(null);

export function useCoinPriceCurrency() {
  return useContext(CurrencyContext);
}

/** One quote rate and display choice for the price headline and the chart. */
export function CoinPriceCurrencyProvider({ quoteType, quoteSymbol, children }: Readonly<{
  quoteType: string | null;
  quoteSymbol: string;
  children: ReactNode;
}>) {
  // The quote's live rate: the page's dollar figures move with each SUI or USDC tick.
  const { rate, pending: reading } = useQuoteUsdState(quoteType, { live: true });
  const [selected, setCurrency] = useState<Currency>("usd");
  // USD holds while the first rate read is out; only a read that ends with no rate falls back to the quote coin.
  const currency = rate || reading ? selected : "quote";
  const pending = currency === "usd" && !rate;
  const value = useMemo<CoinPriceCurrency>(() => ({
    currency, setCurrency, quoteType, quoteSymbol, rate, pending,
    unit: currency === "usd" ? "USD" : quoteSymbol,
    quoteUsd: currency === "usd" ? rate : null,
  }), [currency, quoteType, quoteSymbol, rate, pending]);
  return <CurrencyContext value={value}>{children}</CurrencyContext>;
}
