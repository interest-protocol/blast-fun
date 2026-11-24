// The Activity destination's state: blast-infra's completed launch activity
// (the venue pool's swaps after migration included), a newest-first list read
// page by page through refreshes and outages, and the curve's windowed flow. Rows are
// immutable completed events keyed by their chain position, so pages join by
// position: a row appears once, in its place, however reads overlap. Nothing
// here computes a market value.

import { compareEventCursors } from "@blast/core/modules/launchpad-contract/cursor.ts";
import type { CurveFlow } from "@blast/core/modules/launchpad-contract/activity.ts";
import type { Provenance } from "@blast/core/modules/launchpad-contract/read.ts";

/** What one page read amounts to. */
export type PageOutcome<Row> =
  | Readonly<{ kind: "rows"; rows: readonly Row[]; next: string | null; provenance: Provenance; lagging: boolean }>
  | Readonly<{ kind: "failed"; reason: string }>;

/** The rows loaded so far, newest first, and where the next page starts. */
export type ListView<Row> = Readonly<{
  rows: readonly Row[];
  next: string | null;
  /** The latest page read's provenance. */
  provenance: Provenance;
  pages: number;
}>;

type Latest =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "current" }>
  | Readonly<{ kind: "lagging" }>
  | Readonly<{ kind: "failed"; reason: string }>;

export type ListState<Row> = Readonly<{
  /** The last rows read; kept through an outage, shown Stale. */
  view: ListView<Row> | null;
  latest: Latest;
  /** A first page that cannot reach the rows shown (a gap); showing it replaces them. */
  newer: ListView<Row> | null;
  /** Why the last "more" page failed; the rows stay. */
  moreFailed: string | null;
}>;

/** Why rows on screen are Stale. */
export type ListStaleness = Readonly<{ cause: "failed"; reason: string }> | Readonly<{ cause: "lagging" }>;

export type ListDisplay<Row> =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable"; reason: string }>
  | Readonly<{ kind: "rows"; view: ListView<Row>; stale: ListStaleness | null }>;

/** A row's chain position: `"<checkpoint>:<tx>:<event>:<sub>"`. */
export type RowKey<Row> = (row: Row) => string;

export const activityKey: RowKey<{ position: string }> = (row) => row.position;

export function initialList<Row>(): ListState<Row> {
  return { view: null, latest: { kind: "loading" }, newer: null, moreFailed: null };
}

function pageView<Row>(outcome: Extract<PageOutcome<Row>, { kind: "rows" }>): ListView<Row> {
  return { rows: outcome.rows, next: outcome.next, provenance: outcome.provenance, pages: 1 };
}

/** `rows` and `more` as one newest-first list, each position once. */
function union<Row>(rows: readonly Row[], more: readonly Row[], key: RowKey<Row>): Row[] {
  const seen = new Map<string, Row>();
  for (const row of [...rows, ...more]) if (!seen.has(key(row))) seen.set(key(row), row);
  return [...seen.entries()].sort(([left], [right]) => compareEventCursors(right, left)).map(([, row]) => row);
}

/**
 * The state after a first-page read (the initial load, a refresh, a poll or a
 * live update). A page that reaches the rows shown adds its newer rows above
 * them; one that cannot (more rows arrived than a page holds) replaces a
 * single page, or is offered beside several.
 */
export function afterRefresh<Row>(state: ListState<Row>, outcome: PageOutcome<Row>, key: RowKey<Row>): ListState<Row> {
  if (outcome.kind === "failed") return { ...state, latest: outcome };
  const latest: Latest = { kind: outcome.lagging ? "lagging" : "current" };
  const view = state.view;
  const newest = view?.rows[0];
  const oldest = outcome.rows.at(-1);
  const reaches = !newest || !oldest || outcome.next === null || compareEventCursors(key(oldest), key(newest)) <= 0;
  if (view && newest && reaches) {
    return { ...state, latest, view: { ...view, rows: union(outcome.rows, view.rows, key), provenance: outcome.provenance }, newer: null };
  }
  if (view && view.pages > 1) return { ...state, latest, newer: pageView(outcome) };
  return { view: pageView(outcome), latest, newer: null, moreFailed: null };
}

/** The state after the page after `cursor` answered; an answer for a cursor the list no longer ends at is dropped. */
export function afterMore<Row>(state: ListState<Row>, cursor: string, outcome: PageOutcome<Row>, key: RowKey<Row>): ListState<Row> {
  const view = state.view;
  if (!view || view.next !== cursor) return state;
  if (outcome.kind === "failed") return { ...state, moreFailed: outcome.reason };
  return {
    ...state,
    latest: outcome.lagging ? { kind: "lagging" } : state.latest,
    view: { ...view, rows: union(view.rows, outcome.rows, key), next: outcome.next, pages: view.pages + 1 },
    moreFailed: null,
  };
}

/** Shows the newer first page a refresh offered, replacing the loaded pages. */
export function showNewer<Row>(state: ListState<Row>): ListState<Row> {
  return state.newer ? { ...state, view: state.newer, newer: null, moreFailed: null } : state;
}

/** What a list shows now. */
export function listDisplay<Row>(state: ListState<Row>): ListDisplay<Row> {
  const { view, latest } = state;
  if (!view) return latest.kind === "failed" ? { kind: "unavailable", reason: latest.reason } : { kind: "loading" };
  const stale: ListStaleness | null =
    latest.kind === "failed" ? { cause: "failed", reason: latest.reason } : latest.kind === "lagging" ? { cause: "lagging" } : null;
  return { kind: "rows", view, stale };
}

/** What one flow read amounts to. */
export type FlowOutcome =
  | Readonly<{ kind: "flow"; flow: CurveFlow; provenance: Provenance; lagging: boolean }>
  | Readonly<{ kind: "failed"; reason: string }>;

export type FlowView = Readonly<{ flow: CurveFlow; provenance: Provenance }>;

export type FlowState = Readonly<{ view: FlowView | null; latest: Latest }>;

export const INITIAL_FLOW: FlowState = { view: null, latest: { kind: "loading" } };

export type FlowDisplay =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable"; reason: string }>
  | Readonly<{ kind: "flow"; view: FlowView; stale: ListStaleness | null }>;

/** The state after a flow read: an answer replaces the view; a failure keeps it. */
export function afterFlow(state: FlowState, outcome: FlowOutcome): FlowState {
  if (outcome.kind === "failed") return { ...state, latest: outcome };
  return { view: { flow: outcome.flow, provenance: outcome.provenance }, latest: { kind: outcome.lagging ? "lagging" : "current" } };
}

/** What the flow summary shows now. */
export function flowDisplay(state: FlowState): FlowDisplay {
  const { view, latest } = state;
  if (!view) return latest.kind === "failed" ? { kind: "unavailable", reason: latest.reason } : { kind: "loading" };
  const stale: ListStaleness | null =
    latest.kind === "failed" ? { cause: "failed", reason: latest.reason } : latest.kind === "lagging" ? { cause: "lagging" } : null;
  return { kind: "flow", view, stale };
}
