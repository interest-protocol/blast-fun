import { track } from "@vercel/analytics";

import type { HomeViewState } from "./home-state";

/**
 * Home's product events on the site's analytics (`@vercel/analytics`, the
 * launchpad's own convention). Bounded, public metadata only: a source, a
 * sort, a window, a filter count, a sale id (public) and a view name. Never
 * a wallet, a follow, a holding or an amount.
 */
type Properties = Readonly<Record<string, string | number | boolean>>;

function send(name: string, properties: Properties): void {
  try {
    track(name, properties);
  } catch {
    // Analytics never breaks the page.
  }
}

export const homeAnalytics = {
  source: (state: HomeViewState) => send("home_source", { source: state.source, window: state.window }),
  controls: (state: HomeViewState, filters: number) => send("home_controls", { sort: state.sort, window: state.window, filters, age: state.age, min: state.minParticipants, tradable: state.tradable, known_deployer: state.knownDeployer }),
  events: (presaleId: string) => send("home_events_expand", { presale: presaleId }),
  openCoin: (presaleId: string) => send("home_open_coin", { presale: presaleId }),
  trade: (presaleId: string, action: "buy" | "sell" | "commit" | "view") => send("home_trade_entry", { presale: presaleId, action }),
  watchlistAction: (presaleId: string, on: boolean) => send("home_watchlist", { presale: presaleId, on }),
  refresh: (source: string) => send("home_ranking_refresh", { source }),
  /** A page turned or the rows per page changed: the numbers only. */
  page: (source: string, page: number, rows: number) => send("home_page", { source, page, rows }),
  /** A trader's card opened: its position in the section, never who. */
  trader: (position: number) => send("home_trader_expand", { position }),
  /** A section moved or hidden/shown (the device's layout; a key and a position, nothing personal). */
  sections: (section: string, action: "move" | "hide" | "show", position: number) => send("home_sections", { section, action, position }),
} as const;
