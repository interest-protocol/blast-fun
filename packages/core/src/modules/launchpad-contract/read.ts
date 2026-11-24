/**
 * The shared read types of the launchpad contract: where a chain section's
 * facts came from and how fresh they were, and a routed read's outcome.
 * Browser-safe: types and constants only.
 */

/**
 * The shape of the network name a read's source reports for itself. Blast
 * only ever serves mainnet (contracts ADR 0103, the SDK's `BLAST_NETWORKS`),
 * so any other name a source reports is a deployment mismatch, never a
 * network this app reads from.
 */
export const NETWORK_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * The networks Blast itself deploys to, mirroring the SDK's `BLAST_NETWORKS`
 * (contracts ADR 0103: mainnet only). Spelled out rather than imported
 * because this module is on the browser entry's browser-safe path, which may
 * not reach a package.
 */
export const DEPLOYMENT_NETWORKS = ["mainnet"] as const;
export type DeploymentNetwork = (typeof DEPLOYMENT_NETWORKS)[number];

/**
 * Where a read came from and how fresh it was when served: the shared
 * provenance of every chain section, from blast-infra's `/v1` `provenance` or
 * a database's `chain_read_v1.watermark`.
 */
export type Provenance = Readonly<{
  source: "replica" | "primary" | "blast-infra";
  /** The network the indexed deployment names for itself; null when unknown. */
  network: string | null;
  /** The indexed deployment: the canonical SDK's deployment fingerprint; null when unknown. */
  deployment: string | null;
  /** The committed checkpoint the answer reflects (at least); null when unknown. */
  checkpoint: number | null;
  /** That checkpoint's timestamp, in Unix ms; null when unknown. */
  timestampMs: number | null;
  /** When the source observed the answer, in Unix ms. */
  observedAt: number;
  /** How long ago (chain time) the committed checkpoint was produced when observed; null when unknown. */
  lagMs: number | null;
  /** Why a read was degraded. */
  reason?: string;
}>;

/**
 * A routed read. Unavailable carries no data at all: never zero, an empty
 * list, or a value recomputed elsewhere.
 */
export type RoutedRead<T> =
  | Readonly<{ status: "fresh" | "stale"; data: T; provenance: Provenance }>
  | Readonly<{ status: "unavailable"; provenance: Provenance }>;
