import type {
  HomeWire,
  homeAmountSchema,
  homeSideSchema,
  homeEventSchema,
  homeParticipantSchema,
  homeActivitySchema,
  homeCoinSchema,
  homeCoinsPageSchema,
  homeCoinsByIdsSchema,
  homeThreadPageSchema,
  homeDiscussionPageSchema,
  homeFollowingRequestSchema,
  homeTapeEventSchema,
  homeHolderSchema,
  homeTraderCoinSchema,
  homeTraderSchema,
  homeTradersPageSchema,
  homeFollowingResponseSchema,
  homeActivityStreamEventSchema,
  homeActivityStreamPageSchema,
} from "./home-schemas.ts";
import { z } from "zod";

import type { FeedItemActor } from "@blast/core/modules/social/contracts/items.ts";

/**
 * The coin-centred Home: one item per canonical coin (a Blast sale's coin or
 * a standalone Cetus/Bluefin vault coin, keyed by its presale or coin type), its market facts, and the
 * confirmed activity beneath it grouped by participant. Public reads on
 * the replica through `chain_read_v1` views, and one viewer read on the
 * primary for the Following source.
 *
 * - `GET /api/social/home?window=&sort=&page=&limit=&min_participants=&age=&tradable=`:
 *   Discover, one page of coins (`page` is 1-based over the ranked list;
 *   `limit` rows per page; the answer carries `page`, `pages` and `total`;
 *   `cursor=` still names a keyset page for older readers). JSON Schema
 *   `schemas/home-coins-page.schema.json`.
 * - `GET /api/social/home/coins?presale=…&window=`: the same items for up to
 *   `HOME_COINS_MAX_IDS` sales (the Watchlist), in the order asked, with the
 *   ids the web does not show listed under `missing`. A `presale` value may
 *   also be a bonding-curve coin's type (a saved curve coin). `holder_limit` defaults to 10;
 *   a single sale can request up to 100. `pool_volumes` excludes commits and claims.
 * - `GET /api/social/home/activity?presale=|coin=&window=&cursor=`: the thread under
 *   one presale (`presale`) or curve coin (`coin`, its type): participants grouped by identity, each with its
 *   totals per direction and its newest underlying events. Schema
 *   `schemas/home-thread-page.schema.json`.
 * - `GET /api/social/home/activity-stream?window=&cursor=&limit=`: public
 *   indexed buys, sells and commitments across shown canonical assets, with
 *   frozen keyset bounds. Schema `schemas/home-activity-stream-page.schema.json`.
 * - `GET /api/social/home/discussion?presale=&cursor=&limit=`: the sale's
 *   posts that carry an authored why, newest first, as feed items. Schema
 *   `schemas/home-discussion-page.schema.json`.
 * - `POST /api/social/me/home/following`: the signed-in viewer's Following
 *   source (`mode: "coins"`), the followed participation of coins on screen
 *   (`"preview"`), or the followed-only thread of one coin (`"thread"`).
 *   Account required, `private, no-store`, read on the primary. Schemas
 *   `schemas/home-following-request.schema.json` and
 *   `schemas/home-following-response.schema.json`.
 *
 * Every public answer is the same for every caller (a token changes nothing)
 * and a 200 is publicly cached (`public, s-maxage=10, stale-while-revalidate=20`).
 * Every read is bounded by the watermark: trades up to the market pipeline's
 * committed checkpoint, presale kinds up to the presale pipeline's, and
 * nothing after the chain clock (`clock_ms`, the earlier of the pipelines'
 * committed time and the server's clock). Without a readable watermark a
 * read is `503 service_unavailable`.
 *
 * **Coverage.** Activity is `chain_read_v1.activity`: a sale's commits and
 * claims, and its coin's trades on every venue and route (blast-infra reads a
 * sale coin's trades from each transaction's balance changes, not from one
 * pool's events). A standalone vault coin's trades are its registered pool's
 * only, so its `rank.why` says "in its pool". A transaction that leaves the
 * sender's balance of the coin unchanged is no trade.
 *
 * **Identity.** A participant is one account when the naming rule
 * (`read-model/naming.ts`) names the wallet at the event's time — a public,
 * sharing account that linked the wallet before the event — and otherwise the
 * wallet itself. Two wallets of one named account are one participant; two
 * unlinked wallets are two participants, and nothing claims they are two
 * people. A private account's wallets stay wallets.
 *
 * **Amounts.** Atoms as decimal strings, exact; one `HomeAmount` per quote
 * asset, never summed across assets; USD only as the indexer priced each row
 * (`usd_complete` says whether every row was priced). A missing price is
 * null, never 0.
 */

export const SOCIAL_HOME_ROUTE = "GET /api/social/home";
export const SOCIAL_HOME_PATH = "/api/social/home";
export const SOCIAL_HOME_COINS_ROUTE = "GET /api/social/home/coins";
export const SOCIAL_HOME_COINS_PATH = "/api/social/home/coins";
export const SOCIAL_HOME_ACTIVITY_ROUTE = "GET /api/social/home/activity";
export const SOCIAL_HOME_ACTIVITY_PATH = "/api/social/home/activity";
export const SOCIAL_HOME_DISCUSSION_ROUTE = "GET /api/social/home/discussion";
export const SOCIAL_HOME_DISCUSSION_PATH = "/api/social/home/discussion";
export const SOCIAL_HOME_FOLLOWING_ROUTE = "POST /api/social/me/home/following";
export const SOCIAL_HOME_FOLLOWING_PATH = "/api/social/me/home/following";

export const HOME_MOBILE_MARKET_PARAM = "mobile_market";
export const HOME_ROLLING_CHANGE_PARAM = "rolling_change";
export const HOME_DEX_VOLUME_PARAM = "dex_volume";

/** Keep the original response shape for clients that did not request mobile market figures. */
export function withHomeMobileMarket(path: string, liveInputs = false): string {
  return `${path}${path.includes("?") ? "&" : "?"}${HOME_MOBILE_MARKET_PARAM}=1${liveInputs ? "&live_inputs=1" : ""}`;
}

/** Home requests market fields and labeled shorter comparisons on its existing reads. */
export function withHomeMarketDetails(path: string): string {
  return `${withHomeMobileMarket(path, true)}&${HOME_DEX_VOLUME_PARAM}=1&${HOME_ROLLING_CHANGE_PARAM}=1`;
}

export const HOME_RECENT_BUYS_PARAM = "recent_buys";
export const HOME_RECENT_BUY_MS = 30_000;

/** Opt into confirmed buy details on the same Discover read. */
export function withHomeDiscoverDetails(path: string): string {
  return `${withHomeMarketDetails(path)}&${HOME_RECENT_BUYS_PARAM}=1`;
}

/** The activity window every count, total and preview is scoped to. */
export const HOME_WINDOWS = ["1h", "24h"] as const;
export type HomeWindow = (typeof HOME_WINDOWS)[number];
export const HOME_DEFAULT_WINDOW: HomeWindow = "24h";
export const HOME_WINDOW_MS: Readonly<Record<HomeWindow, number>> =
  Object.freeze({ "1h": 3_600_000, "24h": 86_400_000 });

export const homeWindowSchema = z.enum(HOME_WINDOWS);

export function isHomeWindow(value: unknown): value is HomeWindow {
  return homeWindowSchema.safeParse(value).success;
}

/**
 * Discover's orders. `relevant` is the documented rule-based score
 * (`home/rank.ts`); `trending` is the most distinct participants in the
 * window; `newest` is the latest launch; `held` is the most holders now
 * (`HomeCoin.holders`, blast-infra's count; a coin without one comes last),
 * the redesign's "Most held". Market cap is not offered: the chain views
 * carry no supply, so no order over every coin could be true.
 */
export const HOME_SORTS = ["relevant", "trending", "newest", "held"] as const;
export type HomeSort = (typeof HOME_SORTS)[number];
export const HOME_DEFAULT_SORT: HomeSort = "relevant";

export const homeSortSchema = z.enum(HOME_SORTS);

export function isHomeSort(value: unknown): value is HomeSort {
  return homeSortSchema.safeParse(value).success;
}

/** The launch-age filter: coins that started trading within the period, or every coin. */
export const HOME_AGES = ["24h", "7d", "30d", "all"] as const;
export type HomeAge = (typeof HOME_AGES)[number];
export const HOME_AGE_MS: Readonly<Record<HomeAge, number | null>> =
  Object.freeze({
    "24h": 86_400_000,
    "7d": 7 * 86_400_000,
    "30d": 30 * 86_400_000,
    all: null,
  });

export const homeAgeSchema = z.enum(HOME_AGES);

export function isHomeAge(value: unknown): value is HomeAge {
  return homeAgeSchema.safeParse(value).success;
}

/** The sources of Home. Each chooses what qualifies; the sort orders; the window scopes the counts. */
export const HOME_SOURCES = ["discover", "following", "watchlist"] as const;
export type HomeSource = (typeof HOME_SOURCES)[number];

export const homeSourceSchema = z.enum(HOME_SOURCES);

export function isHomeSource(value: unknown): value is HomeSource {
  return homeSourceSchema.safeParse(value).success;
}

/** Page sizes: coins per page (the reader picks 5, 10, 20, 50 or any count up to the max), and participants per thread page. */
export const HOME_PAGE_DEFAULT = 10;
export const HOME_PAGE_MAX = 50;
export const HOME_ROWS_CHOICES = [5, 10, 20] as const;
/** The furthest page a reader may ask for (`invalid_parameter` beyond it). */
export const HOME_PAGE_LAST = 9_999;
export const HOME_THREAD_PAGE = 20;
/** The most sales one `GET /api/social/home/coins` or one Following preview names. */
export const HOME_COINS_MAX_IDS = 50;
/** Preview rows a coin carries (the card shows two; the third lets a seller stay visible). */
export const HOME_PREVIEW_ROWS = 3;
/** The points a card's 24 h sparkline reads (`price_history`, thinned evenly). */
export const HOME_SPARK_POINTS = 48;
/** Underlying events a thread participant carries inline; `events_more` says there are more in the window. */
export const HOME_PARTICIPANT_EVENTS = 10;
/** The most participants the Following source reads per coin before paging (bounded by the follow limit). */
export const HOME_MIN_PARTICIPANTS_MAX = 10_000;

/** The activity kinds a thread groups. Claims and commits stay their own directions, never buys. */
export const HOME_KINDS = [
  "trade_buy",
  "trade_sell",
  "presale_commit",
  "presale_claim",
] as const;
export type HomeKind = (typeof HOME_KINDS)[number];

/** A Discover cursor: `<score>:<latest_ms>:<coin_type>` as `encodeHomeCursor` writes it. */
export const HOME_CURSOR_MAX_LENGTH = 400;

/** One asset's total: atoms exact, USD as priced. */
export type HomeAmount = HomeWire<z.infer<typeof homeAmountSchema>>;

/** One direction of one participant (or of a whole coin) in the window. */
export type HomeSide = HomeWire<NonNullable<z.infer<typeof homeSideSchema>>>;

/** One confirmed event, as the thread lists it under its participant. */
export type HomeEvent = HomeWire<z.infer<typeof homeEventSchema>>;

/** A participant's relationship to the viewer, present only in viewer-scoped answers. */
export type HomeRelation = "followed";

/** One participant of a coin in the window: an account or a wallet, with its directions kept apart. */
export type HomeParticipant = HomeWire<z.infer<typeof homeParticipantSchema>>;

/** What the window holds for one coin or presale: the counts the card states and the totals per direction. */
export type HomeActivity = HomeWire<z.infer<typeof homeActivitySchema>>;

/** Why a coin is on the page: the rule that admitted it and the inputs its rank used. */
export type HomeRank = HomeCoin["rank"];

export type HomeCoin = HomeWire<z.infer<typeof homeCoinSchema>>;

export type HomeDexVolume = NonNullable<HomeCoin["dex_volume"]>;

export type HomeCoinsPage = HomeWire<z.infer<typeof homeCoinsPageSchema>>;

export type HomeRecentBuy = NonNullable<HomeCoinsPage["recent_buys"]>[number];

export type HomeCoinsByIds = HomeWire<z.infer<typeof homeCoinsByIdsSchema>>;

export type HomeThreadPage = HomeWire<z.infer<typeof homeThreadPageSchema>>;

export type HomeDiscussionPage = HomeWire<
  z.infer<typeof homeDiscussionPageSchema>
>;

export type HomeFollowingRequest = HomeWire<
  z.infer<typeof homeFollowingRequestSchema>
>;

/** The tape's line: one event by a followed account, with who did it and on which coin. */
export type HomeTapeEvent = HomeWire<z.infer<typeof homeTapeEventSchema>>;

/** How many holders a coin's row and card name. */
export const HOME_TOP_HOLDERS = 10;
/** Presale details may request up to 100 ranked holders for client-side pagination. */
export const HOME_MAX_HOLDERS = 100;

/** One holder: an account (its wallets summed) or a wallet, its balance in atoms, and its share of the total supply in basis points (null without the supply). */
export type HomeHolder = HomeWire<z.infer<typeof homeHolderSchema>>;

export type HomeTopHolders = HomeCoin["top_holders"];

/** How many lines the tape carries: the newest events by people the viewer follows, across every coin. */
export const HOME_TAPE_LIMIT = 12;

/** Default page size, never a cap on leaderboard eligibility. */
export const HOME_TRADERS_LIMIT = 5;
export type HomeTradersQuery = Readonly<{
  search: string;
  page: number;
  limit: number;
}>;
export const HOME_TRADERS_DEFAULT_QUERY: HomeTradersQuery = {
  search: "",
  page: 1,
  limit: HOME_TRADERS_LIMIT,
};
export const SOCIAL_HOME_TRADERS_ROUTE = "GET /api/social/home/traders";
export const SOCIAL_HOME_TRADERS_PATH = "/api/social/home/traders";
export function socialHomeTradersPath(
  window: HomeWindow,
  query: HomeTradersQuery = HOME_TRADERS_DEFAULT_QUERY,
): string {
  const params = new URLSearchParams({
    window,
    page: String(query.page),
    limit: String(query.limit),
  });
  if (query.search) params.set("search", query.search);
  return `${SOCIAL_HOME_TRADERS_PATH}?${params}`;
}

/** How many of a trader's coins the section carries (newest first); `coins_total` counts them all. */
export const HOME_TRADER_COINS = 12;

/** One coin a trader touched in the window: its identity and the trader's directions in it, kept apart. */
export type HomeTraderCoin = HomeWire<z.infer<typeof homeTraderCoinSchema>>;

/**
 * A trader's portfolio and P&L (the owner's "traders should emphasise PnL
 * and current portfolio"), by the one cost-basis rule every surface uses
 * (`portfolio/cost-basis.ts`): shown only where the account chose a public
 * portfolio; null figures otherwise, and null where a price is stale or a
 * basis is unknown. All-time, whatever the window.
 */
/** Indexed liquid launch-token balances, never inferred from recent activity. */
export type HomeTraderHolding = NonNullable<HomeTrader["holdings"]>[number];

export type HomeTraderPortfolio = HomeTrader["portfolio"];

/** One trader: an account's participation across every shown coin in the window (the sides summed across coins), its portfolio, and the coins it touched. */
export type HomeTrader = HomeWire<z.infer<typeof homeTraderSchema>>;

export type HomeTradersPage = HomeWire<z.infer<typeof homeTradersPageSchema>>;

export type HomeFollowingResponse = HomeWire<
  z.infer<typeof homeFollowingResponseSchema>
>;

/** The home page's query string, as the route and the page both parse it. */
export type HomeQuery = Readonly<{
  window: HomeWindow;
  sort: HomeSort;
  /** Only coins with at least this many distinct participants in the window (0: every coin). */
  minParticipants: number;
  age: HomeAge;
  /** Only coins that trade in the app. */
  tradable: boolean;
  limit: number;
  /** The page asked for, 1-based; ignored behind a cursor. */
  page: number;
  cursor: string | null;
  /** Also answer `ranked` (`ranked=1`). Only Blast mode Discover asks, so a client loaded before the field never receives it. */
  ranked?: boolean;
}>;

export const HOME_DEFAULT_QUERY: HomeQuery = Object.freeze({
  window: HOME_DEFAULT_WINDOW,
  sort: HOME_DEFAULT_SORT,
  minParticipants: 0,
  age: "all",
  tradable: false,
  limit: HOME_PAGE_DEFAULT,
  page: 1,
  cursor: null,
});

/** The Discover path for a query, with defaults left out so equal views share one URL. */
export function socialHomePath(query: Partial<HomeQuery>): string {
  const params = new URLSearchParams();
  if (query.window !== undefined && query.window !== HOME_DEFAULT_WINDOW)
    params.set("window", query.window);
  if (query.sort !== undefined && query.sort !== HOME_DEFAULT_SORT)
    params.set("sort", query.sort);
  if (query.minParticipants !== undefined && query.minParticipants > 0)
    params.set("min_participants", String(query.minParticipants));
  if (query.age !== undefined && query.age !== "all")
    params.set("age", query.age);
  if (query.tradable) params.set("tradable", "1");
  if (query.limit !== undefined && query.limit !== HOME_PAGE_DEFAULT)
    params.set("limit", String(query.limit));
  setPageParams(params, query);
  const text = params.toString();
  return text ? `${SOCIAL_HOME_PATH}?${text}` : SOCIAL_HOME_PATH;
}

/** The page, cursor and `ranked` flag, last in `socialHomePath`'s order. */
function setPageParams(params: URLSearchParams, query: Partial<HomeQuery>) {
  if (query.page !== undefined && query.page > 1)
    params.set("page", String(query.page));
  if (query.cursor) params.set("cursor", query.cursor);
  if (query.ranked) params.set("ranked", "1");
}

/** `GET /api/social/home/coins` for these sales (order kept). */
export function socialHomeCoinsPath(
  presaleIds: readonly string[],
  window: HomeWindow,
  holderLimit?: number,
): string {
  const params = new URLSearchParams();
  for (const id of presaleIds) params.append("presale", id);
  if (window !== HOME_DEFAULT_WINDOW) params.set("window", window);
  if (holderLimit !== undefined)
    params.set("holder_limit", String(holderLimit));
  return `${SOCIAL_HOME_COINS_PATH}?${params.toString()}`;
}

/** `GET /api/social/home/activity` for one coin: a sale's by its presale id, a curve coin's by its type. */
export function socialHomeActivityPath(
  coinKey: string,
  window: HomeWindow,
  cursor: string | null = null,
  at?: number,
  exactTradeUsd = false,
): string {
  const params = new URLSearchParams(coinKey.includes("::") ? { coin: coinKey } : { presale: coinKey });
  if (window !== HOME_DEFAULT_WINDOW) params.set("window", window);
  if (cursor) params.set("cursor", cursor);
  if (exactTradeUsd) params.set("exact_trade_usd", "1");
  if (at !== undefined) params.set("at", String(at));
  return `${SOCIAL_HOME_ACTIVITY_PATH}?${params.toString()}`;
}

/** `GET /api/social/home/discussion` for one sale. */
export function socialHomeDiscussionPath(
  presaleId: string,
  cursor: string | null = null,
): string {
  const params = new URLSearchParams({ presale: presaleId });
  if (cursor) params.set("cursor", cursor);
  return `${SOCIAL_HOME_DISCUSSION_PATH}?${params.toString()}`;
}

/** A participant's key: an account by callsign, a wallet by address. */
export function homeParticipantKey(actor: FeedItemActor): string {
  return actor.type === "account"
    ? `c:${actor.callsign}`
    : `w:${actor.address}`;
}

/** Public, available P&L is required to appear in the homepage leaderboard. */
export function hasPublicPnl(trader: HomeTrader): boolean {
  return (
    (trader.performance_public ?? trader.portfolio.public) &&
    trader.portfolio.pnl_usd !== null
  );
}

/** Public cross-asset indexed actions. This is separate from the grouped Home thread. */
export const SOCIAL_HOME_ACTIVITY_STREAM_ROUTE =
  "GET /api/social/home/activity-stream";
export const SOCIAL_HOME_ACTIVITY_STREAM_PATH =
  "/api/social/home/activity-stream";
export const HOME_ACTIVITY_STREAM_KINDS = [
  "trade_buy",
  "trade_sell",
  "presale_commit",
] as const;
export type HomeActivityStreamKind =
  (typeof HOME_ACTIVITY_STREAM_KINDS)[number];
export type HomeActivityStreamEvent = HomeWire<
  z.infer<typeof homeActivityStreamEventSchema>
>;
export type HomeActivityStreamPage = HomeWire<
  z.infer<typeof homeActivityStreamPageSchema>
>;
