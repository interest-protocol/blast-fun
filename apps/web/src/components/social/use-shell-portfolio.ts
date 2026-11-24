"use client";

import { useQueries, useQuery } from "@tanstack/react-query";
import { useCallback, useMemo } from "react";

import {
  PORTFOLIO_LOADING,
  PORTFOLIO_UNAVAILABLE,
  type PortfolioSummary,
  type PortfolioSummaryState,
} from "#web/components/blast-ui/portfolio.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { SocialPortfolio } from "@blast/core/web/contracts/portfolio.ts";
import type { SocialPriceHistory } from "@blast/core/web/contracts/prices.ts";

import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import type { PortfolioReadResult } from "./portfolio-client";
import { dockToday } from "./portfolio/today-model";
import { priceQuery } from "./prices/price-client";
import { portfolioFigures, pricedFigures, valuationHoldingsReady } from "./portfolio/portfolio-model";
import { PORTFOLIO_STALE_MS, portfolioQuery } from "./queries";
import type { AccessTokenSource } from "./viewer-state-client";

/** A visible tab reads the portfolio again when its last read is older than this. */
export const SHELL_PORTFOLIO_STALE_MS = PORTFOLIO_STALE_MS;

/**
 * The coins whose 24 h prices today's move needs (R3-20's `coin` asks): SUI,
 * then every sale coin the portfolio holds, by its type. None until the
 * portfolio has answered with its coins and balances.
 */
export function shellPriceAsks(portfolio: SocialPortfolio | null): readonly string[] {
  if (portfolio?.coin_summary) return [];
  if (portfolio === null || portfolio.coins === null || portfolio.balances === null) return [];
  return [SUI_COIN_TYPE, ...portfolio.coins.map((coin) => coin.coin_type).filter((type) => type !== SUI_COIN_TYPE)];
}

/** Keep complete totals separate from the known subtotal when some assets are unpriced. */
export function shellPortfolioSummary(portfolio: SocialPortfolio, prices: ReadonlyMap<string, SocialPriceHistory | null>): PortfolioSummary {
  const sale = (portfolio.coins ?? []).flatMap((coin) => {
    const price = prices.get(coin.coin_type);
    return price ? [price] : [];
  });
  const { total: completeTotal, ...breakdown } = portfolioFigures(portfolio);
  const priced = pricedFigures(portfolio);
  return { total_usd: completeTotal,
    ...(completeTotal === null && valuationHoldingsReady(portfolio) ? { unpriced_assets: true as const } : {}),
    ...(priced ? { known_value_usd: priced.total,
      known_breakdown: { coins: priced.coins, committed: priced.committed, claimable: priced.claimable } } : {}),
    breakdown, today: dockToday(portfolio, sale, prices.get(SUI_COIN_TYPE)) };
}

/** A summary's figures as primitives: the shell memoizes on them, so its context changes only when a figure does. */
export function summaryFigures(summary: PortfolioSummary | null) {
  const { total_usd: total = null, known_value_usd: known, unpriced_assets: unpriced, breakdown, known_breakdown: parts, today } = summary ?? {};
  const { coins = null, committed = null, claimable = null } = breakdown ?? {};
  const { usd: todayUsd = null, pct: todayPct = null } = today ?? {};
  return { total, known, unpriced, coins, committed, claimable, knownCoins: parts?.coins, knownCommitted: parts?.committed, knownClaimable: parts?.claimable, todayUsd, todayPct };
}

/** The summary back from `summaryFigures`, every field the shell's readers use, the priced split included (#601). */
export function summaryFromFigures(figures: ReturnType<typeof summaryFigures>): PortfolioSummary {
  const { total, known, unpriced, coins, committed, claimable, knownCoins, knownCommitted, knownClaimable, todayUsd, todayPct } = figures;
  const parts = knownCoins === undefined || knownCommitted === undefined || knownClaimable === undefined
    ? {} : { known_breakdown: { coins: knownCoins, committed: knownCommitted, claimable: knownClaimable } };
  return { total_usd: total, ...(unpriced ? { unpriced_assets: unpriced, ...(known === undefined ? {} : { known_value_usd: known }), ...parts } : {}), breakdown: { coins, committed, claimable },
    today: todayUsd === null || todayPct === null ? null : { usd: todayUsd, pct: todayPct } };
}

/** The shell's state for one portfolio read, before any price has answered. */
export function shellPortfolioState(result: PortfolioReadResult): PortfolioSummaryState {
  return result.status === "ready" ? { status: "ready", summary: shellPortfolioSummary(result.portfolio, new Map()) } : PORTFOLIO_UNAVAILABLE;
}

const noToken = async () => null;

/**
 * The shell's portfolio: the owner's `GET /api/social/me/portfolio` (T-019),
 * read in the browser with the viewer's token once an account exists, and the
 * 24 h prices of what it holds (R3-20's public `GET /api/social/prices`,
 * batched by `price-client.ts`). It is the shared portfolio query (OA-38), so
 * the Portfolio page, the profile and Blast mode's bar read the same answer
 * without a request of their own. It reads again when the tab comes back
 * after a minute or more (each read fans out to the fullnode, so it never
 * polls), on `refresh`, and when a write moves it (`invalidateAfter`). A
 * visitor, or a session without an account, reads nothing. `state` is what
 * the rail's Portfolio row and the phone pill show (the total and today's
 * move, R3-73); `portfolio` is the answer itself, null until one arrives.
 */
export function useShellPortfolio(
  input: Readonly<{ enabled: boolean; accountId: string | null; getAccessToken?: AccessTokenSource }>,
): Readonly<{ state: PortfolioSummaryState; portfolio: SocialPortfolio | null; refresh: () => void }> {
  const { enabled, accountId, getAccessToken } = input;
  const client = useAppQueryClient();
  const active = enabled && accountId !== null && getAccessToken !== undefined;
  const query = useQuery({ ...portfolioQuery(getAccessToken ?? noToken), enabled: active, refetchOnWindowFocus: true }, client);
  const refresh = useCallback(() => void client.invalidateQueries({ queryKey: queryKeys.me.portfolio() }, { cancelRefetch: false }), [client]);
  const { data, isError } = query;
  const asks = shellPriceAsks(active ? (data ?? null) : null);
  const priceReads = useQueries(
    { queries: asks.map((coin) => ({ ...priceQuery({ kind: "coin" as const, id: coin, window: "24h" }), enabled: active })) },
    client,
  );
  const prices = new Map<string, SocialPriceHistory | null>();
  asks.forEach((coin, index) => {
    const read = priceReads[index];
    if (read?.data !== undefined) prices.set(coin, read.data);
  });
  const summary = data ? shellPortfolioSummary(data, prices) : null;
  // Kept by value, so the shell's context changes only when a figure does.
  const { total, known, unpriced, coins, committed, claimable, knownCoins, knownCommitted, knownClaimable, todayUsd, todayPct } = summaryFigures(summary);
  const ready = useMemo<PortfolioSummaryState | null>(
    () => {
      if (!data) return null;
      return { status: "ready", summary: summaryFromFigures({ total, known, unpriced, coins, committed, claimable, knownCoins, knownCommitted, knownClaimable, todayUsd, todayPct }) };
    },
    [data, total, known, unpriced, coins, committed, claimable, knownCoins, knownCommitted, knownClaimable, todayUsd, todayPct],
  );

  if (!active) return { state: PORTFOLIO_UNAVAILABLE, portfolio: null, refresh };
  if (isError && ready === null) return { state: PORTFOLIO_UNAVAILABLE, portfolio: null, refresh };
  // A refresh keeps showing the previous figures until the new ones arrive.
  if (ready === null || data === undefined) return { state: PORTFOLIO_LOADING, portfolio: null, refresh };
  return { state: ready, portfolio: data, refresh };
}
