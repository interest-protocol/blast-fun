import {
  HOME_DEFAULT_QUERY,
  HOME_PAGE_DEFAULT,
  HOME_PAGE_LAST,
  isHomeAge,
  isHomeSort,
  isHomeSource,
  isHomeStage,
  isHomeWindow,
  type HomeAge,
  type HomeQuery,
  type HomeSort,
  type HomeSource,
  type HomeStage,
  type HomeWindow,
} from "@blast/core/web/contracts/home.ts";

/**
 * Home's view state and its URL (the brief's §14): the source chooses what
 * qualifies, the stage narrows Discover to a tab's coins, the sort orders, the filters narrow, the window scopes every
 * count, the page says which rows of the list. Nothing personal goes in
 * the URL: a source name, a stage, a sort, a window, three filters and a page
 * number, each left out at its default so equal views share one address.
 * An unknown value reads as the default, never as an error, so a stale
 * link still opens Home. The rows per page are the device's (a cookie,
 * `home-rows.ts`), not the URL's.
 */
export type HomeViewState = Readonly<{
  source: HomeSource;
  /** Which coins Discover lists: every coin, curves at 60% or more, or coins on a DEX. */
  stage: HomeStage;
  sort: HomeSort;
  window: HomeWindow;
  minParticipants: number;
  age: HomeAge;
  tradable: boolean;
  /** The list's page, 1-based. */
  page: number;
}>;

export const HOME_DEFAULT_VIEW: HomeViewState = Object.freeze({
  source: "discover",
  stage: "all",
  sort: "held",
  window: "1h",
  minParticipants: 0,
  age: "all",
  tradable: false,
  page: 1,
});

/** Home opens on Trending (sort key `relevant`): the blended score of traders, net inflow, volume, new holders, recency and holders (`home/rank.ts`). */
export const HOME_DEFAULT_FEED: HomeViewState = Object.freeze({ ...HOME_DEFAULT_VIEW, sort: "relevant" });

/** The minimum-participants choices the filter offers. */
export const MIN_PARTICIPANT_CHOICES = [0, 2, 5, 10] as const;

/** The URL's names: short, stable, nothing a reader would mistake for data. */
const KEYS = { source: "src", stage: "stage", sort: "sort", window: "w", minParticipants: "min", age: "age", tradable: "tradable", page: "page" } as const;

export function hasHomeViewSearch(params: URLSearchParams): boolean {
  return Object.values(KEYS).some((key) => params.has(key));
}

/** A page number out of the URL: 1 for anything that is not an integer from 1 to `HOME_PAGE_LAST`. */
function pageOf(raw: string | null): number {
  if (raw === null || !/^[1-9][0-9]{0,3}$/.test(raw)) return 1;
  const value = Number(raw);
  return value <= HOME_PAGE_LAST ? value : 1;
}

export function viewStateOf(params: URLSearchParams): HomeViewState {
  const source = params.get(KEYS.source);
  const rawStage = params.get(KEYS.stage);
  const stage = isHomeStage(rawStage) ? rawStage : "all";
  const sort = params.get(KEYS.sort);
  const window = params.get(KEYS.window);
  const age = params.get(KEYS.age);
  const min = params.get(KEYS.minParticipants);
  const minParticipants = min !== null && /^[0-9]{1,4}$/.test(min) && (MIN_PARTICIPANT_CHOICES as readonly number[]).includes(Number(min)) ? Number(min) : 0;
  const filters = {
    window: isHomeWindow(window) ? window : HOME_DEFAULT_VIEW.window,
    minParticipants,
    age: isHomeAge(age) ? age : HOME_DEFAULT_VIEW.age,
    tradable: params.get(KEYS.tradable) === "1",
  };
  const page = pageOf(params.get(KEYS.page));
  return {
    source: isHomeSource(source) ? source : HOME_DEFAULT_VIEW.source,
    stage,
    sort: isHomeSort(sort) ? sort : impliedSort(stage, hasRankedQueryFields({ ...filters, page })),
    ...filters,
    page,
  };
}

/**
 * The order a link without `sort` means: the stage's own order, except that
 * older ranked links on every coin omitted `sort=held`, including links to
 * later pages.
 */
function impliedSort(stage: HomeStage, ranked: boolean): HomeSort {
  return stage === "all" && ranked ? HOME_DEFAULT_VIEW.sort : stageDefaultSort(stage);
}

/** The query string of a view state, `""` for the default view. */
export function viewSearchOf(state: HomeViewState): string {
  const params = new URLSearchParams();
  if (state.source !== HOME_DEFAULT_VIEW.source) params.set(KEYS.source, state.source);
  if (state.stage !== "all") params.set(KEYS.stage, state.stage);
  if (state.sort !== impliedSort(state.stage, hasRankedQueryFields(state))) params.set(KEYS.sort, state.sort);
  if (state.window !== HOME_DEFAULT_VIEW.window) params.set(KEYS.window, state.window);
  if (state.minParticipants !== 0) params.set(KEYS.minParticipants, String(state.minParticipants));
  if (state.age !== "all") params.set(KEYS.age, state.age);
  if (state.tradable) params.set(KEYS.tradable, "1");
  if (state.page > 1) params.set(KEYS.page, String(state.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

function hasRankedQueryFields(state: Pick<HomeViewState, "age" | "minParticipants" | "tradable" | "page" | "window">): boolean {
  return state.page > 1 || activeFilterCount(state) > 0 || state.window !== HOME_DEFAULT_VIEW.window;
}

/** Whether two states show the same list apart from its page (a new list starts on page 1; see `withView`). */
export function sameListView(a: HomeViewState, b: HomeViewState): boolean {
  return a.source === b.source && a.stage === b.stage && a.sort === b.sort && a.window === b.window && a.minParticipants === b.minParticipants && a.age === b.age && a.tradable === b.tradable;
}

/** The next state for a change: any change but the page itself starts the list on page 1. */
export function withView(current: HomeViewState, next: HomeViewState): HomeViewState {
  return sameListView(current, next) ? next : { ...next, page: 1 };
}

/**
 * The Discover read a view state asks for, at the device's rows per page.
 * Home's Trending lists presales next to coins, upcoming ones too
 * (`presales`); the path sends the flag on Trending only, so the other tabs'
 * URLs are unchanged. The server render and the browser both build here, so
 * they ask for the same URL.
 */
export function discoverQueryOf(state: HomeViewState, rows: number = HOME_PAGE_DEFAULT): HomeQuery {
  return { ...HOME_DEFAULT_QUERY, stage: state.stage, sort: state.sort, window: state.window, minParticipants: state.minParticipants, age: state.age, tradable: state.tradable, limit: rows, page: state.page, presales: true };
}

/** How many filters are away from their default (the Filters button's badge). */
export function activeFilterCount(state: Pick<HomeViewState, "age" | "minParticipants" | "tradable">): number {
  return (state.minParticipants !== 0 ? 1 : 0) + (state.age !== "all" ? 1 : 0) + (state.tradable ? 1 : 0);
}

/** Whether the sort and the filters apply: Discover only (Following and the Watchlist have their own order). */
export function controlsApply(source: HomeSource): boolean {
  return source === "discover";
}

/** The four orders Blast mode offers; Home's own list is the tabs below and the column headers. */
export const HOME_VIEW_SORTS = ["relevant", "trending", "newest", "held"] as const satisfies readonly HomeSort[];
export type HomeViewSort = (typeof HOME_VIEW_SORTS)[number];
export const isHomeViewSort = (sort: HomeSort): sort is HomeViewSort => (HOME_VIEW_SORTS as readonly HomeSort[]).includes(sort);
export const SORT_LABELS: Readonly<Record<HomeSort, string>> = { relevant: "Trending", trending: "Volume", newest: "Newest", held: "Most held", progress: "Progress", market_cap: "Market cap", last_trade: "Last trade" };
/** Blast mode's names: its Trending tab is the Volume order, so the blended score keeps the name Relevant there. */
export const BLAST_MODE_SORT_LABELS: Readonly<Record<HomeSort, string>> = { ...SORT_LABELS, relevant: "Relevant" };
/**
 * Home's five coin tabs (plan decision 1): each is a stage and the order it
 * opens on. Trending is the blended score (URL key `relevant`).
 */
export const HOME_TABS = {
  trending: { label: "Trending", stage: "all", sort: "relevant" },
  new: { label: "New", stage: "all", sort: "newest" },
  almost: { label: "Almost graduated", stage: "almost", sort: "progress" },
  graduated: { label: "Graduated", stage: "graduated", sort: "market_cap" },
  last: { label: "Last trade", stage: "all", sort: "last_trade" },
} as const satisfies Record<string, Readonly<{ label: string; stage: HomeStage; sort: HomeSort }>>;
export type HomeTab = keyof typeof HOME_TABS;
export const HOME_TAB_KEYS = Object.keys(HOME_TABS) as HomeTab[];

/** The order a stage opens on, and the order a column header returns to when pressed again. */
export function stageDefaultSort(stage: HomeStage): HomeSort {
  if (stage === "almost") return "progress";
  if (stage === "graduated") return "market_cap";
  return HOME_DEFAULT_FEED.sort;
}

/** The selected tab: a narrowed stage is its tab whatever the column order; on every coin, the tab whose order is shown, or none when a column header reorders the list. */
export function tabOf(state: Pick<HomeViewState, "stage" | "sort">): HomeTab | null {
  return HOME_TAB_KEYS.find((key) => HOME_TABS[key].stage === state.stage && (state.stage !== "all" || HOME_TABS[key].sort === state.sort)) ?? null;
}

/** The orders a column header can pick, within any tab: market cap, volume, holders. */
export type HeaderSort = Extract<HomeSort, "market_cap" | "trending" | "held">;

export const WINDOW_LABELS: Readonly<Record<HomeWindow, string>> = { "1h": "1h", "24h": "24h" };
export const AGE_LABELS: Readonly<Record<HomeAge, string>> = { "24h": "Last 24h", "7d": "Last 7 days", "30d": "Last 30 days", all: "Any time" };
export const SOURCE_LABELS: Readonly<Record<HomeSource, string>> = { discover: "Discover", following: "Following", watchlist: "Watchlist" };

/** The spoken summary after a change: `Discover · Almost graduated · 12 coins · page 2 of 3 · sorted by Progress · last 24 hours`. */
export function resultsAnnouncement(state: Pick<HomeViewState, "source" | "stage" | "page" | "sort" | "window">, count: number | null, pages = 1): string {
  const parts = [SOURCE_LABELS[state.source]];
  if (controlsApply(state.source) && state.stage !== "all") parts.push(HOME_TABS[state.stage].label);
  if (count !== null) parts.push(`${count.toLocaleString("en-US")} ${count === 1 ? "coin" : "coins"}`);
  if (pages > 1) parts.push(`page ${state.page.toLocaleString("en-US")} of ${pages.toLocaleString("en-US")}`);
  if (controlsApply(state.source)) parts.push(`sorted by ${SORT_LABELS[state.sort]}`);
  parts.push(state.window === "1h" ? "last hour" : "last 24 hours");
  return parts.join(" · ");
}
