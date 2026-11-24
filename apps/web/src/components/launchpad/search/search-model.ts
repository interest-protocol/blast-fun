import type {
  LaunchGroupPage,
  LaunchMatch,
  PagedGroup,
  SearchGroup,
  SearchResponse,
  ThesisGroupPage,
  ThesisMatch,
} from "@blast/core/modules/launchpad-search/contracts.ts";
import { mapSectionState, type SectionState } from "../primitives/data-state.ts";

/**
 * The search surface's state and wording, browser-safe and pure. Each
 * group keeps its own honest state: an outage or a failed page in one group
 * never empties, zeroes or hides another.
 */

export type GroupPage = LaunchGroupPage | ThesisGroupPage;
export type SearchItem = LaunchMatch | ThesisMatch;

export type GroupView = Readonly<{
  group: SearchGroup;
  state: SectionState<GroupPage>;
  loadingMore: boolean;
  /** Why the last Show more failed; the rows keep their own state. Null when it did not fail. */
  pageError: string | null;
}>;

export type SearchView =
  | Readonly<{ status: "idle" }>
  | Readonly<{ status: "searching"; query: string }>
  | Readonly<{ status: "invalid"; query: string; message?: string }>
  | Readonly<{ status: "failed"; query: string; reason: string; code?: string }>
  | Readonly<{ status: "results"; query: string; walletAddress?: string; groups: readonly GroupView[] }>;

/** A served answer, a refused request ("invalid", 400) or one that did not complete (null). */
export type SearchAnswer = SearchResponse | "invalid" | null;

const ENDPOINT = "/api/launchpad/search";

export function searchUrl(query: string): string {
  return `${ENDPOINT}?${new URLSearchParams({ q: query.trim().replace(/\s+/g, " ") })}`;
}

export function groupPageUrl(query: string, group: PagedGroup, cursor: string): string {
  return `${ENDPOINT}?${new URLSearchParams({ q: query.trim().replace(/\s+/g, " "), group, cursor })}`;
}

/** Each group's name and what decides its order. */
export const GROUP_INFO: Readonly<Record<SearchGroup, Readonly<{ label: string; order: string; more: string }>>> = {
  onchain: { label: "On-chain IDs", order: "Exact launch ID or migration pool ID.", more: "on-chain matches" },
  wallets: { label: "Wallets", order: "Launches this wallet created, newest first.", more: "launches by this wallet" },
  coins: { label: "Coins", order: "Exact coin type, then ticker, then name, then words; newest launch first within each.", more: "coins" },
  theses: {
    label: "Thesis",
    order: "Public thesis containing every word, newest first post first; a revision keeps its place.",
    more: "thesis",
  },
  profiles: { label: "Profiles", order: "", more: "profiles" },
};

const REASONS: Readonly<Record<string, string>> = {
  "indexer-lag": "the indexer is behind the chain",
  "replica-lag": "the read replica is behind",
  "replica-unavailable": "the read replica did not answer",
  "primary-unavailable": "the primary database did not answer",
  "social-unavailable": "the primary database did not answer",
  "no-checkpoint": "the indexer has not committed a checkpoint yet",
  "network-mismatch": "the database indexes another network",
  "deployment-mismatch": "the database indexes another deployment",
  unconfigured: "search is not configured here",
  error: "its source failed",
  "contract-violation": "the answer did not pass validation",
  "no-source": "Blast has no profile records yet",
  request: "the request did not complete",
};

export function describeSearchReason(reason: string): string {
  return REASONS[reason] ?? `the source answered ${reason}`;
}

function sentence(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function afterSearch(query: string, answer: SearchAnswer, walletAddress?: string): SearchView {
  if (answer === null) return { status: "failed", query, reason: describeSearchReason("request") };
  if (answer === "invalid") return { status: "invalid", query };
  return {
    status: "results",
    query,
    ...(walletAddress ? { walletAddress } : {}),
    groups: answer.groups.map((result) => ({
      group: result.group,
      state: mapSectionState<GroupPage>(result.section, describeSearchReason, sentence),
      loadingMore: false,
      pageError: null,
    })),
  };
}

/** The group `group` while its next page is read. */
export function withLoadingMore(view: SearchView, group: SearchGroup): SearchView {
  if (view.status !== "results") return view;
  return { ...view, groups: view.groups.map((entry) => (entry.group === group ? { ...entry, loadingMore: true } : entry)) };
}

/** What identifies a match within its group, so a page never lists it twice. */
export function itemKey(item: SearchItem): string {
  return "thesis" in item ? item.thesis.id : item.launch.launchId;
}

/**
 * A group after its next page. A failed page leaves the rows in their own
 * state (they are as current as before) and says why in `pageError`; the
 * page can be asked for again unless it was refused. A page that loads
 * clears an earlier failure.
 */
function nextPage(
  previous: SectionState<GroupPage>,
  group: SearchGroup,
  answer: SearchAnswer,
): Readonly<{ state: SectionState<GroupPage>; pageError: string | null }> {
  if (previous.status !== "ready" && previous.status !== "stale") return { state: previous, pageError: null };
  const served = answer === null || answer === "invalid" ? null : answer.groups.find((entry) => entry.group === group);
  const failure = (reason: string) => ({ state: previous, pageError: `More matches could not be loaded: ${reason}` });
  if (answer === null) return failure(describeSearchReason("request"));
  if (answer === "invalid" || !served) {
    return {
      state: { ...previous, value: { ...previous.value, nextCursor: null } },
      pageError: "More matches could not be loaded: the page was refused; search again to start over",
    };
  }
  const next = mapSectionState<GroupPage>(served.section, describeSearchReason, sentence);
  if (next.status === "empty") return { state: { ...previous, value: { ...previous.value, nextCursor: null } }, pageError: null };
  if (next.status === "unavailable") return failure(next.reason);
  const listed = new Set(previous.value.items.map(itemKey));
  const value = {
    items: [...previous.value.items, ...next.value.items.filter((item) => !listed.has(itemKey(item)))],
    nextCursor: next.value.nextCursor,
  } as GroupPage;
  return { state: next.status === "stale" ? { ...next, value } : { ...previous, value }, pageError: null };
}

/**
 * The view after reading `group`'s next page for `query`; other groups are
 * untouched. A page of another query (an older search's Show more landing
 * after a newer search) is dropped: its rows and token belong to that query.
 */
export function afterGroupPage(view: SearchView, group: SearchGroup, query: string, answer: SearchAnswer): SearchView {
  if (view.status !== "results" || view.query !== query) return view;
  return {
    ...view,
    groups: view.groups.map((entry) => (entry.group === group
      ? { group, ...nextPage(entry.state, group, answer), loadingMore: false }
      : entry)),
  };
}

function listing(labels: readonly string[]): string {
  return labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
}

/** Whether any group with a source answered (Profiles has none yet). */
export function anyGroupAnswered(view: SearchView): boolean {
  return view.status === "results" &&
    view.groups.some((entry) => entry.group !== "profiles" && entry.state.status !== "unavailable");
}

/**
 * The first group that has shown no match yet but has more to read: a page
 * of theses can skip posts of launches Blast no longer lists and still carry
 * a token. Such a search has not found nothing.
 */
export function groupWithMore(view: SearchView): SearchGroup | null {
  if (view.status !== "results") return null;
  const entry = view.groups.find((candidate) => candidate.group !== "profiles" &&
    (candidate.state.status === "ready" || candidate.state.status === "stale") &&
    candidate.state.value.items.length === 0 && candidate.state.value.nextCursor !== null);
  return entry?.group ?? null;
}

/** The total of matches shown, and the groups that hold them. */
export function matchCount(view: SearchView): Readonly<{ matches: number; groups: number }> {
  if (view.status !== "results") return { matches: 0, groups: 0 };
  const shown = view.groups.filter((entry) => (entry.state.status === "ready" || entry.state.status === "stale") && entry.state.value.items.length > 0);
  return {
    matches: shown.reduce((sum, entry) => sum + (entry.state.status === "ready" || entry.state.status === "stale" ? entry.state.value.items.length : 0), 0),
    groups: shown.length,
  };
}

/** One sentence for the live status line. */
export function searchSummary(view: SearchView): string {
  switch (view.status) {
    case "idle":
      return "";
    case "searching":
      return "Searching…";
    case "invalid":
      return view.message ?? "Search for a word, ticker, coin type, launch ID, pool ID or wallet address.";
    case "failed":
      return `Search could not complete: ${view.reason}.`;
    case "results": {
      const { matches, groups } = matchCount(view);
      const down = view.groups.filter((entry) => entry.state.status === "unavailable").map((entry) => GROUP_INFO[entry.group].label);
      const answeredDown = down.length > 0 && !(down.length === 1 && down[0] === GROUP_INFO.profiles.label);
      const more = groupWithMore(view);
      const found = matchSummary(view, matches, groups, more, answeredDown);
      return down.length > 0 ? `${found} ${listing(down)} are unavailable.` : found;
    }
  }
}

function matchSummary(view: SearchView, matches: number, groups: number, more: SearchGroup | null, answeredDown: boolean): string {
  if (matches > 0) return `${matches} ${matches === 1 ? "match" : "matches"} in ${groups} ${groups === 1 ? "group" : "groups"}.`;
  if (more) return `No matches yet; more ${GROUP_INFO[more].more} remain to search.`;
  if (!anyGroupAnswered(view)) return "No group could be searched.";
  return answeredDown ? "No matches in the groups that answered." : "No matches.";
}
