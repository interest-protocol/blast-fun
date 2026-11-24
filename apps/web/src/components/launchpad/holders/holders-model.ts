// The Holders destination's state: a coin's native holder snapshot as
// blast-infra serves it, page by page, through refreshes and outages. Every
// count and concentration fact is the engine's whole-coin aggregate at one
// identified checkpoint; nothing is summed from the loaded rows or inferred
// from trades, and an incomplete snapshot is never shown as zero.

import type {
  HolderConcentration,
  HolderFacts,
  HolderRow,
  HolderSnapshotStamp,
  HoldersSnapshotPage,
  V1Answer,
} from "#web/modules/launchpad-contract/browser-holders.ts";
import type { Provenance, RoutedRead } from "@blast/core/modules/launchpad-contract/read.ts";

/** What one page read amounts to. */
export type HoldersOutcome =
  | Readonly<{ kind: "facts"; snapshot: HolderSnapshotStamp; facts: HolderFacts; provenance: Provenance; lagging: boolean }>
  | Readonly<{ kind: "incomplete"; snapshot: HolderSnapshotStamp; provenance: Provenance }>
  | Readonly<{ kind: "failed"; reason: string }>;

/** The whole-coin aggregates of one snapshot. Every share's denominator is `heldSupply`. */
export type HolderTotals = Readonly<{
  holderCount: bigint;
  heldSupply: bigint;
  top1: HolderConcentration;
  top10: HolderConcentration;
}>;

/** A snapshot with facts, and the rows loaded so far. */
export type HoldersView = Readonly<{
  /** The checkpoint the totals were read at, and its completeness. */
  snapshot: HolderSnapshotStamp;
  provenance: Provenance;
  totals: HolderTotals;
  /** Balance descending; each address once. */
  rows: readonly HolderRow[];
  /** The latest checkpoint a loaded page was read at. */
  rowsCheckpoint: number;
  nextCursor: string | null;
  pages: number;
}>;

type Latest =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "current" }>
  | Readonly<{ kind: "lagging" }>
  | Readonly<{ kind: "incomplete"; snapshot: HolderSnapshotStamp; provenance: Provenance }>
  | Readonly<{ kind: "failed"; reason: string }>;

export type HoldersState = Readonly<{
  /** The last snapshot that answered with facts; kept through an outage, shown Stale. */
  view: HoldersView | null;
  /** What the latest read said. */
  latest: Latest;
  /** A first page at a later checkpoint, read while several pages are shown; showing it replaces them. */
  newer: HoldersView | null;
  /** Why the last "more" page failed; the rows stay. */
  moreFailed: string | null;
}>;

export const INITIAL_HOLDERS: HoldersState = { view: null, latest: { kind: "loading" }, newer: null, moreFailed: null };

/** Why facts on screen are Stale. */
export type HoldersStaleness =
  | Readonly<{ cause: "failed"; reason: string }>
  | Readonly<{ cause: "lagging" }>
  | Readonly<{ cause: "behind" }>;

export type HoldersDisplay =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable"; reason: string }>
  | Readonly<{ kind: "incomplete"; snapshot: HolderSnapshotStamp; provenance: Provenance }>
  | Readonly<{ kind: "facts"; view: HoldersView; stale: HoldersStaleness | null }>;

/** A routed snapshot read as an outcome; a refusal's reason is its error code. */
export function holdersOutcome(read: RoutedRead<V1Answer<HoldersSnapshotPage>>): HoldersOutcome {
  if (read.status === "unavailable") return { kind: "failed", reason: read.provenance.reason ?? "unavailable" };
  if (read.data.kind === "refused") return { kind: "failed", reason: read.data.error.code };
  const { snapshot, facts } = read.data.value;
  if (facts === null) return { kind: "incomplete", snapshot, provenance: read.provenance };
  return { kind: "facts", snapshot, facts, provenance: read.provenance, lagging: read.status === "stale" };
}

function firstPage(outcome: Extract<HoldersOutcome, { kind: "facts" }>): HoldersView {
  const { holderCount, heldSupply, top1, top10, holders, nextCursor } = outcome.facts;
  return {
    snapshot: outcome.snapshot,
    provenance: outcome.provenance,
    totals: { holderCount, heldSupply, top1, top10 },
    rows: holders,
    rowsCheckpoint: outcome.snapshot.checkpoint,
    nextCursor,
    pages: 1,
  };
}

function incomplete(outcome: Extract<HoldersOutcome, { kind: "incomplete" }>): HoldersState {
  return { view: null, latest: outcome, newer: null, moreFailed: null };
}

/** The state after a first-page read (the initial load, a refresh, or a live update). */
export function afterRefresh(state: HoldersState, outcome: HoldersOutcome): HoldersState {
  if (outcome.kind === "failed") return { ...state, latest: outcome };
  if (outcome.kind === "incomplete") return incomplete(outcome);
  const latest: Latest = { kind: outcome.lagging ? "lagging" : "current" };
  const view = firstPage(outcome);
  if (state.view && state.view.pages > 1) {
    // A snapshot at the checkpoint shown holds the same facts: nothing newer to offer.
    const newer = view.snapshot.checkpoint > state.view.snapshot.checkpoint ? view : state.newer;
    return { ...state, latest, newer };
  }
  return { view, latest, newer: null, moreFailed: null };
}

/** The state after the page after `cursor` answered; an answer for a cursor the view no longer ends at is dropped. */
export function afterMore(state: HoldersState, cursor: string, outcome: HoldersOutcome): HoldersState {
  const view = state.view;
  if (!view || view.nextCursor !== cursor) return state;
  if (outcome.kind === "failed") return { ...state, moreFailed: outcome.reason };
  if (outcome.kind === "incomplete") return incomplete(outcome);
  // Balances move between pages: an address already shown keeps its first row.
  const shown = new Set(view.rows.map((row) => row.address));
  return {
    ...state,
    latest: outcome.lagging ? { kind: "lagging" } : state.latest,
    view: {
      ...view,
      rows: [...view.rows, ...outcome.facts.holders.filter((row) => !shown.has(row.address))],
      rowsCheckpoint: Math.max(view.rowsCheckpoint, outcome.snapshot.checkpoint),
      nextCursor: outcome.facts.nextCursor,
      pages: view.pages + 1,
    },
    moreFailed: null,
  };
}

/** Shows the newer snapshot that a refresh offered, replacing the loaded pages. */
export function showNewer(state: HoldersState): HoldersState {
  return state.newer ? { ...state, view: state.newer, newer: null, moreFailed: null } : state;
}

/** What the destination shows now. */
export function holdersDisplay(state: HoldersState): HoldersDisplay {
  const { view, latest } = state;
  if (latest.kind === "incomplete") return { kind: "incomplete", snapshot: latest.snapshot, provenance: latest.provenance };
  if (!view) return latest.kind === "failed" ? { kind: "unavailable", reason: latest.reason } : { kind: "loading" };
  const stale: HoldersStaleness | null =
    latest.kind === "failed"
      ? { cause: "failed", reason: latest.reason }
      : latest.kind === "lagging"
        ? { cause: "lagging" }
        : view.snapshot.state === "behind"
          ? { cause: "behind" }
          : null;
  return { kind: "facts", view, stale };
}
