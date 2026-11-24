import type { PortfolioSummaryState } from "#web/components/blast-ui/portfolio.ts";

/**
 * The design's sample portfolio figures for every shell fixture (oa41's Kai:
 * `$4,760`, `+4.96% today`): the rail's Portfolio row and the phone pill.
 * Development fixtures only; the product reads `/me/portfolio` and R3-20's prices.
 */
export const SHELL_FIXTURE_PORTFOLIO: PortfolioSummaryState = Object.freeze({
  status: "ready",
  summary: { total_usd: 4_760.34, breakdown: { coins: 3_660.34, committed: 850, claimable: 250 }, today: { usd: 224.81, pct: 4.96 } },
});
