import { z } from "zod";
import { matchesSchema, contractValue, contractObject, recordSchema, ContractViolation, parseAtomic, parseCount } from "./decimal.ts";
import { DEPLOYMENT_NETWORKS, NETWORK_NAME, type DeploymentNetwork, type Provenance } from "./read.ts";

export { DEPLOYMENT_NETWORKS, type DeploymentNetwork } from "./read.ts";

/**
 * The provenance every chain section carries, parsed from its two sources:
 * blast-infra's `/v1` `provenance` object (docs/api.md, "Provenance") and a
 * database's `chain_read_v1.watermark` row, which blast-infra publishes. Both
 * name the indexed network and SDK deployment fingerprint, the committed
 * checkpoint and its timestamp, when the source observed the answer, and the
 * lag between the two.
 */

/** The deployment this web app serves, from its SDK deployment manifest. */
/**
 * The deployment this app serves. Its network is one the SDK deploys to, so
 * it is always mainnet; a source naming any other network is a mismatch.
 */
export type ExpectedDeployment = Readonly<{ network: DeploymentNetwork; deployment: string }>;

const FINGERPRINT = /^[0-9a-f]{64}$/;
const WIRE_KEYS = ["network", "deployment_fingerprint", "checkpoint", "timestamp_ms", "observed_ms", "lag_ms"];

const fingerprintSchema = z.string().regex(FINGERPRINT);
/** Optional engine hop stamps on live frames (`provenance.hops`): timing only, never read as data. */
/** `null` (whole map or one hop) means "not stamped"; the cap keeps hello provenance inside the 1 KiB hint budget. */
const hopsSchema = z.record(z.string().regex(/^[a-z0-9_]{1,24}$/), z.number().int().nonnegative().nullable())
  .refine((hops) => Object.keys(hops).length <= 8);
const WIRE_OPTIONAL = [...WIRE_KEYS, "hops"];

function network(value: unknown, field: string): string {
  return contractValue(z.string().regex(NETWORK_NAME), value, field, "must be a network name");
}

function fingerprint(value: unknown, field: string): string {
  if (!matchesSchema(fingerprintSchema, value)) {
    throw new ContractViolation(field, "must be a 64-hex deployment fingerprint");
  }
  return value;
}

/** checkpoint, timestamp and lag are all present, or all null (before the first checkpoint). */
function checkpointFields<T>(
  values: readonly [unknown, unknown, unknown],
  parse: (value: unknown, field: string) => T,
  prefix: string,
) {
  const [checkpoint, timestampMs, lagMs] = values;
  if (checkpoint === null && timestampMs === null && lagMs === null) {
    return { checkpoint: null, timestampMs: null, lagMs: null };
  }
  return {
    checkpoint: parse(checkpoint, `${prefix}.checkpoint`),
    timestampMs: parse(timestampMs, `${prefix}.timestamp_ms`),
    lagMs: parse(lagMs, `${prefix}.lag_ms`),
  };
}

/** blast-infra's `provenance` object, exactly as its `common/provenance` schema allows. */
export function parseInfraProvenance(value: unknown): Provenance {
  const wire = contractObject(value, "provenance", WIRE_KEYS, WIRE_OPTIONAL);
  if (wire.hops != null) contractValue(hopsSchema, wire.hops, "provenance.hops", "must map hop names to millisecond counts");
  return {
    source: "blast-infra",
    network: network(wire.network, "provenance.network"),
    // Presales-only infra has no launchpad deployment yet.
    deployment: wire.deployment_fingerprint === null ? null : fingerprint(wire.deployment_fingerprint, "provenance.deployment_fingerprint"),
    ...checkpointFields([wire.checkpoint, wire.timestamp_ms, wire.lag_ms], parseCount, "provenance"),
    observedAt: parseCount(wire.observed_ms, "provenance.observed_ms"),
  };
}

/** A pg BIGINT, which node-postgres reads as a decimal string, as a safe integer. */
function bigintColumn(value: unknown, field: string): number {
  const parsed = parseAtomic(value, field);
  if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) throw new ContractViolation(field, "must be a safe integer");
  return Number(parsed);
}

/** A `chain_read_v1.watermark` row read on `source`. No row: blast-infra never started there. */
export function parseWatermarkRow(row: unknown, source: "replica" | "primary"): Provenance {
  const columns = contractValue(recordSchema, row, "chain_read_v1.watermark", "has no row: blast-infra has not started on this database");
  return {
    source,
    network: network(columns.network, "watermark.network"),
    deployment: fingerprint(columns.deployment_fingerprint, "watermark.deployment_fingerprint"),
    ...checkpointFields([columns.checkpoint, columns.timestamp_ms, columns.lag_ms], bigintColumn, "watermark"),
    observedAt: bigintColumn(columns.observed_ms, "watermark.observed_ms"),
  };
}

/**
 * The deployment this app serves, from `BLAST_NETWORK` and
 * `BLAST_DEPLOYMENT_FINGERPRINT` (the SDK manifest's network and
 * `deploymentFingerprint`), or null when neither is set. One without the
 * other is a configuration error.
 */
export function expectedDeployment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ExpectedDeployment | null {
  const network = environment.BLAST_NETWORK?.trim();
  const deployment = environment.BLAST_DEPLOYMENT_FINGERPRINT?.trim();
  if (!network && !deployment) return null;
  const parsed = z.object({ network: z.enum(DEPLOYMENT_NETWORKS), deployment: z.string().regex(FINGERPRINT) }).safeParse({ network, deployment });
  if (!parsed.success) {
    throw new Error("BLAST_NETWORK (mainnet) and BLAST_DEPLOYMENT_FINGERPRINT (64 lowercase hex) are set together.");
  }
  return parsed.data;
}

/** Fresh within `maxLagMs`, stale beyond it; no committed checkpoint is not freshness at all. */
export function freshness(provenance: Provenance, maxLagMs: number): "fresh" | "stale" | "no-checkpoint" {
  if (provenance.checkpoint === null || provenance.lagMs === null) return "no-checkpoint";
  return provenance.lagMs <= maxLagMs ? "fresh" : "stale";
}

/** Why `provenance` is not the expected deployment, or null. Without an expectation nothing is checked. */
export function deploymentMismatch(
  provenance: Provenance,
  expected: ExpectedDeployment | null,
): "network-mismatch" | "deployment-mismatch" | null {
  if (expected === null) return null;
  if (provenance.network !== expected.network) return "network-mismatch";
  if (provenance.deployment !== expected.deployment) return "deployment-mismatch";
  return null;
}
