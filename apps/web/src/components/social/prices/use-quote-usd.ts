"use client";

import { pollInterval } from "#web/lib/query/polling.ts";
import { useQuery } from "@tanstack/react-query";
import { CREATE_QUOTE_TYPE, quotePriceType } from "@blast/core/web/contracts/create.ts";
import { PORTFOLIO_PRICE_MAX_AGE_MS } from "@blast/core/web/contracts/portfolio.ts";

import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { priceQuery } from "./price-client.ts";

/** Current FX. Display values use USDC at par by default. */
export function useQuoteUsd(quoteType: string | null, { marketRate = false } = {}): string | null {
  const type = quoteType ? quotePriceType(quoteType) : null;
  const atPar = type === CREATE_QUOTE_TYPE && !marketRate;
  const client = useAppQueryClient();
  const { data, isStale } = useQuery({
    ...priceQuery({ kind: "coin", id: type ?? "", window: "1h" }),
    enabled: !!type && !atPar,
    staleTime: ({ state }) => {
      const asOf = state.data?.price_as_of_ms;
      if (asOf == null || asOf > state.dataUpdatedAt) return 0;
      return Math.max(0, asOf + PORTFOLIO_PRICE_MAX_AGE_MS - state.dataUpdatedAt);
    },
    notifyOnChangeProps: ["data", "isStale"],
    refetchInterval: (query) => pollInterval(PORTFOLIO_PRICE_MAX_AGE_MS / 2, query),
  }, client);
  if (atPar) return "1";
  const price = data?.price_usd;
  return !isStale && price && Number(price) > 0 ? price : null;
}
