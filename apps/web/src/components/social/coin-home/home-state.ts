import {
  HOME_DEFAULT_QUERY,
  HOME_PAGE_DEFAULT,
  HOME_PAGE_LAST,
  isHomeAge,
  isHomeSort,
  isHomeSource,
  isHomeWindow,
  type HomeAge,
  type HomeQuery,
  type HomeSort,
  type HomeSource,
  type HomeWindow,
} from "@blast/core/web/contracts/home.ts";

/**
 * Home's view state and its URL (the brief's §14): the source chooses what
 * qualifies, the sort orders, the filters narrow, the window scopes every
 * count, the page says which rows of the list. Nothing personal goes in
 * the URL: a source name, a sort, a window, three filters and a page
 * number, each left out at its default so equal views share one address.
 * An unknown value reads as the default, never as an error, so a stale
 * link still opens Home. The rows per page are the device's (a cookie,
 * `home-rows.ts`), not the URL's.
 */
export type HomeViewState = Readonly<{
  source: HomeSource;
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
  sort: "held",
  window: "1h",
  minParticipants: 0,
  age: "all",
  tradable: false,
  page: 1,
});

/** The minimum-participants choices the filter offers. */
export const MIN_PARTICIPANT_CHOICES = [0, 2, 5, 10] as const;

/** The URL's names: short, stable, nothing a reader would mistake for data. */
const KEYS = { source: "src", sort: "sort", window: "w", minParticipants: "min", age: "age", tradable: "tradable", page: "page" } as const;

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
  const sort = params.get(KEYS.sort);
  const window = params.get(KEYS.window);
  const age = params.get(KEYS.age);
  const min = params.get(KEYS.minParticipants);
  const minParticipants = min !== null && /^[0-9]{1,4}$/.test(min) && (MIN_PARTICIPANT_CHOICES as readonly number[]).includes(Number(min)) ? Number(min) : 0;
  return {
    source: isHomeSource(source) ? source : HOME_DEFAULT_VIEW.source,
    sort: isHomeSort(sort) ? sort : HOME_DEFAULT_VIEW.sort,
    window: isHomeWindow(window) ? window : HOME_DEFAULT_VIEW.window,
    minParticipants,
    age: isHomeAge(age) ? age : HOME_DEFAULT_VIEW.age,
    tradable: params.get(KEYS.tradable) === "1",
    page: pageOf(params.get(KEYS.page)),
  };
}

/** The query string of a view state, `""` for the default view. */
export function viewSearchOf(state: HomeViewState): string {
  const params = new URLSearchParams();
  if (state.source !== HOME_DEFAULT_VIEW.source) params.set(KEYS.source, state.source);
  if (state.sort !== HOME_DEFAULT_VIEW.sort) params.set(KEYS.sort, state.sort);
  if (state.window !== HOME_DEFAULT_VIEW.window) params.set(KEYS.window, state.window);
  if (state.minParticipants !== 0) params.set(KEYS.minParticipants, String(state.minParticipants));
  if (state.age !== "all") params.set(KEYS.age, state.age);
  if (state.tradable) params.set(KEYS.tradable, "1");
  if (state.page > 1) params.set(KEYS.page, String(state.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Whether two states show the same list apart from its page (a new list starts on page 1; see `withView`). */
export function sameListView(a: HomeViewState, b: HomeViewState): boolean {
  return a.source === b.source && a.sort === b.sort && a.window === b.window && a.minParticipants === b.minParticipants && a.age === b.age && a.tradable === b.tradable;
}

/** The next state for a change: any change but the page itself starts the list on page 1. */
export function withView(current: HomeViewState, next: HomeViewState): HomeViewState {
  return sameListView(current, next) ? next : { ...next, page: 1 };
}

/** The Discover read a view state asks for, at the device's rows per page. */
export function discoverQueryOf(state: HomeViewState, rows: number = HOME_PAGE_DEFAULT): HomeQuery {
  return { ...HOME_DEFAULT_QUERY, sort: state.sort, window: state.window, minParticipants: state.minParticipants, age: state.age, tradable: state.tradable, limit: rows, page: state.page };
}

/** How many filters are away from their default (the Filters button's badge). */
export function activeFilterCount(state: HomeViewState): number {
  return (state.minParticipants !== 0 ? 1 : 0) + (state.age !== "all" ? 1 : 0) + (state.tradable ? 1 : 0);
}

/** Whether the sort and the filters apply: Discover only (Following and the Watchlist have their own order). */
export function controlsApply(source: HomeSource): boolean {
  return source === "discover";
}

export const SORT_LABELS: Readonly<Record<HomeSort, string>> = { relevant: "Relevant", trending: "Volume", newest: "Newest", held: "Most held" };
export const SORT_HINTS: Readonly<Partial<Record<HomeSort, string>>> = {
  relevant: "Unique participants, then activity (up to three trades per person), then recency",
  trending: "Trade and presale dollar volume, then unique participants",
};
export const WINDOW_LABELS: Readonly<Record<HomeWindow, string>> = { "1h": "1h", "24h": "24h" };
export const AGE_LABELS: Readonly<Record<HomeAge, string>> = { "24h": "Last 24h", "7d": "Last 7 days", "30d": "Last 30 days", all: "Any time" };
export const SOURCE_LABELS: Readonly<Record<HomeSource, string>> = { discover: "Discover", following: "Following", watchlist: "Watchlist" };

/** The spoken summary after a change: `Discover · 12 coins · page 2 of 3 · sorted by Relevant · last 24h`. */
export function resultsAnnouncement(state: Pick<HomeViewState, "source" | "page" | "sort" | "window">, count: number | null, pages = 1): string {
  const parts = [SOURCE_LABELS[state.source]];
  if (count !== null) parts.push(`${count.toLocaleString("en-US")} ${count === 1 ? "coin" : "coins"}`);
  if (pages > 1) parts.push(`page ${state.page.toLocaleString("en-US")} of ${pages.toLocaleString("en-US")}`);
  if (controlsApply(state.source)) parts.push(`sorted by ${SORT_LABELS[state.sort]}`);
  parts.push(state.window === "1h" ? "last hour" : "last 24 hours");
  return parts.join(" · ");
}
