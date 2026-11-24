
import { PORTFOLIO_UNAVAILABLE, type PortfolioSummaryState } from "#web/components/blast-ui/portfolio.ts";
import type { SocialPortfolio } from "@blast/core/web/contracts/portfolio.ts";

/**
 * The shell's one read of the viewer's own portfolio (`useShellPortfolio`,
 * T-019), shared below the shell: the rail's Portfolio row and the phone pill show `state`,
 * Blast mode's bar (§15) shows `portfolio`, and anything that changes a
 * position (a sale closing funded, §19; a commit, claim or deposit) calls
 * `refresh`. Outside a shell it is unavailable and `refresh` does nothing.
 */
export type ShellPortfolio = Readonly<{
  state: PortfolioSummaryState;
  portfolio: SocialPortfolio | null;
  refresh: () => void;
}>;

/** What a reader outside the shell gets, so it can tell "no shell" from "the shell's read failed" (Blast mode's dock, R3-58). */
export const NO_SHELL_PORTFOLIO: ShellPortfolio = Object.freeze({ state: PORTFOLIO_UNAVAILABLE, portfolio: null, refresh: () => undefined });
