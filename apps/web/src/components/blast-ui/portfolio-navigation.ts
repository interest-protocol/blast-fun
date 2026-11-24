import { SOCIAL_PAGE_PATHS } from "@blast/core/lib/social-page-routes.ts";

/**
 * The holdings card's switch: three choices (TS-5, 2026-11-14). Claims holds
 * what the hero calls "To claim": vesting unlocks, holder rewards, creator
 * earnings, and the launches you created.
 */
export const PORTFOLIO_TABS = [
  ["coins", "Coins"],
  ["presales", "Presales"],
  ["claims", "Claims"],
] as const;
export type PortfolioTab = (typeof PORTFOLIO_TABS)[number][0];

/** The tabs Claims replaced: their links (and a remembered choice) open Claims. */
const CLAIMS_ALIASES = ["vestings", "rewards", "launches"] as const;

/** The holdings card's tabs: the same on every request. */
export function portfolioTabs(): typeof PORTFOLIO_TABS {
  return PORTFOLIO_TABS;
}

export function isPortfolioTab(value: unknown): value is PortfolioTab {
  return PORTFOLIO_TABS.some(([key]) => key === value);
}

/** A tab name from a link or storage, old names included; null for anything else. */
export function portfolioTabNamed(value: unknown): PortfolioTab | null {
  if (isPortfolioTab(value)) return value;
  return CLAIMS_ALIASES.some((alias) => alias === value) ? "claims" : null;
}

const PORTFOLIO_TAB_PATHS = {
  coins: SOCIAL_PAGE_PATHS.portfolio,
  presales: SOCIAL_PAGE_PATHS.portfolioPresales,
  claims: SOCIAL_PAGE_PATHS.portfolioClaims,
} as const satisfies Record<PortfolioTab, string>;

const CLAIMS_ALIAS_PATHS = [SOCIAL_PAGE_PATHS.portfolioVestings, SOCIAL_PAGE_PATHS.portfolioRewards, SOCIAL_PAGE_PATHS.portfolioLaunches] as const;

export function portfolioPath(tab: PortfolioTab): string {
  return PORTFOLIO_TAB_PATHS[tab];
}

/** Legacy query links remain valid; the URL always takes precedence over device state. */
export function portfolioTabAt(path: string, search = ""): PortfolioTab | null {
  if (path === SOCIAL_PAGE_PATHS.portfolio) {
    return portfolioTabNamed(new URLSearchParams(search).get("tab")) ?? "coins";
  }
  if (CLAIMS_ALIAS_PATHS.some((alias) => alias === path)) return "claims";
  return PORTFOLIO_TABS.find(([tab]) => portfolioPath(tab) === path)?.[0] ?? null;
}
