import { z } from "zod";

// The opening-round keeper (LP-18). A launch with an opening round stays in
// `OpeningRound`, untradeable, until someone calls the permissionless
// `settle_opening_round`; each bidder's Meme and refund then wait for a
// permissionless `deliver_opening_round`. Blast does both and pays the gas.
//
// Each pass records every Blast curve launch once from blast-infra's committed
// `chain_read_v1.pools` (`launch-discovery.ts`), then visits due records under
// a per-launch lease, settlement before delivery, always from fresh chain
// reads:
//
// - a launch with no opening round closes (`no-round`);
// - a running round waits for its end (`settling`, due again at the end);
// - an ended round still in `OpeningRound` is settled with one SDK-built
//   `settleOpeningRound`; one someone else settled moves on without
//   submitting;
// - a settled round delivers a bounded batch of bidders per transaction: the
//   bidders come from blast-infra's bidders list (undelivered ones, from the
//   record's page token), and each is checked on chain
//   (`getOpeningRoundBid`) just before, so a bidder delivered meanwhile by
//   anyone is skipped, never aborted on. The record is due again at once,
//   behind the other due launches, so one large round cannot starve them.
//   It closes (`delivered`) when the launch holds no undelivered bid.
//
// Each pass also raises `opening_round_unsettled:<launch>` for every ended
// round still unsettled `alertAfterMs` after its end, and clears it once the
// round is settled. Failures reconcile, then back off.

import { launchpadDeployment } from "@interest-protocol/blast-deployments-sdk";
import {
  getOpeningRoundBid,
  LaunchpadTransactions,
  openingRoundEndMs,
  type LaunchState,
} from "@interest-protocol/blast-launchpad-sdk";
import type { BlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import { normalizeStructTag } from "@mysten/sui/utils";

import { objectIdSchema } from "#workers/lib/validation.ts";

import { readLaunch } from "../blast-keeper/chain.ts";
import { launchpadTargets, type KeeperMarket } from "../blast-keeper/keepers.ts";
import { discoverCurveLaunches } from "../blast-keeper/launch-discovery.ts";
import {
  MAX_DELIVERIES_PER_TRANSACTION,
  SignerRefusal,
  type OpeningRoundIntent,
  type KeeperSigner,
} from "../blast-keeper/signer.ts";
import type { KeeperAlerts } from "../worker-runtime/alerts.ts";
import type { AttemptResult } from "../worker-runtime/attempt.ts";
import { checkIndex } from "../worker-runtime/index-identity.ts";
import { WORKER_METRICS } from "../worker-runtime/log.ts";
import { readDigestOutcome } from "../worker-runtime/outcome.ts";
import {
  attributeDigests,
  classifyFailure,
  keepRecords,
  notSubmitted,
  retryDelayMs,
  type RetryVisit,
} from "../worker-runtime/record-keeper.ts";
import type { JobContext as RuntimeJobContext, JobPass, WorkerJob, ProtocolWorkerAccess } from "../worker-runtime/runtime.ts";
import {
  dueRecords,
  OPENING_ROUND_JOB,
  readBacklog,
  recordBiddersCursor,
  recordClosed,
  recordDelivered,
  recordDeliverySubmission,
  recordLaunches,
  recordRetry,
  recordSettled,
  recordSettleSubmission,
  recordSettling,
  unsettledRounds,
  type OpeningRoundRecord,
} from "./repository.ts";

type JobContext = RuntimeJobContext<ProtocolWorkerAccess, KeeperSigner>;

export type OpeningRoundJobOptions = Readonly<{
  market: KeeperMarket;
  alerts: KeeperAlerts;
  /** Bidders per delivery transaction. */
  deliveryBatchSize: number;
  /** How long an ended round may stay unsettled before `opening_round_unsettled` is sent. */
  alertAfterMs: number;
  now?: () => number;
}>;

/** blast-infra bidders pages one delivery visit may read before it yields to other launches. */
const PAGES_PER_VISIT = 4;

export type OpeningRoundErrorClass =
  // Retried, uncounted.
  | "provider-unavailable"
  | "database-unavailable"
  | "launch-unavailable"
  | "launch-unreadable"
  | "not-shared"
  | "index-unavailable"
  | "bidders-unindexed"
  | "signer-busy"
  | "insufficient-gas"
  // Retried, counted: up to `stalled`.
  | "simulation-failed"
  | "execution-failed"
  | "submission-unknown"
  | "internal-error"
  // Final.
  | "foreign-lineage"
  | "attempts-exhausted"
  | "signer-refused";

type Step = "read" | "settle" | "deliver";

export type OpeningVisit =
  | Readonly<{ outcome: "waiting"; step: Step }>
  | Readonly<{ outcome: "settled"; by: "worker" | "external" | null }>
  | Readonly<{ outcome: "delivered"; bidders: number }>
  | Readonly<{ outcome: "closed"; state: "delivered" | "no-round" }>
  | Omit<RetryVisit<OpeningRoundErrorClass>, "refunded"> & Readonly<{ step: Step }>
  | Readonly<{ outcome: "rejected" | "stalled"; step: Step; errorClass: OpeningRoundErrorClass }>
  | Readonly<{ outcome: "skipped" }>;

export function alertKey(launchId: string): string {
  return `opening_round_unsettled:${launchId}`;
}

/**
 * Who settled, from our settle digests' effects: `worker` when one of them
 * succeeded (the signer signs nothing else under them), `external` when the
 * node answers that none did, null while a lookup fails.
 */
async function settledBy(context: JobContext, digests: readonly string[]): Promise<"worker" | "external" | null> {
  const verdict = await attributeDigests(digests, async (digest) => {
    const outcome = await readDigestOutcome(context.client, context.provider, digest, { effects: true });
    // An answer naming another digest is a node fault: as unsure as no answer.
    const unsure = outcome.kind === "unknown" || outcome.kind === "other-transaction" || outcome.kind === "other-effects";
    if (unsure) return "unknown";
    return outcome.kind === "executed" ? "ours" : "not-ours";
  });
  if (verdict === null) return null;
  return verdict === "ours" ? "worker" : "external";
}

function launchTypes(launch: LaunchState): [string, string] {
  return [normalizeStructTag(launch.memeType), normalizeStructTag(launch.quoteType)];
}

function builder(deployment: BlastDeployment): LaunchpadTransactions {
  return new LaunchpadTransactions(launchpadDeployment(deployment));
}

/** Common to both steps: may this visit sign now? A retry or stall when not. */
async function readyToSign(context: JobContext, record: OpeningRoundRecord, step: Step): Promise<OpeningVisit | null> {
  if (!context.canSign()) return { outcome: "retry", step, errorClass: "signer-busy" };
  if (record.attempts >= context.config.maxAttempts) return { outcome: "stalled", step, errorClass: "attempts-exhausted" };
  if (!(await context.gasAvailable())) return { outcome: "retry", step, errorClass: "insufficient-gas" };
  return null;
}

/** A submission that did not execute: why, as a retry. */
function unsettled(attempt: AttemptResult<unknown>, step: Step): OpeningVisit {
  if (attempt.outcome === "not-submitted") {
    const visit = notSubmitted(attempt.reason);
    return visit.outcome === "skipped" ? visit : { ...visit, step };
  }
  if (attempt.outcome === "simulation-failed") return { outcome: "retry", step, errorClass: "simulation-failed", counted: true };
  return {
    outcome: "retry",
    step,
    errorClass: attempt.outcome === "unknown" ? "submission-unknown" : "execution-failed",
    counted: true,
  };
}

async function settle(
  context: JobContext,
  options: OpeningRoundJobOptions,
  record: OpeningRoundRecord,
  launch: LaunchState,
  leaseKey: string,
): Promise<OpeningVisit> {
  const { pool, client, provider, deployment } = context;
  const launchpad = deployment.packages.launchpad.originalPackageId;
  const endMs = openingRoundEndMs(launch);
  if (launch.lifecycle !== "OpeningRound") {
    const by = record.settleDigests.length ? await settledBy(context, record.settleDigests) : "external";
    return (await recordSettled(pool, record, by, endMs)) ? { outcome: "settled", by } : { outcome: "skipped" };
  }
  // Created, not yet shared: the round has not started.
  if (endMs === null) {
    await recordSettling(pool, record, null, context.config.timings.retryMaxMs);
    return { outcome: "waiting", step: "settle" };
  }
  const now = (options.now ?? Date.now)();
  if (BigInt(now) < endMs) {
    // Due again at the round's end; the chain's clock decides, so a simulation just before it retries.
    await recordSettling(pool, record, endMs, Number(endMs - BigInt(now)));
    return { outcome: "waiting", step: "settle" };
  }
  await recordSettling(pool, record, endMs, 0);
  const blocked = await readyToSign(context, record, "settle");
  if (blocked) return blocked;
  const [memeType, quoteType] = launchTypes(launch);
  const intent: OpeningRoundIntent = { step: "settle", launchId: launch.objectId, typeArguments: [memeType, quoteType], bidders: [] };
  const attempt = await context.submit({
    recordKeys: [record.launchId],
    intent,
    transaction: builder(deployment).settleOpeningRound({
      memeType,
      quoteType,
      launch: { objectId: launch.objectId, initialSharedVersion: launch.initialSharedVersion },
    }),
    beforeSubmit: async (digest) =>
      (await context.leases.renew(OPENING_ROUND_JOB, leaseKey)) && (await recordSettleSubmission(pool, record, digest)),
    reconcile: async () => {
      const read = await readLaunch(client, record.launchId, launchpad, provider);
      return read.kind === "launch" && read.launch.lifecycle !== "OpeningRound";
    },
  });
  context.log(WORKER_METRICS.openingRecord, {
    launchId: record.launchId, step: "settle", outcome: attempt.outcome, digest: attempt.digest,
  });
  if (attempt.outcome === "executed" || attempt.reconciled === true) {
    // Ours when it executed; otherwise someone else won the race, or one of our earlier digests did.
    const digests = attempt.digest ? [...record.settleDigests, attempt.digest] : record.settleDigests;
    const by = attempt.outcome === "executed" ? "worker" : await settledBy(context, digests);
    return (await recordSettled(pool, record, by, endMs)) ? { outcome: "settled", by } : { outcome: "skipped" };
  }
  return unsettled(attempt, "settle");
}

type Batch = Readonly<{ bidders: readonly string[]; cursor: string | null }> | OpeningVisit;

/**
 * Up to `deliveryBatchSize` bidders the chain still holds a bid for, from
 * blast-infra's list from the record's page token on, and the page token the
 * next visit resumes from. At most `PAGES_PER_VISIT` pages per visit.
 */
async function nextBatch(
  context: JobContext,
  options: OpeningRoundJobOptions,
  record: OpeningRoundRecord,
): Promise<Batch> {
  const { deployment, pool } = context;
  const launchpad = deployment.packages.launchpad.originalPackageId;
  const size = Math.min(options.deliveryBatchSize, MAX_DELIVERIES_PER_TRANSACTION);
  let cursor = record.biddersCursor;
  const batch: string[] = [];
  for (let page = 0; page < PAGES_PER_VISIT; page++) {
    const read = await options.market.bidders(record.launchId, cursor);
    if (read === "unavailable") {
      return { outcome: "retry", step: "deliver", errorClass: "index-unavailable" };
    }
    if (read === "refused") {
      // A page token blast-infra no longer accepts: start the list again.
      if (cursor === null) {
        return { outcome: "retry", step: "deliver", errorClass: "index-unavailable" };
      }
      cursor = null;
      continue;
    }
    const undelivered = read.bidders
      .filter((bidder) => bidder.delivery === null)
      .map((bidder) => bidder.bidder);
    await appendUndeliveredBidders(context, record, undelivered, batch, size, launchpad);
    // The batch is full: the next visit reads this page again (its delivered bidders are skipped).
    if (batch.length >= size) {
      return { bidders: batch, cursor };
    }
    if (!read.nextCursor) {
      return finishBidderPage(context, record, batch, cursor);
    }
    cursor = read.nextCursor;
  }
  if (batch.length) {
    return { bidders: batch, cursor };
  }
  // Only delivered bidders so far: keep the place and come back at once.
  await recordBiddersCursor(pool, record, cursor);
  return { outcome: "waiting", step: "deliver" };
}

async function finishBidderPage(
  context: JobContext,
  record: OpeningRoundRecord,
  batch: string[],
  cursor: string | null,
): Promise<Batch> {
  if (batch.length) {
    return { bidders: batch, cursor };
  }
  // The chain still holds bids the list does not show undelivered: the index lags. Start over later.
  await recordBiddersCursor(context.pool, record, null);
  return { outcome: "retry", step: "deliver", errorClass: "bidders-unindexed" };
}

async function appendUndeliveredBidders(
  context: JobContext,
  record: OpeningRoundRecord,
  undelivered: readonly string[],
  batch: string[],
  size: number,
  launchpad: string,
): Promise<void> {
  for (let start = 0; start < undelivered.length && batch.length < size; ) {
    const chunk = undelivered.slice(start, start + (size - batch.length));
    start += chunk.length;
    // A fresh read of each bid: one delivered meanwhile, by anyone, holds none and is skipped.
    const bids = await Promise.all(
      chunk.map((bidder) =>
        context.provider(() =>
          getOpeningRoundBid(context.client, record.launchId, bidder, launchpad),
        ),
      ),
    );
    chunk.forEach((bidder, index) => bids[index]! > 0n && batch.push(bidder));
  }
}

async function deliver(
  context: JobContext,
  options: OpeningRoundJobOptions,
  record: OpeningRoundRecord,
  launch: LaunchState,
  leaseKey: string,
): Promise<OpeningVisit> {
  const { pool } = context;
  if (launch.openingRoundBids === 0n) {
    return (await recordClosed(pool, record, "delivered")) ? { outcome: "closed", state: "delivered" } : { outcome: "skipped" };
  }
  const batch = await nextBatch(context, options, record);
  if ("outcome" in batch) return batch;
  const blocked = await readyToSign(context, record, "deliver");
  if (blocked) return blocked;
  const [memeType, quoteType] = launchTypes(launch);
  const intent: OpeningRoundIntent = {
    step: "deliver",
    launchId: launch.objectId,
    typeArguments: [memeType, quoteType],
    bidders: batch.bidders,
  };
  const attempt = await context.submit({
    recordKeys: [record.launchId],
    intent,
    transaction: builder(context.deployment).deliverOpeningRound({
      memeType,
      quoteType,
      launch: { objectId: launch.objectId, initialSharedVersion: launch.initialSharedVersion },
      bidders: batch.bidders,
    }),
    beforeSubmit: async (digest) =>
      (await context.leases.renew(OPENING_ROUND_JOB, leaseKey)) && (await recordDeliverySubmission(pool, record, digest)),
    reconcile: async () => null,
  });
  context.log(WORKER_METRICS.openingRecord, {
    launchId: record.launchId, step: "deliver", outcome: attempt.outcome, digest: attempt.digest, bidders: batch.bidders.length,
  });
  if (attempt.outcome === "executed") {
    return (await recordDelivered(pool, record, batch.bidders.length, batch.cursor))
      ? { outcome: "delivered", bidders: batch.bidders.length }
      : { outcome: "skipped" };
  }
  // A bidder delivered by someone else between our read and the simulation fails it: the next visit reads again.
  return unsettled(attempt, "deliver");
}

async function examine(
  context: JobContext,
  options: OpeningRoundJobOptions,
  record: OpeningRoundRecord,
  leaseKey: string,
): Promise<OpeningVisit> {
  const read = await readLaunch(context.client, record.launchId, context.deployment.packages.launchpad.originalPackageId, context.provider);
  if (read.kind === "missing") return { outcome: "retry", step: "read", errorClass: "launch-unavailable" };
  if (read.kind === "unreadable") {
    context.log(WORKER_METRICS.openingRecord, { launchId: record.launchId, step: "read", outcome: "unreadable", reason: read.reason });
    return { outcome: "retry", step: "read", errorClass: "launch-unreadable" };
  }
  if (read.kind === "foreign") return { outcome: "rejected", step: "read", errorClass: "foreign-lineage" };
  const launch = read.launch;
  // The index and the chain must agree on the coin types: another pair is not this launch.
  if (
    normalizeStructTag(launch.memeType) !== normalizeStructTag(record.memeType) ||
    normalizeStructTag(launch.quoteType) !== normalizeStructTag(record.quoteType)
  ) {
    return { outcome: "rejected", step: "read", errorClass: "foreign-lineage" };
  }
  if (launch.openingRoundMs === 0n) {
    return (await recordClosed(context.pool, record, "no-round")) ? { outcome: "closed", state: "no-round" } : { outcome: "skipped" };
  }
  return record.state === "delivering"
    ? deliver(context, options, record, launch, leaseKey)
    : settle(context, options, record, launch, leaseKey);
}

/** A failure ends the visit as for every keeper job, at the read step. */
export function classifyOpeningRoundError(error: unknown): OpeningVisit {
  return { ...classifyFailure(error), step: "read" };
}

/** Records how a launch's visit ended, while its lease is held. */
async function record(context: JobContext, row: OpeningRoundRecord, visit: OpeningVisit): Promise<void> {
  const { pool } = context;
  if (visit.outcome === "retry") {
    await recordRetry(pool, row, visit.errorClass, retryDelayMs(context.backoffMs, row.attempts, {}), visit.counted ?? false);
  } else if (visit.outcome === "rejected" || visit.outcome === "stalled") {
    await recordClosed(pool, row, visit.outcome, visit.errorClass);
  }
}

/** Clears the launch's alert when it no longer holds one, and reports its visit. */
async function report(
  context: JobContext,
  options: OpeningRoundJobOptions,
  row: OpeningRoundRecord,
  visit: OpeningVisit,
): Promise<void> {
  // A settled round, or a launch that is not this keeper's to settle, holds no alert.
  if (visit.outcome === "settled" || visit.outcome === "rejected" || (visit.outcome === "closed" && visit.state === "no-round")) {
    await options.alerts.clear(alertKey(row.launchId));
  }
  const errorClass = "errorClass" in visit ? visit.errorClass : null;
  context.log(WORKER_METRICS.openingAttempt, {
    step: "step" in visit ? visit.step : row.state === "delivering" ? "deliver" : "settle",
    outcome: visit.outcome,
    errorClass,
    attempts: row.attempts,
  });
  if (visit.outcome === "settled") {
    context.log(WORKER_METRICS.openingSettled, { by: visit.by ?? "unknown" });
  }
  if (visit.outcome === "delivered") context.log(WORKER_METRICS.openingDelivered, { bidders: visit.bidders });
}

/**
 * Raises the unsettled alert for each ended round still unsettled: sent once
 * `alertAfterMs` has passed since the round's end (its grace is what is left
 * of that), then at most hourly while it holds.
 */
async function sweepAlerts(context: JobContext, options: OpeningRoundJobOptions): Promise<void> {
  const now = (options.now ?? Date.now)();
  for (const row of await unsettledRounds(context.pool, context.deployment.network, now, context.config.batchSize)) {
    const endedMs = now - Number(row.roundEndMs ?? BigInt(now));
    await options.alerts.raise(
      alertKey(row.launchId),
      { launchId: row.launchId, roundEndMs: String(row.roundEndMs), state: row.state, severity: "critical" },
      { graceMs: Math.max(0, options.alertAfterMs - endedMs) },
    );
  }
}

/** The index must serve this deployment, or nothing is recorded or signed. */
async function discover(context: JobContext): Promise<string[] | null> {
  const { pool, deployment, fingerprint, config } = context;
  const index = await checkIndex(pool, deployment.network, fingerprint);
  if (index.blocked) return [...index.blocked];
  if (index.checkpoint === null) return null;
  const found = await discoverCurveLaunches(pool, {
    job: OPENING_ROUND_JOB,
    network: deployment.network,
    checkpoint: index.checkpoint,
    limit: config.batchSize,
    record: (transaction, launches) => recordLaunches(transaction, deployment.network, launches),
  });
  if (found > 0) context.log(WORKER_METRICS.openingDiscovered, { count: found });
  return null;
}

async function run(context: JobContext, options: OpeningRoundJobOptions): Promise<JobPass> {
  const started = performance.now();
  const blocked = await discover(context);
  if (blocked) {
    context.log(WORKER_METRICS.openingBlocked, { reasons: blocked.join(",") });
    return { blocked };
  }
  const network = context.deployment.network;
  // Each launch sends its own transaction while it examines it: nothing is batched.
  const visits = await keepRecords<OpeningRoundRecord, OpeningVisit, never>(context, {
    job: OPENING_ROUND_JOB,
    leaseKey: (row) => `${row.network}:${row.launchId}`,
    examine: (row, leaseKey) => examine(context, options, row, leaseKey),
    classify: classifyOpeningRoundError,
    record: (row, visit) => record(context, row, visit),
    report: (row, visit) => report(context, options, row, visit),
  }, await dueRecords(context.pool, network, context.config.batchSize));
  await sweepAlerts(context, options);
  context.log(WORKER_METRICS.openingBacklog, await readBacklog(context.pool, network, (options.now ?? Date.now)()));
  // Every launch whose lease the pass took counts as visited, a skipped one too.
  const providerUnavailable = visits.filter(
    (visit) => "errorClass" in visit && visit.errorClass === "provider-unavailable",
  ).length;
  context.log(WORKER_METRICS.openingPass, {
    visited: visits.length,
    providerUnavailable,
    durationMs: Math.round(performance.now() - started),
  });
  return { blocked: null };
}

const openingRoundIntentSchema = z.object({
  step: z.enum(["settle", "deliver"]),
  launchId: objectIdSchema,
  typeArguments: z.array(z.string().min(5).max(1024)).length(2),
  bidders: z.array(objectIdSchema).max(MAX_DELIVERIES_PER_TRANSACTION),
});

/** An opening-round intent as it comes back from storage (JSONB): parsed, never cast. */
export function parseOpeningRoundIntent(value: unknown): OpeningRoundIntent {
  const parsed = openingRoundIntentSchema.safeParse(value);
  if (!parsed.success) throw new SignerRefusal("a malformed intent");
  return parsed.data;
}

/** The opening-round keeper for the operational worker runtime. */
export function openingRoundJob(options: OpeningRoundJobOptions): WorkerJob<ProtocolWorkerAccess, KeeperSigner> {
  return Object.freeze({
    name: OPENING_ROUND_JOB,
    run: (context: JobContext) => run(context, options),
    // Only the deployment's launchpad settle or deliver of the intended launch, paying only gas.
    sign: async (signer: KeeperSigner, bytes: Uint8Array, intent: unknown, deployment: BlastDeployment) =>
      signer.signOpeningRound(bytes, parseOpeningRoundIntent(intent), launchpadTargets(deployment), deployment),
  });
}
