import { z } from "zod";
import { contractObject, contractValue, recordSchema, ContractViolation, parseCount } from "@blast/core/modules/launchpad-contract/decimal.ts";
import type { Provenance, RoutedRead } from "@blast/core/modules/launchpad-contract/read.ts";
import { NETWORK_NAME } from "@blast/core/modules/launchpad-contract/read.ts";

/**
 * One launchpad section as `/api/launchpad` serves it. Only `available` and
 * `stale` carry data, so a missing fact can never be served as zero, an empty
 * list or a sample value:
 *
 * - `available`: the source answered within its freshness policy;
 * - `stale`: it answered, but its committed checkpoint is older than the
 *   policy allows (`reason` says why);
 * - `empty`: it answered, current, and there is nothing (no holders yet);
 * - `unavailable`: no answer (`reason`), perhaps with when to retry.
 *
 * Every answered section names its provenance. A section never authorizes a
 * transaction: signing reads its facts from the SDK, not from a snapshot.
 */
export type Section<T> =
  | Readonly<{ state: "available"; data: T; provenance: Provenance }>
  | Readonly<{ state: "stale"; data: T; provenance: Provenance; reason: string }>
  | Readonly<{ state: "empty"; provenance: Provenance }>
  | Readonly<{ state: "unavailable"; reason: string; retryAfterSeconds?: number; provenance?: Provenance }>;

/** A routed read as a section; `isEmpty` says when current data means "nothing". */
export function sectionFromRead<T>(read: RoutedRead<T>, isEmpty: (data: T) => boolean): Section<T> {
  if (read.status === "unavailable") {
    return { state: "unavailable", reason: read.provenance.reason ?? "unavailable", provenance: read.provenance };
  }
  if (read.status === "stale") {
    return { state: "stale", data: read.data, provenance: read.provenance, reason: read.provenance.reason ?? "stale" };
  }
  return isEmpty(read.data)
    ? { state: "empty", provenance: read.provenance }
    : { state: "available", data: read.data, provenance: read.provenance };
}

const SOURCES = ["replica", "primary", "blast-infra"] as const;
const PROVENANCE_KEYS = ["source", "network", "deployment", "checkpoint", "timestampMs", "observedAt", "lagMs", "reason"];

function nullable<T>(value: unknown, parse: (value: unknown) => T): T | null {
  return value === null ? null : parse(value);
}

function text(value: unknown, field: string): string {
  return contractValue(z.string().min(1).max(200), value, field, "must be a non-empty string");
}

/** A section's provenance as served. */
export function parseProvenance(value: unknown, field = "provenance"): Provenance {
  const record = object(value, field);
  only(record, PROVENANCE_KEYS, field);
  const source = contractValue(z.enum(SOURCES), record.source, `${field}.source`, "is unknown");
  return {
    source,
    network: nullable(record.network, (item) => {
      return contractValue(z.string().regex(NETWORK_NAME), item, `${field}.network`, "must be a network name");
    }),
    deployment: nullable(record.deployment, (item) => text(item, `${field}.deployment`)),
    checkpoint: nullable(record.checkpoint, (item) => parseCount(item, `${field}.checkpoint`)),
    timestampMs: nullable(record.timestampMs, (item) => parseCount(item, `${field}.timestampMs`)),
    observedAt: parseCount(record.observedAt, `${field}.observedAt`),
    lagMs: nullable(record.lagMs, (item) => parseCount(item, `${field}.lagMs`)),
    ...(record.reason === undefined ? {} : { reason: text(record.reason, `${field}.reason`) }),
  };
}

function object(value: unknown, field: string): Record<string, unknown> {
  return contractValue(recordSchema, value, field, "must be an object");
}

function only(record: Record<string, unknown>, keys: readonly string[], field: string): void {
  try {
    contractObject(record, field, keys, keys);
  } catch (error) {
    if (error instanceof ContractViolation) throw new ContractViolation(error.field, "is not allowed here");
    throw error;
  }
}

/** A served section, strictly in its state's shape; `parseData` validates the data. */
export function parseSection<T>(value: unknown, parseData: (data: unknown) => T, field = "section"): Section<T> {
  const record = object(value, field);
  switch (record.state) {
    case "available":
      only(record, ["state", "data", "provenance"], field);
      if (!("data" in record)) throw new ContractViolation(`${field}.data`, "is required");
      return { state: "available", data: parseData(record.data), provenance: parseProvenance(record.provenance) };
    case "stale":
      only(record, ["state", "data", "provenance", "reason"], field);
      if (!("data" in record)) throw new ContractViolation(`${field}.data`, "is required");
      return {
        state: "stale",
        data: parseData(record.data),
        provenance: parseProvenance(record.provenance),
        reason: text(record.reason, `${field}.reason`),
      };
    case "empty":
      only(record, ["state", "provenance"], field);
      return { state: "empty", provenance: parseProvenance(record.provenance) };
    case "unavailable":
      only(record, ["state", "reason", "retryAfterSeconds", "provenance"], field);
      return {
        state: "unavailable",
        reason: text(record.reason, `${field}.reason`),
        ...(record.retryAfterSeconds === undefined
          ? {}
          : { retryAfterSeconds: parseCount(record.retryAfterSeconds, `${field}.retryAfterSeconds`) }),
        ...(record.provenance === undefined ? {} : { provenance: parseProvenance(record.provenance) }),
      };
    default:
      throw new ContractViolation(`${field}.state`, "must be available, stale, empty or unavailable");
  }
}

/**
 * Independent sections of one response, such as a launch's holders, social,
 * identity and venue: each parses on its own, and one that is missing or
 * breaks the contract is unavailable (`contract-violation`) without touching
 * the others.
 */
export function parseSections<P extends Record<string, (data: unknown) => unknown>>(
  value: unknown,
  parsers: P,
): { [K in keyof P]: Section<ReturnType<P[K]>> } {
  const envelope = recordSchema.safeParse(value);
  const record = envelope.success ? envelope.data : {};
  const sections = {} as { [K in keyof P]: Section<ReturnType<P[K]>> };
  for (const name of Object.keys(parsers) as (keyof P & string)[]) {
    try {
      sections[name] = parseSection(record[name], parsers[name], name) as Section<ReturnType<P[typeof name]>>;
    } catch (error) {
      if (!(error instanceof ContractViolation)) throw error;
      sections[name] = { state: "unavailable", reason: "contract-violation" };
    }
  }
  return sections;
}
