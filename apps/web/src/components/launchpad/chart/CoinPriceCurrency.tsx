"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { useQuoteUsd } from "#web/components/social/prices/use-quote-usd.ts";

type Currency = "usd" | "quote";
type CoinPriceCurrency = Readonly<{
  currency: Currency;
  setCurrency: (currency: Currency) => void;
  unit: string;
  quoteType: string | null;
  quoteSymbol: string;
  rate: string | null;
  quoteUsd: string | null;
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
  const rate = useQuoteUsd(quoteType);
  const [selected, setCurrency] = useState<Currency>("usd");
  const currency = rate ? selected : "quote";
  const value = useMemo<CoinPriceCurrency>(() => ({
    currency, setCurrency, quoteType, quoteSymbol, rate,
    unit: currency === "usd" ? "USD" : quoteSymbol,
    quoteUsd: currency === "usd" ? rate : null,
  }), [currency, quoteType, quoteSymbol, rate]);
  return <CurrencyContext value={value}>{children}</CurrencyContext>;
}
