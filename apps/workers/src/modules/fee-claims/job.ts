import { z } from "zod";

// Daily launch protocol-fee claims. Vault collection and payouts belong to the unified keeper jobs.

import type { LaunchState } from "@interest-protocol/blast-launchpad-sdk";
import type { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiObjectId } from "@mysten/sui/utils";

import { readLaunch, readLaunches, readPartner, type LaunchRead, type SharedRef } from "../blast-keeper/chain.ts";
import { discoverCurveLaunches } from "../blast-keeper/launch-discovery.ts";
import { MAX_RECORDS_PER_TRANSACTION, SignerRefusal, type KeeperSigner } from "../blast-keeper/signer.ts";
import { keeperTransaction, keeperActionSchema, type KeeperActionIntent } from "../blast-keeper/transactions.ts";
import type { KeeperAlerts } from "../worker-runtime/alerts.ts";
import { chunks, simulateSignSendBatch, type BatchOutcome, type BatchRecord } from "../worker-runtime/batch.ts";
import { checkIndex } from "../worker-runtime/index-identity.ts";
import { WORKER_METRICS } from "../worker-runtime/log.ts";
import {
  classifyFailure,
  keepRecords,
  passCounts,
  retryDelayMs,
  triesAlone,
  type RetryVisit,
} from "../worker-runtime/record-keeper.ts";
import type { JobContext as RuntimeJobContext, JobPass, WorkerJob, ProtocolWorkerAccess } from "../worker-runtime/runtime.ts";
import {
  dueRecords,
  FEE_CLAIM_JOB,
  readBacklog,
  recordClaimed,
  recordClaimSubmissions,
  recordClosed,
  recordIdentity,
  recordLaunches,
  recordRetry,
  recordVisited,
  type FeeClaimRecord,
} from "./repository.ts";
import { coinValueMist, curveMemeInQuote, readPrices, SUI_TYPE, type CoinPrice } from "./value.ts";

type JobContext = RuntimeJobContext<ProtocolWorkerAccess, KeeperSigner>;

export type FeeClaimJobOptions = Readonly<{
  alerts: KeeperAlerts;
  /** How often each launch is visited. */
  intervalMs: number;
  /** A claim is sent only when worth at least this many times its simulated gas. */
  gasMultiple: bigint;
}>;

export type FeeClaimKind = "curve";

export type FeeClaimErrorClass =
  // Retried, uncounted.
  | "provider-unavailable"
  | "database-unavailable"
  | "launch-unavailable"
  | "launch-unreadable"
  | "partner-unreadable"
  | "signer-busy"
  | "insufficient-gas"
  // Retried, counted (only the backoff grows).
  | "simulation-failed"
  | "execution-failed"
  | "submission-unknown"
  | "internal-error"
  // Retried, uncounted: another launch's claim failed the transaction.
  | "batch-failed"
  // Final.
  | "foreign-lineage"
  | "signer-refused";

/** One claim's outcome within a visit. */
export type ClaimOutcome =
  | Readonly<{ outcome: "claimed"; valueMist: bigint; gasMist: bigint }>
  | Readonly<{ outcome: "nothing" | "below-threshold" | "unpriced" }>
  | Omit<RetryVisit<FeeClaimErrorClass>, "refunded">;

export type FeeClaimVisit =
  | Readonly<{ outcome: "visited"; claims: Readonly<Partial<Record<FeeClaimKind, ClaimOutcome>>> }>
  | Readonly<{ outcome: "complete" }>
  | Omit<RetryVisit<FeeClaimErrorClass>, "refunded"> & Readonly<{ overdue: boolean }>
  | Readonly<{ outcome: "rejected" | "stalled"; errorClass: FeeClaimErrorClass }>
  | Readonly<{ outcome: "skipped" }>;

export function overdueKey(launchId: string): string {
  return `fee_claim_overdue:${launchId}`;
}

/** One claim ready to send: its commands and intent, its value, and the launch it belongs to. */
type Claim = BatchRecord<KeeperActionIntent> & Readonly<{ kind: FeeClaimKind; valueMist: bigint; launch: Examined }>;

/**
 * A launch examined under its lease: its claim outcomes so far, and the
 * claims still to send. `reread` is the launch as the batch's reconciliation
 * read it, after its claims were sent.
 */
type Examined = {
  readonly record: FeeClaimRecord;
  readonly leaseKey: string;
  readonly migrated: boolean;
  readonly partner: SharedRef | null;
  readonly claims: Partial<Record<FeeClaimKind, ClaimOutcome>>;
  readonly pending: Claim[];
  reread: LaunchRead | null;
};

type ClaimDraft = Readonly<{
  kind: FeeClaimKind;
  valueMist: bigint;
  intent: KeeperActionIntent;
  add(transaction: Transaction): void;
}>;

/** A claim worth considering: unpriced is never sent, nor anything while the signer gate is closed. */
function draftOutcome(context: JobContext, draft: ClaimDraft): ClaimOutcome | null {
  if (draft.valueMist === 0n) return { outcome: "unpriced" };
  if (!context.canSign()) return { outcome: "retry", errorClass: "signer-busy" };
  return null;
}

/** How one sent claim went, from its batch's outcome. */
function claimOutcome(claim: Claim, { attempt, blame }: BatchOutcome<unknown>, records: number): ClaimOutcome {
  switch (attempt.outcome) {
    case "executed": {
      const gasMist = (attempt.gasCostMist ?? 0n) / BigInt(records);
      return { outcome: "claimed", valueMist: claim.valueMist, gasMist };
    }
    case "not-submitted":
      if (attempt.reason === "not-admitted") return { outcome: "below-threshold" };
      if (attempt.reason === "insufficient-gas") return { outcome: "retry", errorClass: attempt.reason };
      return { outcome: "retry", errorClass: "signer-busy" };
    case "simulation-failed":
      return { outcome: "retry", errorClass: "simulation-failed", counted: true };
    case "failed":
      // Another launch's claim failed the transaction: due again soon, its backoff not grown.
      return blame === "another"
        ? { outcome: "retry", errorClass: "batch-failed" }
        : { outcome: "retry", errorClass: "execution-failed", counted: true };
    default:
      return { outcome: "retry", errorClass: "submission-unknown", counted: true };
  }
}

function types(launch: LaunchState): [string, string] {
  return [normalizeStructTag(launch.memeType), normalizeStructTag(launch.quoteType)];
}

/** The curve ledger's worth: SUI, Quote, and Meme at the curve's spot price while it trades. */
function curveValueMist(launch: LaunchState, prices: ReadonlyMap<string, CoinPrice>): bigint {
  const trading = launch.lifecycle === "Live" || launch.lifecycle === "MigrationReady";
  const memeQuote = trading ? curveMemeInQuote(launch.protocolFees.meme, launch) : 0n;
  return launch.protocolFees.sui + coinValueMist(launch.protocolFees.quote + memeQuote, launch.quoteType, prices);
}

function curveClaim(
  context: JobContext,
  launch: LaunchState,
  partner: SharedRef | null,
  prices: ReadonlyMap<string, CoinPrice>,
): ClaimOutcome | ClaimDraft {
  if (launch.protocolFees.meme === 0n && launch.protocolFees.quote === 0n && launch.protocolFees.sui === 0n) {
    return { outcome: "nothing" };
  }
  const [memeType, quoteType] = types(launch);
  const intent: KeeperActionIntent = {
    kind: "launch-fees", object: { objectId: launch.objectId, initialSharedVersion: String(launch.initialSharedVersion) },
    memeType, quoteType, partner,
  };
  return {
    kind: "curve", valueMist: curveValueMist(launch, prices), intent,
    add: (transaction) => { keeperTransaction(context.deployment, intent, transaction); },
  };
}

/** The launch and its partner, read fresh and checked against the record; a visit when the pass ends here. */
async function readClaimLaunch(
  context: JobContext,
  record: FeeClaimRecord,
): Promise<FeeClaimVisit | Readonly<{ launch: LaunchState; partner: SharedRef | null }>> {
  const { client, provider, deployment } = context;
  const read = await readLaunch(
    client,
    record.launchId,
    deployment.packages.launchpad.originalPackageId,
    provider,
  );
  if (read.kind === "missing") {
    return { outcome: "retry", errorClass: "launch-unavailable", overdue: false };
  }
  if (read.kind === "unreadable") {
    return { outcome: "retry", errorClass: "launch-unreadable", overdue: false };
  }
  if (read.kind === "foreign") {
    return { outcome: "rejected", errorClass: "foreign-lineage" };
  }
  const launch = read.launch;
  if (
    normalizeStructTag(launch.memeType) !== normalizeStructTag(record.memeType) ||
    normalizeStructTag(launch.quoteType) !== normalizeStructTag(record.quoteType)
  ) {
    return { outcome: "rejected", errorClass: "foreign-lineage" };
  }
  // The partner is the launch's own, from the chain.
  if (!launch.partnerId) return { launch, partner: null };
  const partner = await readPartner(
    client,
    launch.partnerId,
    deployment.packages.partners.originalPackageId,
    provider,
  );
  return partner ? { launch, partner } : { outcome: "retry", errorClass: "partner-unreadable", overdue: false };
}

/**
 * Everything before signing, from fresh reads: a visit when the launch's pass
 * ends here, or the launch with its claim outcomes so far and the claims
 * still to send.
 */
async function examine(
  context: JobContext,
  options: FeeClaimJobOptions,
  record: FeeClaimRecord,
  leaseKey: string,
): Promise<FeeClaimVisit | Examined> {
  const read = await readClaimLaunch(context, record);
  if ("outcome" in read) return read;
  const { launch, partner } = read;
  const migrated = launch.lifecycle === "Migrated";
  if (record.partnerId !== launch.partnerId) await recordIdentity(context.pool, record, launch.partnerId);
  const prices = await readPrices(context.pool, [SUI_TYPE, launch.quoteType, launch.memeType]);

  const examined: Examined = { record, leaseKey, migrated, partner, claims: {}, pending: [], reread: null };
  const drafts: Array<[FeeClaimKind, ClaimOutcome | ClaimDraft]> = [["curve", curveClaim(context, launch, partner, prices)]];
  for (const [kind, draft] of drafts) {
    const decided = "outcome" in draft ? draft : draftOutcome(context, draft);
    if (decided) examined.claims[kind] = decided;
    else examined.pending.push({ ...(draft as ClaimDraft), key: `${record.launchId}:${kind}`, launch: examined });
  }
  return examined;
}

function retryingClaim(
  claims: Partial<Record<FeeClaimKind, ClaimOutcome>>,
): Extract<FeeClaimVisit, { outcome: "retry" }> | null {
  const retries = Object.values(claims).filter(
    (claim): claim is Extract<ClaimOutcome, { outcome: "retry" }> => claim.outcome === "retry",
  );
  if (retries.length) {
    const first = retries.find((claim) => claim.counted) ?? retries[0]!;
    return {
      outcome: "retry",
      errorClass: first.errorClass,
      counted: retries.some((claim) => claim.counted),
      overdue: retries.some((claim) => claim.counted),
    };
  }
  return null;
}

/** The launch's visit once every claim has an outcome. */
async function examinedVisit(context: JobContext, examined: Examined): Promise<FeeClaimVisit> {
  return retryingClaim(examined.claims) ?? closeCompletedCurve(context, examined);
}

async function closeCompletedCurve(context: JobContext, examined: Examined): Promise<FeeClaimVisit> {
  const { client, deployment, provider, pool } = context;
  const { record, migrated, partner, claims } = examined;
  // Nothing accrues to an unpartnered migrated launch's curve ledger again, and its vault needs no claim.
  if (
    migrated &&
    !partner &&
    (claims.curve?.outcome === "nothing" || claims.curve?.outcome === "claimed")
  ) {
    // After a claim, the batch's reconciliation already read it fresh.
    const fresh = examined.reread ?? await readLaunch(
      client,
      record.launchId,
      deployment.packages.launchpad.originalPackageId,
      provider,
    );
    const empty =
      fresh.kind === "launch" &&
      fresh.launch.protocolFees.meme === 0n &&
      fresh.launch.protocolFees.quote === 0n &&
      fresh.launch.protocolFees.sui === 0n;
    if (empty) {
      return (await recordClosed(pool, record, "complete"))
        ? { outcome: "complete" }
        : { outcome: "skipped" };
    }
  }
  return { outcome: "visited", claims };
}

/** A failure ends the visit as for every keeper job; a retry for it raises no overdue alert. */
export function classifyFeeClaimError(error: unknown): FeeClaimVisit {
  const visit = classifyFailure(error);
  return visit.outcome === "retry" ? { ...visit, overdue: false } : visit;
}

/**
 * Sends `claims` (of launches examined this pass) in as few transactions as
 * their failures allow, most valuable first, sized to what the address
 * balance pays. A transaction is admitted when its claims together are worth
 * at least `feeClaimGasMultiple` times its simulated gas; one that is not
 * drops its least valuable claim (`below-threshold`) and tries again. Each
 * claim's outcome lands on its launch. After the last lease renewal each
 * transaction makes at most three node calls (submit, wait, one read of every
 * launch), as the lease TTL assumes.
 */
async function sendClaims(context: JobContext, options: FeeClaimJobOptions, claims: readonly Claim[]): Promise<void> {
  const affordable = await context.affordableRecords();
  if (affordable === 0) {
    for (const claim of claims) claim.launch.claims[claim.kind] = { outcome: "retry", errorClass: "insufficient-gas" };
    return;
  }
  for (const part of chunks([...claims].sort(mostValuableFirst), affordable)) {
    const held = await heldClaims(context, part);
    if (held.length > 0) await sendHeldClaims(context, options, held);
  }
}

/** Examining the batch took time: the claims of launches whose leases are still ours. */
async function heldClaims(context: JobContext, claims: readonly Claim[]): Promise<Claim[]> {
  const held: Claim[] = [];
  for (const examined of launchesOf(claims)) {
    const mine = claims.filter((claim) => claim.launch === examined);
    if (await context.leases.renew(FEE_CLAIM_JOB, examined.leaseKey)) held.push(...mine);
    else for (const claim of mine) examined.claims[claim.kind] = { outcome: "retry", errorClass: "signer-busy" };
  }
  return held;
}

function mostValuableFirst(left: Claim, right: Claim): number {
  return right.valueMist > left.valueMist ? 1 : right.valueMist < left.valueMist ? -1 : 0;
}

function launchesOf(claims: readonly Claim[]): Examined[] {
  return [...new Set(claims.map((claim) => claim.launch))];
}

/** Sends one chunk of claims whose launches' leases are held, and puts each claim's outcome on its launch. */
async function sendHeldClaims(context: JobContext, options: FeeClaimJobOptions, held: readonly Claim[]): Promise<void> {
  const { client, pool, provider, deployment, leases } = context;
  const outcomes = await simulateSignSendBatch(context, held, {
    beforeSubmit: async (digest, records) => {
      const launches = launchesOf(records);
      for (const examined of launches) {
        if (!(await leases.renew(FEE_CLAIM_JOB, examined.leaseKey))) return false;
      }
      return recordClaimSubmissions(pool, launches.map((examined) => examined.record), digest);
    },
    reconcile: (records) => readLaunches(
      client,
      launchesOf(records).map((examined) => examined.record.launchId),
      deployment.packages.launchpad.originalPackageId,
      provider,
    ),
    admit: (gasCostMist, records) =>
      records.reduce((total, claim) => total + claim.valueMist, 0n) >= options.gasMultiple * gasCostMist,
  });
  for (const [claim, outcome] of outcomes) {
    const records = [...outcomes.values()].filter((other) => other.attempt === outcome.attempt).length;
    await landClaimOutcome(context, claim, outcome, records);
  }
}

/** Puts one sent claim's outcome on its launch, records a claim that executed, and reports it. */
async function landClaimOutcome(
  context: JobContext,
  claim: Claim,
  outcome: BatchOutcome<ReadonlyMap<string, LaunchRead>>,
  records: number,
): Promise<void> {
  const { attempt } = outcome;
  const result = claimOutcome(claim, outcome, records);
  claim.launch.claims[claim.kind] = result;
  claim.launch.reread = attempt.reconciled?.get(normalizeSuiObjectId(claim.launch.record.launchId)) ?? claim.launch.reread;
  context.log(WORKER_METRICS.feeClaimAttempt, {
    kind: claim.kind,
    outcome: attempt.outcome,
    reason: attempt.reason ?? null,
    valueMist: String(claim.valueMist),
    gasMist: attempt.gasCostMist === undefined ? null : String(attempt.gasCostMist),
    records,
  });
  context.log(WORKER_METRICS.feeClaimRecord, {
    launchId: claim.launch.record.launchId, kind: claim.kind, outcome: attempt.outcome, digest: attempt.digest,
  });
  if (result.outcome !== "claimed") return;
  await recordClaimed(context.pool, claim.launch.record);
  context.log(WORKER_METRICS.feeClaimClaimed, {
    kind: claim.kind,
    partnered: (claim.intent.kind === "launch-fees" && claim.intent.partner !== null),
    valueMist: String(claim.valueMist),
    gasMist: String(result.gasMist),
  });
}

/** Records how a launch's visit ended, while its lease is held. */
async function record(
  context: JobContext,
  options: FeeClaimJobOptions,
  row: FeeClaimRecord,
  visit: FeeClaimVisit,
): Promise<void> {
  const { pool } = context;
  if (visit.outcome === "retry") {
    await recordRetry(pool, row, visit.errorClass, retryDelayMs(context.backoffMs, row.attempts, {}), visit.counted ?? false);
  } else if (visit.outcome === "visited") {
    await recordVisited(pool, row, options.intervalMs);
  } else if (visit.outcome === "rejected" || visit.outcome === "stalled") {
    await recordClosed(pool, row, visit.outcome, visit.errorClass);
  }
}

/** Raises or clears the launch's alert, and reports its visit. */
async function report(
  context: JobContext,
  options: FeeClaimJobOptions,
  row: FeeClaimRecord,
  visit: FeeClaimVisit,
): Promise<void> {
  // Worth claiming and failing: alert once that lasts longer than the cadence.
  if (visit.outcome === "retry" && visit.overdue) {
    await options.alerts.raise(
      overdueKey(row.launchId),
      { launchId: row.launchId, partnerId: row.partnerId, reason: visit.errorClass },
      { graceMs: options.intervalMs },
    );
  } else if (visit.outcome !== "retry" && visit.outcome !== "skipped") {
    await options.alerts.clear(overdueKey(row.launchId));
  }
  context.log(WORKER_METRICS.feeClaimRecord, {
    launchId: row.launchId,
    step: "visited",
    outcome: visit.outcome,
    errorClass: "errorClass" in visit ? visit.errorClass : null,
    curve: visit.outcome === "visited" ? (visit.claims.curve?.outcome ?? null) : null,
  });
}

async function discover(context: JobContext): Promise<string[] | null> {
  const { pool, deployment, fingerprint, config } = context;
  const index = await checkIndex(pool, deployment.network, fingerprint);
  if (index.blocked) return [...index.blocked];
  if (index.checkpoint === null) return null;
  const checkpoint = index.checkpoint;
  const found = await discoverCurveLaunches(pool, {
    job: FEE_CLAIM_JOB,
    network: deployment.network,
    checkpoint,
    limit: config.batchSize,
    record: (transaction, launches) => recordLaunches(transaction, deployment.network, launches),
  });
  if (found > 0) context.log(WORKER_METRICS.feeClaimDiscovered, { count: found });
  return null;
}

async function run(context: JobContext, options: FeeClaimJobOptions): Promise<JobPass> {
  const started = performance.now();
  const blocked = await discover(context);
  if (blocked) {
    context.log(WORKER_METRICS.feeClaimBlocked, { reasons: blocked.join(",") });
    return { blocked };
  }
  const { pool, config } = context;
  const network = context.deployment.network;
  const visits = await keepRecords<FeeClaimRecord, FeeClaimVisit, Examined>(context, {
    job: FEE_CLAIM_JOB,
    leaseKey: (row) => `${row.network}:${row.launchId}`,
    examine: (row, leaseKey) => examine(context, options, row, leaseKey),
    classify: classifyFeeClaimError,
    record: (row, visit) => record(context, options, row, visit),
    report: (row, visit) => report(context, options, row, visit),
    batching: {
      capacity: config.recordsPerTransaction,
      // A launch's claims ride in one batch: the batch is sent first when they would not fit.
      weight: (examined) => examined.pending.length,
      alone: (examined) => examined.pending.length === 0 || triesAlone(examined.record),
      sendWhenFull: false,
      send: async (batch) => {
        await sendClaims(context, options, batch.flatMap((examined) => examined.pending));
        return (examined) => examinedVisit(context, examined);
      },
    },
  }, await dueRecords(pool, network, config.batchSize));
  context.log(WORKER_METRICS.feeClaimBacklog, await readBacklog(pool, network));
  context.log(WORKER_METRICS.feeClaimPass, { ...passCounts(visits), durationMs: Math.round(performance.now() - started) });
  return { blocked: null };
}

const feeClaimBatchSchema = z.object({ records: z.array(keeperActionSchema).min(1).max(MAX_RECORDS_PER_TRANSACTION) }).strict();

export function parseFeeClaimIntents(value: unknown): KeeperActionIntent[] {
  const parsed = feeClaimBatchSchema.safeParse(value);
  if (!parsed.success || parsed.data.records.some((intent) => intent.kind !== "launch-fees")) throw new SignerRefusal("malformed launch fee batch");
  return parsed.data.records;
}

export function feeClaimJob(options: FeeClaimJobOptions): WorkerJob<ProtocolWorkerAccess, KeeperSigner> {
  return Object.freeze<WorkerJob<ProtocolWorkerAccess, KeeperSigner>>({ name: FEE_CLAIM_JOB, run: (context: JobContext) => run(context, options),
    sign: (signer, bytes, intent, deployment) => signer.signActions(bytes, parseFeeClaimIntents(intent), deployment),
  });
}
