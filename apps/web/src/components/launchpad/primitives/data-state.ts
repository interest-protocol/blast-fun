import type { Section } from "@blast/core/modules/launchpad-contract/section.ts";

import { provenanceRecord, type ProvenanceRecord } from "./provenance";

/**
 * The honest state of one terminal section's facts. Only `ready` and `stale`
 * carry a value, so a section can never fill a missing fact with zero or
 * sample data. `stale` always holds facts that were once `ready`.
 */
export type SectionState<T> =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "empty"; provenance?: ProvenanceRecord }>
  | Readonly<{ status: "unavailable"; reason: string }>
  | Readonly<{ status: "ready"; value: T; provenance: ProvenanceRecord }>
  | Readonly<{ status: "stale"; value: T; provenance: ProvenanceRecord; reason: string }>;

export function mapSectionState<T>(
  section: Section<T>,
  describeReason: (reason: string) => string,
  formatStaleReason: (reason: string) => string = (reason) => reason,
): Exclude<SectionState<T>, { status: "loading" }> {
  switch (section.state) {
    case "available":
      return { status: "ready", value: section.data, provenance: provenanceRecord(section.provenance) };
    case "stale":
      return {
        status: "stale",
        value: section.data,
        provenance: provenanceRecord(section.provenance),
        reason: formatStaleReason(describeReason(section.reason)),
      };
    case "empty":
      return { status: "empty", provenance: provenanceRecord(section.provenance) };
    case "unavailable":
      return { status: "unavailable", reason: describeReason(section.reason) };
  }
}

export const DATA_STATE_KINDS = ["loading", "empty", "unavailable", "stale"] as const;
export type DataStateKind = (typeof DATA_STATE_KINDS)[number];

/** A shape drawn next to the label, so no state depends on color alone. */
export type DataStateGlyph = "dotted-ring" | "hollow-ring" | "slashed-ring" | "clock";

const PRESENTATION: Record<
  DataStateKind,
  Readonly<{ label: string; glyph: DataStateGlyph; showsFacts: boolean; busy: boolean }>
> = {
  loading: { label: "Loading", glyph: "dotted-ring", showsFacts: false, busy: true },
  empty: { label: "Empty", glyph: "hollow-ring", showsFacts: false, busy: false },
  unavailable: { label: "Unavailable", glyph: "slashed-ring", showsFacts: false, busy: false },
  stale: { label: "Delayed", glyph: "clock", showsFacts: true, busy: false },
};

/** Visible label, shape, and semantics for a non-ready state. */
export function dataStatePresentation(kind: DataStateKind) {
  return PRESENTATION[kind];
}

/**
 * The state after a refresh fails. Verified facts stay on screen as Stale;
 * without verified facts the section is Unavailable.
 */
export function refreshFailed<T>(previous: SectionState<T>, reason: string): SectionState<T> {
  if (previous.status === "ready" || previous.status === "stale") {
    return { status: "stale", value: previous.value, provenance: previous.provenance, reason };
  }
  return { status: "unavailable", reason };
}

function formatAge(ms: number): string {
  return ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`;
}

/**
 * Marks ready facts Stale once their observation is older than `maxAgeMs`.
 * Facts without a readable observation time are never presumed fresh.
 */
export function ageSectionState<T>(
  state: SectionState<T>,
  now: number,
  maxAgeMs: number,
): SectionState<T> {
  if (state.status !== "ready") return state;
  const observed = Date.parse(state.provenance.observedAt ?? "");
  if (Number.isFinite(observed) && now - observed <= maxAgeMs) return state;
  const reason = Number.isFinite(observed)
    ? `Not refreshed for more than ${formatAge(maxAgeMs)}`
    : "Observation time unknown";
  return { status: "stale", value: state.value, provenance: state.provenance, reason };
}
