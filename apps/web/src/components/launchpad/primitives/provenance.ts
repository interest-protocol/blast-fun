import type { Provenance } from "@blast/core/modules/launchpad-contract/read.ts";

/**
 * Where a set of facts came from. Every field is what the source reported;
 * anything it did not report is null and shown as "Unknown", never zero.
 */
export type ProvenanceRecord = Readonly<{
  /** The network the source names for itself, such as "mainnet". */
  network: string | null;
  /** Package ID or deployment fingerprint the facts were read from. */
  deployment: string | null;
  /** Last checkpoint the source had processed. */
  checkpoint: string | null;
  /** ISO 8601 time the source observed the facts. */
  observedAt: string | null;
  /** How far the source was behind the chain head, in milliseconds. */
  lagMs: number | null;
}>;

export function provenanceRecord(provenance: Provenance): ProvenanceRecord {
  return {
    network: provenance.network,
    deployment: provenance.deployment,
    checkpoint: provenance.checkpoint === null ? null : String(provenance.checkpoint),
    observedAt: new Date(provenance.observedAt).toISOString(),
    lagMs: provenance.lagMs,
  };
}

export type ProvenanceItem = Readonly<{
  term: "Network" | "Deployment" | "Checkpoint" | "Observed" | "Lag";
  value: string;
  /** The whole value when `value` abbreviates it. */
  full?: string;
  /** Machine-readable time for a `<time>` element. */
  dateTime?: string;
}>;

const UNKNOWN = "Unknown";
const ABBREVIATE_OVER = 20;

/** Human lag behind the chain head; impossible or missing values read Unknown. */
export function formatLag(lagMs: number | null): string {
  if (lagMs === null || !Number.isFinite(lagMs) || lagMs < 0) return UNKNOWN;
  if (lagMs < 1000) return "Under 1 s behind";
  if (lagMs < 10_000) return `${Math.floor(lagMs / 100) / 10} s behind`;
  const seconds = Math.floor(lagMs / 1000);
  if (seconds < 60) return `${seconds} s behind`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${seconds % 60} s behind`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min behind`;
}

function describeDeployment(deployment: string | null): ProvenanceItem {
  if (!deployment) return { term: "Deployment", value: UNKNOWN };
  if (deployment.length <= ABBREVIATE_OVER) return { term: "Deployment", value: deployment };
  return {
    term: "Deployment",
    value: `${deployment.slice(0, 6)}…${deployment.slice(-4)}`,
    full: deployment,
  };
}

function describeCheckpoint(checkpoint: string | null): ProvenanceItem {
  if (!checkpoint || !/^\d+$/.test(checkpoint)) return { term: "Checkpoint", value: UNKNOWN };
  return { term: "Checkpoint", value: BigInt(checkpoint).toLocaleString("en-US") };
}

function describeObserved(observedAt: string | null): ProvenanceItem {
  const time = Date.parse(observedAt ?? "");
  if (!Number.isFinite(time)) return { term: "Observed", value: UNKNOWN };
  const iso = new Date(time).toISOString();
  return { term: "Observed", value: `${iso.slice(0, 10)} ${iso.slice(11, 19)} UTC`, dateTime: iso };
}

/**
 * Provenance as labeled facts, in reading order. Times are absolute UTC so
 * the server and the browser render the same text.
 */
export function describeProvenance(record: ProvenanceRecord): ProvenanceItem[] {
  return [
    { term: "Network", value: record.network ? `Sui ${record.network}` : UNKNOWN },
    describeDeployment(record.deployment),
    describeCheckpoint(record.checkpoint),
    describeObserved(record.observedAt),
    { term: "Lag", value: formatLag(record.lagMs) },
  ];
}
