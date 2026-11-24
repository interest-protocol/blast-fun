import { z } from "zod";

/**
 * The launchpad's outcome-telemetry contract. It shares nothing with Mission
 * Control's telemetry: no event names, no profile or account identifiers.
 *
 * Every field is either a canonical public chain identifier (a launch ID, a
 * completed transaction's digest and event position, and that event's own
 * sender wallet, read from the chain by the server) or a value from a closed
 * list. Privy subjects, thesis text, evidence URLs, signatures and provider
 * IDs have no field to go in, and no client-supplied field holds a wallet, so
 * none can become an event name, a label, or a stored value. Visitors are
 * correlated only by a first-party opaque ID (`parseVisitorId`, minted by
 * `route.ts`).
 */

import { parseLaunchId } from "@blast/core/lib/launchpad/launch-id.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/** The denominator: a visitor saw a tradable Blast coin. */
export const COIN_VIEW_EVENT = "launchpad.coin_view.v1" as const;

/** Where the view was rendered. Adding a value needs a migration (CHECK). */
export const COIN_VIEW_SURFACES = ["coin-page"] as const;
export type CoinViewSurface = (typeof COIN_VIEW_SURFACES)[number];

export interface CoinViewEvent {
  event: typeof COIN_VIEW_EVENT;
  launchId: string;
  surface: CoinViewSurface;
}

/** Why input was refused. A bounded label: safe as a metric field. */
export type RejectionReason =
  | "shape"
  | "event"
  | "label"
  | "launch-id"
  | "visitor"
  | "completion"
  | "digest"
  | "sender"
  | "link";

export class LaunchpadTelemetryRejection extends Error {
  readonly code = "LAUNCHPAD_TELEMETRY_REJECTED";
  readonly reason: RejectionReason;

  constructor(reason: RejectionReason) {
    // The message never echoes the input: it may hold a private value.
    super(`Launchpad telemetry rejected: ${reason}.`);
    this.name = "LaunchpadTelemetryRejection";
    this.reason = reason;
  }
}

function exactRecord(
  input: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  const schema = z.strictObject(Object.fromEntries(keys.map((key) => [key, z.unknown().nonoptional()])));
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new LaunchpadTelemetryRejection("shape");
  return parsed.data;
}

function oneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  reason: RejectionReason,
): Values[number] {
  const parsed = z.enum(values).safeParse(value);
  if (!parsed.success) throw new LaunchpadTelemetryRejection(reason);
  return parsed.data;
}

/** The canonical launch ID (`lib/launchpad/launch-id.ts`); throws instead of returning null. */
export function requireLaunchId(value: unknown): string {
  const launchId = typeof value === "string" ? parseLaunchId(value) : null;
  if (!launchId) throw new LaunchpadTelemetryRejection("launch-id");
  return launchId;
}

/** Validates an untrusted coin view exactly; throws `LaunchpadTelemetryRejection`. */
export function parseCoinViewEvent(input: unknown): CoinViewEvent {
  const record = exactRecord(input, ["event", "launchId", "surface"]);
  return {
    event: oneOf(record.event, [COIN_VIEW_EVENT] as const, "event"),
    launchId: requireLaunchId(record.launchId),
    surface: oneOf(record.surface, COIN_VIEW_SURFACES, "label"),
  };
}

// A random (version 4) UUID in lowercase, as `crypto.randomUUID()` makes it.
const OPAQUE_VISITOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/**
 * The only visitor correlation value: a first-party random ID minted by the
 * ingestion route. It is never derived from a wallet, Privy subject, profile
 * or provider ID. An outcome links it to its sender wallet only through the
 * visitor's own evidence (`VisitorLink`; docs/launchpad/telemetry.md).
 */
export function parseVisitorId(value: unknown): string {
  if (!z.string().regex(OPAQUE_VISITOR_ID).safeParse(value).success) {
    throw new LaunchpadTelemetryRejection("visitor");
  }
  return value as string;
}

/**
 * How first views are counted and how long records are kept. A visitor's
 * first view of a coin counts once per period; periods are `periodDays` UTC
 * days aligned to the Unix epoch. Records older than `retentionDays` are
 * deleted by the maintenance cleanup, and the visitor cookie lasts as long.
 */
export interface ReportingPolicy {
  periodDays: number;
  retentionDays: number;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

const reportingPolicySchema = z.object({
  periodDays: z.number().int().min(1).max(31), retentionDays: z.number().int().max(400),
}).refine((policy) => policy.retentionDays >= policy.periodDays);

export function reportingPolicy(policy: ReportingPolicy): Readonly<ReportingPolicy> {
  const parsed = reportingPolicySchema.safeParse(policy);
  if (!parsed.success) throw new TypeError("Launchpad reporting policy is outside its bounds.");
  return Object.freeze(parsed.data);
}

/**
 * The one reporting policy. The service's periods and funnel range, the
 * visitor cookie's lifetime and the maintenance cleanup all read it.
 */
export const LAUNCHPAD_REPORTING_POLICY = reportingPolicy({ periodDays: 1, retentionDays: 90 });

const MINUTE_MS = 60 * 1_000;
/** How long an undecided outcome commitment is kept when the deployment sets nothing. */
export const DEFAULT_OUTCOME_COMMITMENT_WINDOW_MINUTES = 60;

/**
 * How long the maintenance cleanup keeps an outcome commitment no report has
 * decided: the deployment setting `LAUNCHPAD_OUTCOME_COMMITMENT_WINDOW_MINUTES`
 * (a whole number of minutes; anything else is the one-hour default), and
 * never longer than the reporting retention.
 */
export function outcomeCommitmentWindowMs(setting: string | undefined): number {
  const value = setting?.trim() ?? "";
  const minutes = z.string().regex(/^[1-9]\d{0,8}$/).safeParse(value).success ? Number(value) : DEFAULT_OUTCOME_COMMITMENT_WINDOW_MINUTES;
  return Math.min(minutes * MINUTE_MS, LAUNCHPAD_REPORTING_POLICY.retentionDays * DAY_MS);
}

/** The first UTC day (`YYYY-MM-DD`) of the reporting period containing `at`. */
export function reportingPeriodStart(at: Date, policy: Readonly<ReportingPolicy>): string {
  const time = at.getTime();
  if (!Number.isFinite(time)) throw new TypeError("Reporting time is invalid.");
  const day = Math.floor(time / DAY_MS);
  const start = day - (((day % policy.periodDays) + policy.periodDays) % policy.periodDays);
  return new Date(start * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Verified outcomes the launchpad flows record after their action completed
 * on chain. Each flow owns its numerator; this module only stores records.
 */
export const OUTCOME_KINDS = ["buy", "launch", "migration"] as const;
export type OutcomeKind = (typeof OUTCOME_KINDS)[number];

/**
 * Evidence that an action completed: the executed transaction's digest, the
 * position of the completed event in it, and the checkpoint that includes it.
 * A click, a simulation, a signature or a submitted digest has no checkpoint
 * or event yet, so it cannot be expressed as a completion.
 */
export interface CompletedEvent {
  status: "completed";
  checkpoint: number;
  txDigest: string;
  eventSeq: number;
  /** The checkpoint's timestamp (chain time). */
  completedAt: string;
}

/**
 * How a visitor was linked to an outcome's sender wallet, the only two ways:
 * the visitor's own verified Privy session for that wallet, or the visitor's
 * own commitment of the transaction's digest received before its checkpoint.
 */
export const VISITOR_LINKS = ["privy_session", "signed_commitment"] as const;
export type VisitorLink = (typeof VISITOR_LINKS)[number];

/**
 * A completed outcome, attributed to its event's native `sender` wallet with
 * the event's own chain facts. A visitor is present only with the way it was
 * linked (`visitorLink`); otherwise the outcome is wallet-only.
 */
export type CompletedOutcome = {
  kind: OutcomeKind;
  launchId: string;
  /** The completed event's `sender` (the transaction sender), from the chain only. */
  senderWallet: string;
  completion: CompletedEvent;
} & ({ visitorId: null; visitorLink?: never } | { visitorId: string; visitorLink: VisitorLink });

// A Sui address in canonical form: `0x` and 64 lowercase hex digits.
const CANONICAL_ADDRESS = SUI_OBJECT_ID_PATTERN;

/** A canonical Sui address (an event's sender); throws instead of normalizing. */
export function parseSenderWallet(value: unknown): string {
  if (!z.string().regex(CANONICAL_ADDRESS).safeParse(value).success) {
    throw new LaunchpadTelemetryRejection("sender");
  }
  return value as string;
}

// A Sui transaction digest: 32 bytes in Base58.
const TRANSACTION_DIGEST = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

/** The outcomes a browser may report for server verification; migrations are not among them. */
export const REPORTED_OUTCOME_KINDS = ["launch", "buy"] as const;
export type ReportedOutcomeKind = (typeof REPORTED_OUTCOME_KINDS)[number];

/**
 * A browser's report that a launch or curve Buy completed: only the kind,
 * the launch and the transaction digest. The server reads everything else
 * (success, checkpoint, event position, time) from the chain.
 */
export interface OutcomeReport {
  kind: ReportedOutcomeKind;
  launchId: string;
  txDigest: string;
}

/** Validates an untrusted outcome report exactly; throws `LaunchpadTelemetryRejection`. */
export function parseOutcomeReport(input: unknown): OutcomeReport {
  const record = exactRecord(input, ["kind", "launchId", "txDigest"]);
  const { txDigest } = record;
  if (!z.string().regex(TRANSACTION_DIGEST).safeParse(txDigest).success) {
    throw new LaunchpadTelemetryRejection("digest");
  }
  return {
    kind: oneOf(record.kind, REPORTED_OUTCOME_KINDS, "event"),
    launchId: requireLaunchId(record.launchId),
    txDigest: txDigest as string,
  };
}
/** The largest event position the store keeps (PostgreSQL INTEGER). */
const MAX_EVENT_SEQ = 2_147_483_647;

/** A real instant in its canonical `toISOString()` form, so impossible dates are refused here. */
const timestampSchema = z.string().refine((value) => {
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
});
const completedEventSchema = z.strictObject({
  status: z.literal("completed"), checkpoint: z.number().int().nonnegative(),
  txDigest: z.string().regex(TRANSACTION_DIGEST), eventSeq: z.number().int().nonnegative().max(MAX_EVENT_SEQ),
  completedAt: timestampSchema,
});

function parseCompletedEvent(input: unknown): CompletedEvent {
  const parsed = completedEventSchema.safeParse(input);
  if (!parsed.success) throw new LaunchpadTelemetryRejection("completion");
  return parsed.data;
}

const OUTCOME_FIELDS = ["kind", "launchId", "senderWallet", "visitorId", "completion"] as const;

/**
 * Validates a flow's outcome record exactly; throws `LaunchpadTelemetryRejection`.
 * `visitorLink` is present exactly when `visitorId` is not null.
 */
export function parseCompletedOutcome(input: unknown): CompletedOutcome {
  const linked = typeof input === "object" && input !== null && (input as Record<string, unknown>).visitorId !== null;
  const record = exactRecord(input, linked ? [...OUTCOME_FIELDS, "visitorLink"] : OUTCOME_FIELDS);
  const outcome = {
    kind: oneOf(record.kind, OUTCOME_KINDS, "event"),
    launchId: requireLaunchId(record.launchId),
    senderWallet: parseSenderWallet(record.senderWallet),
    completion: parseCompletedEvent(record.completion),
  };
  if (!linked) return { ...outcome, visitorId: null };
  return {
    ...outcome,
    visitorId: parseVisitorId(record.visitorId),
    visitorLink: oneOf(record.visitorLink, VISITOR_LINKS, "link"),
  };
}
