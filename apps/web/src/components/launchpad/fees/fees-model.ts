// The fees section's state: a launch's fees as blast-infra serves them, in two ledgers, kept
// through refreshes and outages. Every figure is the engine's own total at one identified
// checkpoint; nothing here sums, splits or prices them.

import type { LaunchRewards, V1Answer } from "#web/modules/launchpad-contract/browser-rewards.ts";
import type { Provenance, RoutedRead } from "@blast/core/modules/launchpad-contract/read.ts";

import type { ListStaleness } from "../activity/activity-model";

/** What one read amounts to. */
export type FeesOutcome =
  | Readonly<{ kind: "rewards"; rewards: LaunchRewards; provenance: Provenance; lagging: boolean }>
  | Readonly<{ kind: "failed"; reason: string }>;

export type FeesView = Readonly<{ rewards: LaunchRewards; provenance: Provenance }>;

type Latest = Readonly<{ kind: "loading" | "current" | "lagging" }> | Readonly<{ kind: "failed"; reason: string }>;

export type FeesState = Readonly<{ view: FeesView | null; latest: Latest }>;

export const INITIAL_FEES: FeesState = { view: null, latest: { kind: "loading" } };

export type FeesDisplay =
  | Readonly<{ kind: "loading" }>
  | Readonly<{ kind: "unavailable"; reason: string }>
  | Readonly<{ kind: "rewards"; view: FeesView; stale: ListStaleness | null }>;

/** A routed rewards read as an outcome; a refusal's reason is its error code. */
export function feesOutcome(read: RoutedRead<V1Answer<LaunchRewards>>): FeesOutcome {
  if (read.status === "unavailable") return { kind: "failed", reason: read.provenance.reason ?? "unavailable" };
  if (read.data.kind === "refused") return { kind: "failed", reason: read.data.error.code };
  return { kind: "rewards", rewards: read.data.value, provenance: read.provenance, lagging: read.status === "stale" };
}

/** The state after a read: an answer replaces the view; a failure keeps it, Stale. */
export function afterRead(state: FeesState, outcome: FeesOutcome): FeesState {
  if (outcome.kind === "failed") return { ...state, latest: outcome };
  return { view: { rewards: outcome.rewards, provenance: outcome.provenance }, latest: { kind: outcome.lagging ? "lagging" : "current" } };
}

/** What the section shows now. */
export function feesDisplay(state: FeesState): FeesDisplay {
  const { view, latest } = state;
  if (!view) return latest.kind === "failed" ? { kind: "unavailable", reason: latest.reason } : { kind: "loading" };
  const stale: ListStaleness | null =
    latest.kind === "failed" ? { cause: "failed", reason: latest.reason } : latest.kind === "lagging" ? { cause: "lagging" } : null;
  return { kind: "rewards", view, stale };
}
