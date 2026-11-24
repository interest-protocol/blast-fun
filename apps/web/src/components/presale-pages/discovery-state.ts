import type { CalendarRange } from "./calendar-model";
import type { PresaleListStatus } from "@blast/core/web/contracts/presales.ts";
import { isPresaleListStatus } from "@blast/core/web/contracts/presales.ts";

const DISCOVERY_SORTS = {
  live: [["ending", "Ending soon"], ["backed", "Most backers"]],
  upcoming: [["opening", "Opening soon"], ["interest", "Most interested"]],
  ended: [["recent", "Recently ended"], ["best", "Best since launch"], ["backed", "Most backers"]],
} as const;

export type PresaleListView = "list" | "calendar" | "backed";
export type PresaleResultLayout = "list" | "cards";
export type PresaleScope = "all" | "watch" | "following";
const LIVE_PUBLIC_SORTS = [["pinned", "Pinned first"], ...DISCOVERY_SORTS.live] as const;

export function discoverySorts(status: PresaleListStatus, scope: PresaleScope = "all") {
  return status === "live" && scope === "all" ? LIVE_PUBLIC_SORTS : DISCOVERY_SORTS[status];
}

export type DiscoveryState = Readonly<{ status: PresaleListStatus; sort: string; scope: PresaleScope; view: PresaleListView; layout: PresaleResultLayout; calendarRange: CalendarRange }>;

export function withDiscoveryScope(state: DiscoveryState, scope: PresaleScope): DiscoveryState {
  if (state.scope === scope) return state;
  const currentDefault = discoverySorts(state.status, state.scope)[0][0];
  const sort = state.sort === currentDefault ? discoverySorts(state.status, scope)[0][0] : state.sort;
  return { ...state, scope, sort };
}

function personalScope(value: string | null | undefined) {
  return value === "watch" || value === "following" ? value : undefined;
}

export function discoveryState(params: Readonly<{ status?: string | null; sort?: string | null; scope?: string | null; view?: string | null; layout?: string | null; calendarRange?: string | null }>): DiscoveryState {
  const status = isPresaleListStatus(params.status) ? params.status : "live";
  const view = params.view === "calendar" || params.view === "backed" ? params.view : "list";
  const scope = personalScope(params.scope) ?? personalScope(params.sort) ?? "all";
  const sorts = discoverySorts(status, scope);
  return {
    status,
    calendarRange: view === "calendar" && (params.calendarRange === "past" || params.calendarRange === "all") ? params.calendarRange : "upcoming",
    sort: sorts.find(([key]) => key === params.sort)?.[0] ?? sorts[0][0],
    scope,
    view,
    layout: params.layout === "list" ? "list" : "cards",
  };
}

export function discoveryPath({ status, sort, scope, view, layout, calendarRange }: DiscoveryState): string {
  const params = new URLSearchParams();
  if (view !== "list") params.set("view", view);
  if (view === "calendar" && calendarRange !== "upcoming") params.set("calendarRange", calendarRange);
  if (status !== "live") params.set("status", status);
  if (sort !== discoverySorts(status, scope)[0][0]) params.set("sort", sort);
  if (scope !== "all") params.set("scope", scope);
  if (layout === "list") params.set("layout", layout);
  const search = params.toString();
  return search ? `/presale?${search}` : "/presale";
}
