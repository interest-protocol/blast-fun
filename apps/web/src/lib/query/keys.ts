import { partialMatchKey, type QueryKey } from "@tanstack/react-query";

/** Public reads share one cache; private reads are removed when the viewer changes. */
const ROOT = "blast";

/** A list of ids as a key part: sorted and de-duplicated, so order never splits the cache. */
export function sortedIds(ids: readonly string[]): readonly string[] {
  return [...new Set(ids)].sort();
}

export const queryKeys = {
  all: [ROOT] as const,

  /* ---- Public reads (no credentials; CDN s-maxage=10) ---- */
  public: [ROOT, "public"] as const,

  competitions: {
    swap: () => [ROOT, "public", "competitions", "swap"] as const,
    board: (slug: string | null, page: number, period: string) => [ROOT, "public", "competitions", slug, page, period] as const,
  },
  bonding: {
    featured: () => [ROOT, "public", "bonding-featured"] as const,
    launch: (launchId: string) => [ROOT, "public", "launch-details", launchId] as const,
  },
  workspace: {
    activity: (window: string, rows: number, cursor: string | null) => [ROOT, "public", "workspace-activity", window, rows, cursor] as const,
    feed: (rows: number, cursor: string | null) => [ROOT, "public", "workspace-feed", rows, cursor] as const,
    feedAssets: (ids: string) => [ROOT, "public", "workspace-feed-assets", ids] as const,
    presales: (window: string) => [ROOT, "public", "workspace-presales", window] as const,
    portfolioCapabilities: [ROOT, "public", "workspace-portfolio-capability"] as const,
    portfolioCapability: (coinType: string | null) => [ROOT, "public", "workspace-portfolio-capability", coinType] as const,
    portfolioPresales: (ids: readonly string[]) => [ROOT, "public", "workspace-portfolio-presales", ids] as const,
    assetSearch: (term: string, cursor: string | null) => [ROOT, "public", "workspace-asset-search", term, cursor] as const,
    traders: (search: string, page: number, rows: number) => [ROOT, "public", "workspace-traders", search, page, rows] as const,
    traderAssets: (trader: string, ids: string) => [ROOT, "public", "workspace-trader-assets", trader, ids] as const,
    coins: (source: QueryKey) => [...source, "workspace-coins"] as const,
    /** Every page of Discover's Bonding list (`BondingCurves`): rows carry each curve's launch id. */
    bonding: [ROOT, "public", "workspace-bonding"] as const,
    /** `GET /api/launchpad/market/coins/<coin type>`: the coin summary, or null when the coin is no Blast launch. */
    coinSummary: (network: string, coinType: string) => [ROOT, "public", "workspace-coin-summary", network, coinType] as const,
    /** `GET /api/launchpad/market/coins/<coin type>`: from the coin summary, the launch whose curve is the coin's current pool, or null. */
    curveLaunch: (network: string, coinType: string) => [ROOT, "public", "workspace-curve-launch", network, coinType] as const,
    curvePool: (launchId: string) => [ROOT, "public", "workspace-curve-pool", launchId] as const,
  },
  projectLinks: (network: string, coinType: string, presaleId: string | null) => [ROOT, "public", "project-links", network, coinType, presaleId] as const,

  /** `GET /api/social/happening`: the live tape, Today on Blast, the right column. */
  happening: () => [ROOT, "public", "happening"] as const,

  /** `GET /api/social/activity…`: the Blast-mode ticker's rows, by its query string. */
  activity: {
    all: [ROOT, "public", "activity"] as const,
    list: (query: string) => [ROOT, "public", "activity", query] as const,
  },

  /** `GET /api/social/trades/coins?q=<coin type>`: one coin outside any sale, by its exact type. */
  tradeCoin: (coinType: string) => [ROOT, "public", "trade-coin", coinType] as const,

  /** `GET /api/social/trades/coins?q=&cursor=`: one page of the coin picker's catalog. */
  tradeCoins: (q: string | null, cursor: string | null) => [ROOT, "public", "trade-coins", q, cursor] as const,

  /** `/api/social/presales…`: the presales list (by its query string) and one sale's public read. */
  presales: {
    all: [ROOT, "public", "presales"] as const,
    lists: [ROOT, "public", "presales", "list"] as const,
    details: [ROOT, "public", "presales", "detail"] as const,
    list: (query: string) => [ROOT, "public", "presales", "list", query] as const,
    detail: (presaleId: string) => [ROOT, "public", "presales", "detail", presaleId] as const,
  },

  /** Public profiles: the page, its tabs, the opted-in public portfolio. */
  profiles: {
    all: [ROOT, "public", "profiles"] as const,
    detail: (callsign: string) => [ROOT, "public", "profiles", callsign] as const,
    read: (callsign: string, path: string) => [ROOT, "public", "profiles", callsign, "read", path] as const,
  },

  /** `GET /api/social/search?q=`: by the normalised term. */
  search: (term: string) => [ROOT, "public", "search", term] as const,

  /**
   * `GET /api/social/prices` (R3-20): one sale's or coin's history over a
   * window (`presale:<id>` / `coin:<type>`), batched into one request per tick
   * by the price client; and a whole set read at once (Blast mode's trading
   * cards), by the ids as asked.
   */
  prices: {
    all: [ROOT, "public", "prices"] as const,
    history: (subject: string, window: string) => [ROOT, "public", "prices", "history", subject, window] as const,
    batches: [ROOT, "public", "prices", "batch"] as const,
    batch: (window: string, ids: string) => [ROOT, "public", "prices", "batch", window, ids] as const,
  },

  /**
   * The coin-centred Home's public reads (`/api/social/home…`): Discover's
   * pages by their query string, the Watchlist's items by sorted sale ids and
   * window, one coin's thread by sale and window, one coin's discussion.
   */
  home: {
    all: [ROOT, "public", "home"] as const,
    discoveries: [ROOT, "public", "home", "discover"] as const,
    coinLists: [ROOT, "public", "home", "coins"] as const,
    discover: (query: string) => [ROOT, "public", "home", "discover", query] as const,
    coins: (window: string, ids: readonly string[], holderLimit?: number) => [ROOT, "public", "home", "coins", window, sortedIds(ids), ...(holderLimit === undefined ? [] : [holderLimit])] as const,
    threads: [ROOT, "public", "home", "thread"] as const,
    /** `minUsd`: the read leaves trades proven under it out (the small-trade filter); null keeps every trade. */
    presaleTrades: (presaleId: string, minUsd: number | null) => [ROOT, "public", "home", "presale-trades", presaleId, minUsd] as const,
    thread: (presaleId: string, window: string) => [ROOT, "public", "home", "thread", presaleId, window] as const,
    discussion: (presaleId: string) => [ROOT, "public", "home", "discussion", presaleId] as const,
    traders: (window: string) => [ROOT, "public", "home", "traders", window] as const,
  },

  /**
   * The keyset feeds (FeedList, `useInfiniteQuery`), by endpoint. Owned by
   * the feed migration; listed here so a hint can name them.
   */
  feed: {
    all: [ROOT, "public", "feed"] as const,
    list: (endpoint: string) => [ROOT, "public", "feed", "list", endpoint] as const,
  },

  /**
   * Quotes (the swap and commit quote engines). Owned by the quote migration;
   * never invalidated by a hint (a quote is refreshed by its own expiry).
   */
  quotes: {
    all: [ROOT, "quotes"] as const,
    swap: (params: Readonly<Record<string, string | number | boolean | null>>) => [ROOT, "quotes", "swap", params] as const,
    commit: (params: Readonly<Record<string, string | number | boolean | null>>) => [ROOT, "quotes", "commit", params] as const,
  },

  /* ---- The viewer's own reads (private, no-store) ---- */
  me: {
    competitionRank: (slug: string, viewer: string | null) => [ROOT, "me", "competitions", "rank", slug, viewer] as const,
    invitees: (callsign: string) => [ROOT, "me", "invitees", callsign] as const,
    referrals: (callsign: string) => [ROOT, "me", "referrals", callsign] as const,
    referralMonths: (callsign: string) => [ROOT, "me", "referrals", callsign, "months"] as const,
    all: [ROOT, "me"] as const,
    /** `GET /api/social/me/following/wallets`: the followed wallets a tab filters buy hints by, per account. */
    followingWallets: (accountId?: string) => (accountId === undefined ? ([ROOT, "me", "following-wallets"] as const) : ([ROOT, "me", "following-wallets", accountId] as const)),
    connections: {
      all: [ROOT, "me", "connections"] as const,
      counts: (callsign: string, scope: string) => [ROOT, "me", "connections", scope, callsign, "counts"] as const,
      list: (callsign: string, scope: string, tab: string, q: string) => [ROOT, "me", "connections", scope, callsign, tab, q] as const,
    },
    /** `GET /api/social/me`: the account, per signed-in identity (a Privy user id, or "wallet"). */
    account: (identity?: string) => (identity === undefined ? ([ROOT, "me", "account"] as const) : ([ROOT, "me", "account", identity] as const)),
    /**
     * `POST /api/social/viewer-state`: the viewer-state store's per-id answers
     * (follows, reactions, followed backers, "follows you"), under the viewer's
     * scope (callsign): `[…, scope, kind, id]`. The store batches the reads.
     */
    marketBuyers: (scope: string, ids: readonly string[]) => [ROOT, "me", "market-buyers", scope, sortedIds(ids)] as const,
    viewerState: (scope: string) => [ROOT, "me", "viewer-state", scope] as const,
    /** `POST /api/social/presales/viewer`: the viewer's position in each sale, by sorted presale ids. */
    presaleViewer: (presaleIds: readonly string[]) => [ROOT, "me", "presale-viewer", sortedIds(presaleIds)] as const,
    presaleViewerAll: [ROOT, "me", "presale-viewer"] as const,
    /** `GET /api/presale/presales/{id}/proof?wallet=`: the wallet's allowlist leaf for one sale. */
    allowlistLeaf: (presaleId: string, wallet: string) => [ROOT, "me", "allowlist-leaf", presaleId, wallet] as const,
    /**
     * `POST /api/social/me/home/following`: the viewer's Following source by
     * window, the followed participation of sales on screen, and one sale's
     * followed-only thread, under the viewer's scope (callsign).
     */
    home: {
      all: [ROOT, "me", "home"] as const,
      following: (scope: string, window: string, page: number, limit: number) => [ROOT, "me", "home", scope, "following", window, page, limit] as const,
      preview: (scope: string, window: string, ids: readonly string[]) => [ROOT, "me", "home", scope, "preview", window, sortedIds(ids)] as const,
      thread: (scope: string, presaleId: string, window: string) => [ROOT, "me", "home", scope, "thread", presaleId, window] as const,
      tape: (scope: string, window: string) => [ROOT, "me", "home", scope, "tape", window] as const,
    },
    /** `GET /api/social/me/settings`. */
    settings: (accountId?: string, principal?: string) => [ROOT, "me", "settings", ...(accountId ? [accountId] : []), ...(principal !== undefined ? [principal] : [])] as const,
    /** `GET /api/social/me/wallet`: balances (USDC, SUI, sale coins). */
    walletListing: (params: Readonly<Record<string, string | number | boolean>>) => [ROOT, "me", "wallet", params] as const,
    wallet: () => [ROOT, "me", "wallet"] as const,
    walletBalances: [ROOT, "me", "wallet", "balance"] as const,
    /** One coin's balance in one wallet on one network; under `wallet()`, so every balance invalidation reaches it. */
    walletBalance: (network: string, address: string, coinType?: string) => [ROOT, "me", "wallet", "balance", network, address, ...(coinType === undefined ? [] : [coinType])] as const,
    walletIdentity: (viewer: string) => [ROOT, "me", "wallet", "identity", viewer] as const,
    /** `GET /api/social/me/portfolio`: the gold card, positions, P&L. */
    portfolio: () => [ROOT, "me", "portfolio"] as const,
    /** PnL since launch shares the portfolio prefix so completed transactions invalidate it. */
    portfolioRead: (workspaceScope?: string, summary = true) => [ROOT, "me", "portfolio", ...(workspaceScope ? ["workspace", workspaceScope] : []), ...(summary ? [] : ["holdings"])] as const,
    portfolioHistory: (range: string) => [ROOT, "me", "portfolio", "history", range] as const,
    pnl: () => [ROOT, "me", "portfolio", "pnl"] as const,
    portfolioCoins: (page: number, search: string, hideSmall = false) => [ROOT, "me", "portfolio", "coins", page, search, hideSmall] as const,
    creatorEarnings: () => [ROOT, "me", "creator-earnings"] as const,
    /** `GET /api/social/me/creator-commitment` (LP-16): the account's creator commitment; it never changes. */
    creatorCommitment: () => [ROOT, "me", "creator-commitment"] as const,
    /** `GET /api/social/me/rewards` (OA-45): the summary with the latest payouts, and each coin's payout pages. */
    rewards: {
      all: [ROOT, "me", "rewards"] as const,
      summary: () => [ROOT, "me", "rewards", "summary"] as const,
      coin: (presaleId: string) => [ROOT, "me", "rewards", "coin", presaleId] as const,
    },
    /** `GET /api/social/me/presales`: the sales the viewer is in. */
    presales: (positionsOnly = false) => positionsOnly ? ([ROOT, "me", "presales", "positions"] as const) : ([ROOT, "me", "presales"] as const),
    createdPresales: () => [ROOT, "me", "presales", "created"] as const,
    /** `GET /api/social/me/transactions?limit=`. */
    transactions: {
      all: [ROOT, "me", "transactions"] as const,
      list: (limit: number) => [ROOT, "me", "transactions", limit] as const,
    },
    /** Notifications: the unread count and the pages. */
    notifications: {
      all: [ROOT, "me", "notifications"] as const,
      unread: () => [ROOT, "me", "notifications", "unread"] as const,
      arrivals: () => [ROOT, "me", "notifications", "arrivals"] as const,
      page: (cursor: string | null) => [ROOT, "me", "notifications", "page", cursor] as const,
    },
    /** The watchlist: the saved keys and the saved sales' page. */
    watchlist: {
      all: [ROOT, "me", "watchlist"] as const,
      pages: [ROOT, "me", "watchlist", "page"] as const,
      keys: () => [ROOT, "me", "watchlist", "keys"] as const,
      page: (query: string) => [ROOT, "me", "watchlist", "page", query] as const,
    },
    /** `GET /api/social/me/profile`: the profile editor's read. */
    profileEdit: () => [ROOT, "me", "profile-edit"] as const,
    /** `GET /api/social/profiles/:callsign/mutuals` (signed-in). */
    mutuals: (callsign: string) => [ROOT, "me", "mutuals", callsign] as const,
    /** Claims the viewer can make (Blast mode's dock). */
    claims: () => [ROOT, "me", "claims"] as const,
    /** A sale's read with the viewer's credentials (the commit sheet's). */
    commitSale: (presaleId: string) => [ROOT, "me", "commit-sale", presaleId] as const,
    /** `GET /api/social/sales/:id/metadata` (R3-28): the sale's metadata and whether this viewer may edit it. */
    saleMetadata: (presaleId: string) => [ROOT, "me", "sale-metadata", presaleId] as const,
  },
} as const;

/** Query predicates live beside the key shapes they inspect. */
export function isCommitQuoteFor(queryKey: QueryKey, viewer: string | null): boolean {
  return partialMatchKey(queryKey, queryKeys.quotes.commit({ viewer }));
}

export function isPortfolioCoinsFilter(queryKey: QueryKey, search: string, hideSmall: boolean): boolean {
  const [, , , kind, , keySearch, keyHideSmall] = queryKey;
  return partialMatchKey(queryKey, queryKeys.me.portfolio()) && kind === "coins" && keySearch === search && keyHideSmall === hideSmall;
}
