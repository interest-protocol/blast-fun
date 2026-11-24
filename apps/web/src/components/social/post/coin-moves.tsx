"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { PRESALE_LIST_SORTS, type SocialPresaleSummary } from "@blast/core/web/contracts/presales.ts";
import { PRICE_MAX_PRESALES } from "@blast/core/web/contracts/prices.ts";
import { bpsToPct } from "@blast/core/modules/social/prices/change.ts";

import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { salesPricesQuery, usePrice } from "../prices/price-client";
import { presaleListQuery } from "../queries";
import { coinMovesOf, type CoinMoves } from "./coin-moves-model";

/** How many ended sales the moves read. The list route's own ceiling is 50. */
export const ENDED_SALES_LIMIT = 50;

const ENDED_LIST = presaleListQuery({ status: "ended", sort: PRESALE_LIST_SORTS.ended[0], limit: ENDED_SALES_LIMIT });

/**
 * The moves as the browser reads them, once a card needs them (`enabled`):
 * the ended sales' list (`GET /api/social/presales?status=ended`, the trading
 * ones), their last 24 hours (`GET /api/social/prices`) and SUI's. Every read
 * is a shared query, so a feed of buys asks each once. Null until the sales' prices answer; a coin
 * with no 24 h price has no move (never a made-up 0).
 */
export function useCoinMoves(enabled: boolean): CoinMoves | null {
  const client = useAppQueryClient();
  const list = useQuery({ ...ENDED_LIST, enabled }, client);
  const ids = useMemo(() => tradingPresaleIds(list.data?.presales ?? []).join(","), [list.data]);
  const prices = useQuery({ ...salesPricesQuery(ids), enabled: enabled && ids !== "" }, client);
  const sui = usePrice(enabled ? { coin: SUI_COIN_TYPE } : null);
  const answer = prices.data;
  const suiBps = sui?.change_24h_bps ?? null;
  return useMemo(() => {
    if (!answer) return null;
    const change = new Map<string, number>();
    for (const price of answer.prices) {
      const pct = bpsToPct(price.change_24h_bps);
      if (price.presale_id !== null && pct !== null) change.set(price.presale_id, pct);
    }
    const suiPct = bpsToPct(suiBps);
    if (suiPct !== null) change.set("sui", suiPct);
    return coinMovesOf(change);
  }, [answer, suiBps]);
}

/** The trading sales among the list, whose prices the moves read (at most `PRICE_MAX_PRESALES`). */
function tradingPresaleIds(presales: readonly SocialPresaleSummary[]): readonly string[] {
  return [...new Set(presales.filter((summary) => summary.phase === "trading").map((summary) => summary.presale_id))].slice(0, PRICE_MAX_PRESALES);
}
