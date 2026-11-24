// The Activity destination's feed outside React: where its list starts, and
// (below) the reads and refreshes that keep it and the flow current.

import { activityAnchor, type ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import { compareEventCursors } from "@blast/core/modules/launchpad-contract/cursor.ts";

import {
  activityKey,
  afterFlow,
  afterMore,
  afterRefresh,
  INITIAL_FLOW,
  initialList,
  listDisplay,
  showNewer,
  type FlowOutcome,
  type FlowState,
  type ListState,
  type PageOutcome,
} from "./activity-model";
import type { ActivityPending } from "./ActivityView";

/**
 * Where the list's first page starts: the newest (null), or at a durable
 * link's position. One list holds every record, the venue pool's swaps after
 * migration included (blast-infra merges them in position order), so a link
 * to any record cuts it at that record.
 */
export function listStart(launchId: string, anchor: string | null): string | null {
  return anchor === null ? null : activityAnchor(launchId, anchor).cursor;
}

/**
 * The feed's reads: the launch's page after a cursor, and the flow; each at a
 * live hint's checkpoint (`at`, `use-market-poll.ts`), or null.
 */
export type ActivityFeedReads = Readonly<{
  activity: (cursor: string | null, at: number | null) => Promise<PageOutcome<ActivityRow>>;
  flow: (at: number | null) => Promise<FlowOutcome>;
}>;

export type ActivityFeedState = Readonly<{
  activity: ListState<ActivityRow>;
  /** Provisional rows from the market stream that no first-page read has answered for yet, newest first. */
  live: readonly ActivityRow[];
  flow: FlowState;
  pending: ActivityPending;
}>;

export type ActivityFeed = Readonly<{
  /** Where its list starts. */
  start: string | null;
  state: () => ActivityFeedState;
  subscribe: (listener: () => void) => () => void;
  /** Starts the first visible read once, reusing a successful server page. */
  initialize: () => Promise<boolean>;
  /** Re-reads the list and flow. A live hint waits only for the list's answer. */
  refresh: (manual: boolean, at?: number | null) => Promise<boolean>;
  /** Reads the page after the list's last row. */
  more: () => Promise<void>;
  /** Shows the newer first page a refresh offered, replacing the list's loaded pages. */
  showNewer: () => void;
  /** Adds a provisional row from a trade frame (`activity-live.ts`); a list cut at a link takes none. True when a held row gave way to the cap. */
  addLive: (row: ActivityRow) => boolean;
  /** The checkpoint the list's last first-page answer reflects; null before one. */
  readThrough: () => number | null;
}>;

/** The most provisional rows a list holds: one page. Older ones give way, and the list asks for a read that brings them (`activity-live.ts`). */
export const LIVE_ROWS_MAX = 25;

/** The classified read can omit a USD value already received for the same immutable trade. */
function preserveTradeValues(outcome: PageOutcome<ActivityRow>, state: ActivityFeedState): PageOutcome<ActivityRow> {
  if (outcome.kind !== "rows") return outcome;
  const values = new Map<string, string>();
  for (const rows of [state.live, state.activity.view?.rows, state.activity.newer?.rows]) {
    for (const row of rows ?? []) {
      if (row.volumeUsd !== undefined) values.set(row.position, row.volumeUsd);
    }
  }
  if (values.size === 0) return outcome;
  return {
    ...outcome,
    rows: outcome.rows.map((row) => {
      const value = values.get(row.position);
      return row.volumeUsd === undefined && value !== undefined ? { ...row, volumeUsd: value } : row;
    }),
  };
}

/** Whether a first-page answer at `checkpoint` whose newest row is `newest` covers a provisional row. */
function answers(row: ActivityRow, checkpoint: number | null, newest: ActivityRow | undefined): boolean {
  return (checkpoint !== null && row.checkpoint <= checkpoint) || (newest !== undefined && compareEventCursors(row.position, newest.position) <= 0);
}

/** Whether the rows read, or a newer page offered beside them, cover a provisional row. */
function covered(list: ListState<ActivityRow>, row: ActivityRow): boolean {
  return [list.view, list.newer].some((view) => view !== null && answers(row, view.provenance.checkpoint, view.rows[0]));
}

/** The provisional rows `list` does not cover yet; the same array when it covers none. */
function uncovered(list: ListState<ActivityRow>, live: readonly ActivityRow[]): readonly ActivityRow[] {
  const kept = live.filter((row) => !covered(list, row));
  return kept.length === live.length ? live : kept;
}

/**
 * The list as shown: its provisional rows above the rows read, each only while
 * it is newer than every row read. The REST row at the same position then takes
 * its place, so a row never leaves and comes back. While a newer page is only
 * offered the list stays as it is; the rows wait for "Show newer".
 */
export function shownActivity(state: ActivityFeedState): ListState<ActivityRow> {
  const view = state.activity.view;
  if (!view || state.live.length === 0 || state.activity.newer) return state.activity;
  const live = state.live.filter((row) => !answers(row, null, view.rows[0]));
  return live.length ? { ...state.activity, view: { ...view, rows: [...live, ...view.rows] } } : state.activity;
}

/**
 * The Activity destination's list and flow, outside React. Every first-page
 * read starts where `start` says (a durable link keeps its cut through every
 * refresh); an older first-page read answering after a newer one is dropped.
 * When to re-read (a poll) is the shared rule of `use-market-poll.ts`.
 */
export function createActivityFeed(options: Readonly<{
  reads: ActivityFeedReads;
  start: string | null;
  initialActivity?: PageOutcome<ActivityRow>;
}>): ActivityFeed {
  const { reads, start, initialActivity } = options;
  const seed = initialActivity?.kind === "rows" ? initialActivity : null;
  const initial = initialList<ActivityRow>();
  let current: ActivityFeedState = {
    activity: seed ? afterRefresh(initial, seed, activityKey) : initial,
    live: [],
    flow: INITIAL_FLOW,
    pending: null,
  };
  const listeners = new Set<() => void>();
  const tickets = { activity: 0, flow: 0, manual: 0 };
  let initialized: Promise<boolean> | null = null;

  const update = (change: (state: ActivityFeedState) => ActivityFeedState) => {
    const next = change(current);
    if (next === current) return;
    current = next;
    for (const listener of listeners) listener();
  };

  const readThrough = () => {
    const { view, newer } = current.activity;
    const checkpoints = [view?.provenance.checkpoint, newer?.provenance.checkpoint].filter((checkpoint) => typeof checkpoint === "number");
    return checkpoints.length ? Math.max(...checkpoints) : null;
  };

  const readActivity = async (at: number | null): Promise<boolean> => {
    const mine = ++tickets.activity;
    const outcome = await reads.activity(start, at);
    const coveredThrough = readThrough();
    const checkpoint = outcome.kind === "rows" ? outcome.provenance.checkpoint : null;
    if (coveredThrough !== null && checkpoint !== null && checkpoint < coveredThrough) return false;
    update((state) => {
      if (mine !== tickets.activity) return state;
      const activity = afterRefresh(state.activity, preserveTradeValues(outcome, state), activityKey);
      return { ...state, activity, live: uncovered(activity, state.live) };
    });
    return outcome.kind !== "failed";
  };

  const readFlow = async (at: number | null): Promise<boolean> => {
    const mine = ++tickets.flow;
    const outcome = await reads.flow(at).catch((): FlowOutcome => ({ kind: "failed", reason: "unavailable" }));
    update((state) => mine === tickets.flow ? { ...state, flow: afterFlow(state.flow, outcome) } : state);
    return outcome.kind !== "failed";
  };

  const refresh = async (manual: boolean, at: number | null = null): Promise<boolean> => {
    const mine = manual ? ++tickets.manual : null;
    if (manual) update((state) => ({ ...state, pending: "refresh" }));
    try {
      const activity = readActivity(at);
      const flow = readFlow(at);
      if (at !== null && !manual) return activity;
      const answered = await Promise.all([activity, flow]);
      return answered.some(Boolean);
    } finally {
      if (mine === tickets.manual) {
        update((state) => state.pending === "refresh" ? { ...state, pending: null } : state);
      }
    }
  };

  const more = async (): Promise<void> => {
    const cursor = current.activity.view?.next;
    if (!cursor) return;
    update((state) => ({ ...state, pending: "more-activity" }));
    const outcome = await reads.activity(cursor, null);
    update((state) => ({
      ...state,
      activity: afterMore(state.activity, cursor, outcome, activityKey),
      pending: state.pending === "more-activity" ? null : state.pending,
    }));
  };

  return {
    start,
    state: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    initialize: () => initialized ??= seed ? readFlow(null) : refresh(false),
    refresh,
    more,
    // Shown newer rows replace the list: provisional rows they cover go with it.
    showNewer: () => update((state) => ({ ...state, activity: showNewer(state.activity) })),
    addLive: (row) => {
      if (start !== null) return false;
      let overflowed = false;
      update((state) => {
        if (state.live.some((held) => held.position === row.position) || covered(state.activity, row)) return state;
        const live = [...state.live, row].sort((left, right) => compareEventCursors(right.position, left.position));
        overflowed = live.length > LIVE_ROWS_MAX;
        return { ...state, live: live.slice(0, LIVE_ROWS_MAX) };
      });
      return overflowed;
    },
    readThrough,
  };
}

/**
 * The element a durable link scrolls into view, once the list has answered
 * (null until then, and without a link): the linked row
 * (`activity-<position>`), else the list's note (`<launchId>-activity-link`),
 * which says it is not there.
 */
export function linkTarget(launchId: string, anchor: string | null, state: ActivityFeedState): string | null {
  if (anchor === null) return null;
  const launch = listDisplay(state.activity);
  if (launch.kind === "loading") return null;
  if (launch.kind === "rows" && launch.view.rows.some((row) => row.position === anchor)) return `activity-${anchor}`;
  return `${launchId}-activity-link`;
}
