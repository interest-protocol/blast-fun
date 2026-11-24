import { z } from "zod";

// Discover committed MigrationReady launches, then check fresh state under a per-launch lease.
// Each SDK transaction pairs the product migrate call with its adapter in one PTB.
// The shared journal retains signed bytes until effects establish the outcome.

import type { BlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import type { LaunchState } from "@interest-protocol/blast-launchpad-sdk";
import { LAUNCHPAD_PAUSE_BITS } from "@interest-protocol/blast-launchpad-sdk/transactions";
import {
  venueOf,
  type MigratorVenue,
} from "@interest-protocol/blast-migrators-sdk";
import type { Transaction } from "@mysten/sui/transactions";
import { normalizeStructTag, normalizeSuiObjectId } from "@mysten/sui/utils";

import { autocommitRead } from "@blast/core/modules/database/transaction.ts";
import { permittedBluefinFee } from "../blast-keeper/bluefin-fee.ts";
import {
  readBluefinFee,
  readLaunch,
  readLaunches,
  readRegistryCurrency,
  type RegistryCurrency,
} from "../blast-keeper/chain.ts";
import { MAX_RECORDS_PER_TRANSACTION, SignerRefusal, type KeeperSigner } from "../blast-keeper/signer.ts";
import { keeperTransaction, keeperActionSchema, type KeeperActionIntent } from "../blast-keeper/transactions.ts";
import type { AttemptResult } from "../worker-runtime/attempt.ts";
import type { BatchOutcome } from "../worker-runtime/batch.ts";
import type { EnabledProtocolAccess } from "../worker-runtime/deployment.ts";
import { checkIndex } from "../worker-runtime/index-identity.ts";
import { WORKER_METRICS } from "../worker-runtime/log.ts";
import {
  attributeDigests,
  classifyFailure,
  keepRecords,
  notSubmitted,
  passCounts,
  retryDelayMs,
  sendLeasedBatch,
  triesAlone,
  unsettledVisit,
  type LeasedReady,
  type RetryVisit,
} from "../worker-runtime/record-keeper.ts";
import type { JobContext as RuntimeJobContext, JobPass, WorkerJob, ProtocolWorkerAccess } from "../worker-runtime/runtime.ts";
import { launchesMigratedBy, migratedBy } from "./chain.ts";
import {
  discoverReady,
  dueRecords,
  MIGRATION_JOB,
  readBacklog,
  recordBlocked,
  recordFinal,
  recordMigrated,
  recordRetry,
  recordSubmissions,
  recordVenue,
  type MigrationOutcome,
  type MigrationRecord,
} from "./repository.ts";

type JobContext = RuntimeJobContext<ProtocolWorkerAccess, KeeperSigner>;

/** Why a launch's pass ended without migration. */
export type MigrationErrorClass =
  // Retried (uncounted unless noted): nothing about the launch is known to be wrong.
  | "provider-unavailable"
  | "database-unavailable"
  | "launch-unavailable"
  // The node answered, but the object could not be read as a launch (a decode, SDK or contract drift).
  | "launch-unreadable"
  | "launch-not-ready"
  | "currency-unavailable"
  | "signer-busy"
  | "insufficient-gas"
  | "awaiting-effects"
  | "simulation-failed"
  | "execution-failed"
  // Another launch of its batch failed the transaction: its attempt is refunded.
  | "batch-failed"
  | "submission-unknown"
  | "internal-error"
  // Configuration blocks: never signed while they hold; read again at the longest backoff.
  | "unsupported-route"
  | "venue-not-routed"
  | "unsupported-tier"
  | "venue-unavailable"
  | "bluefin-fee-unreadable"
  | "creation-fee-beyond-gas"
  // Final.
  | "foreign-lineage"
  | "attempts-exhausted"
  | "signer-refused";

export type Visit =
  | Readonly<{ outcome: "migrated"; by: MigrationOutcome; venue: MigratorVenue | null }>
  | RetryVisit<MigrationErrorClass>
  | Readonly<{ outcome: "blocked"; errorClass: MigrationErrorClass; reasons?: string }>
  | Readonly<{ outcome: "rejected" | "stalled"; errorClass: MigrationErrorClass }>
  | Readonly<{ outcome: "skipped" }>;


type Route =
  | Readonly<{ status: "supported"; venue: MigratorVenue }>
  | Readonly<{
      status: "blocked";
      venue: MigratorVenue | null;
      errorClass: MigrationErrorClass;
      reasons?: string;
    }>;

/**
 * The launch's recorded route as this worker may migrate it: the SDK routes
 * its witness to this deployment's migrators, the deployment admits that
 * venue and the launch's tier, and the venue's recorded object set is
 * available. Anything else is a block; no other venue is ever chosen.
 */
async function supportedRoute(
  launch: LaunchState,
  deployment: BlastDeployment,
  protocol: EnabledProtocolAccess,
  context: JobContext,
): Promise<Route> {
  const migrators = deployment.packages.migrators!;
  let venue: MigratorVenue;
  try {
    const found = venueOf(migrators, launch.venue);
    if (!found) throw new Error("unsupported venue");
    venue = found;
  } catch {
    return { status: "blocked", venue: null, errorClass: "unsupported-route" };
  }
  const route = deployment.routes.find((candidate) => candidate.venue === venue);
  if (!route) return { status: "blocked", venue, errorClass: "venue-not-routed" };
  const { rows } = await autocommitRead<{ tick_spacing: number; fee_rate: string | null }>(context.pool, "launch-migration",
    "SELECT tick_spacing, fee_rate::text FROM chain_read_v1.pool_tiers WHERE meme_type=$1 AND venue=$2", [launch.memeType, venue]);
  const tier = rows[0];
  if (!tier || !route.tiers.some((item) => item.tickSpacing === Number(tier.tick_spacing) && (venue === "cetus" || BigInt(item.feeRate) === BigInt(tier.fee_rate ?? "-1"))))
    return { status: "blocked", venue, errorClass: "unsupported-tier" };
  const availability = protocol.venues[venue];
  if (!availability.available) {
    return {
      status: "blocked",
      venue,
      errorClass: "venue-unavailable",
      reasons: [...new Set(availability.reasons.map((reason) => reason.code))].join(","),
    };
  }
  return { status: "supported", venue };
}

/** One launch ready to migrate: its commands and intent, its record and the lease held for it. */
type Ready = LeasedReady<MigrationRecord, KeeperActionIntent> & Readonly<{ venue: MigratorVenue }>;

type Prepared = Readonly<{ add(transaction: Transaction): void; intent: KeeperActionIntent }>;


/** Prepare both migration calls from fresh currencies and the admitted deployment. */
async function prepareMigration(
  context: JobContext,
  launch: LaunchState,
  venue: MigratorVenue,
  creationFeeCapMist: bigint,
): Promise<Prepared | Exclude<Visit, { outcome: "migrated" | "skipped" }>> {
  const { client, provider, deployment } = context;
  if ((context.protocol.paused.launchpad & LAUNCHPAD_PAUSE_BITS.Migrate) !== 0) return { outcome: "blocked", errorClass: "venue-unavailable", reasons: "launchpad-migrate-paused" };
  const currency = await readRegistryCurrency(client, launch.memeType, provider);
  if (!currency) return { outcome: "retry", errorClass: "currency-unavailable" };
  let quoteCurrency: RegistryCurrency | undefined;
  let creationFeeMist = "0";
  if (venue === "bluefin") {
    quoteCurrency = await readRegistryCurrency(client, launch.quoteType, provider) ?? undefined;
    if (!quoteCurrency) return { outcome: "retry", errorClass: "currency-unavailable" };
    const fee = await readBluefinFee(client, deployment, provider);
    if (typeof fee !== "bigint") return { outcome: "blocked", errorClass: "bluefin-fee-unreadable", reasons: fee.code };
    if (!permittedBluefinFee(fee, creationFeeCapMist)) return { outcome: "blocked", errorClass: "creation-fee-beyond-gas" };
    creationFeeMist = String(fee);
  }
  const intent: KeeperActionIntent = {
    kind: "launch-migrate", venue, creationFeeMist,
    object: { objectId: launch.objectId, initialSharedVersion: String(launch.initialSharedVersion) },
    memeType: launch.memeType, quoteType: launch.quoteType, currency,
    ...(quoteCurrency ? { quoteCurrency } : {}),
  };
  return { add: (transaction) => { keeperTransaction(deployment, intent, transaction); }, intent };
}

/**
 * Who migrated the launch, judged from our own digests' effects and `Migrated`
 * events: `migrated-by-worker` when one of them did, `already-migrated` when
 * the node answers that none did (another wallet won), and null while a
 * lookup fails: then nobody can say yet.
 */
async function attribution(
  context: JobContext,
  digests: readonly string[],
  launchId: string,
): Promise<MigrationOutcome | null> {
  const launchpad = context.deployment.packages.launchpad.originalPackageId;
  return migrationOutcome(
    await attributeDigests(digests, (digest) => migratedBy(context.client, digest, launchId, launchpad, context.provider)),
  );
}

function migrationOutcome(verdict: "ours" | "not-ours" | null): MigrationOutcome | null {
  if (verdict === null) return null;
  return verdict === "ours" ? "migrated-by-worker" : "already-migrated";
}

/** Closes a migrated launch with its attribution; an unknown one retries, uncounted, and never closes. */
async function closeMigrated(
  context: JobContext,
  record: MigrationRecord,
  by: MigrationOutcome | null,
  venue: MigratorVenue | null,
): Promise<Visit> {
  if (!by) return { outcome: "retry", errorClass: "provider-unavailable" };
  return (await recordMigrated(context.pool, record, by))
    ? { outcome: "migrated", by, venue }
    : { outcome: "skipped" };
}

/**
 * Everything before signing, from fresh reads: a visit when the launch's pass
 * ends here (migrated, blocked, rejected, a retry), or the launch ready to
 * migrate in the next batch.
 */
async function examine(
  context: JobContext,
  record: MigrationRecord,
  leaseKey: string,
  creationFeeCapMist: bigint,
): Promise<Visit | Ready> {
  const { client, pool, provider, deployment, config } = context;
  const launchpad = deployment.packages.launchpad.originalPackageId;

  const read = await readLaunch(client, record.launchId, launchpad, provider);
  if (read.kind === "missing") return { outcome: "retry", errorClass: "launch-unavailable" };
  if (read.kind === "unreadable") {
    // Never final: a decode failure is ours (an SDK or contract drift), not the launch's.
    context.log(WORKER_METRICS.migrationRecord, {
      launchId: record.launchId,
      step: "read",
      outcome: "unreadable",
      reason: read.reason,
    });
    return { outcome: "retry", errorClass: "launch-unreadable" };
  }
  if (read.kind === "foreign") {
    context.log(WORKER_METRICS.migrationRecord, {
      launchId: record.launchId,
      step: "read",
      outcome: "rejected",
      reason: read.reason,
    });
    return { outcome: "rejected", errorClass: "foreign-lineage" };
  }
  const launch = read.launch;
  // The index and the chain must agree on the coin types: another pair is not this launch.
  if (
    normalizeStructTag(launch.memeType) !== normalizeStructTag(record.memeType) ||
    normalizeStructTag(launch.quoteType) !== normalizeStructTag(record.quoteType)
  ) {
    return { outcome: "rejected", errorClass: "foreign-lineage" };
  }
  if (launch.lifecycle === "Migrated") {
    return closeMigrated(
      context,
      record,
      await attribution(context, record.digests, record.launchId),
      null,
    );
  }
  // The index committed it ready; a node behind the index answers later.
  if (launch.lifecycle !== "MigrationReady")
    return { outcome: "retry", errorClass: "launch-not-ready" };
  // Before another attempt: one of our own transactions may have migrated it while this node's object
  // reads lag. Their effects and `Migrated` events say so; never sign again while one did, or may have.
  if (record.digests.length > 0) {
    const by = await attribution(context, record.digests, record.launchId);
    if (by !== "already-migrated") return closeMigrated(context, record, by, null);
  }

  const route = await supportedRoute(launch, deployment, context.protocol, context);
  if (route.venue) await recordVenue(pool, record, route.venue);
  if (route.status === "blocked")
    return { outcome: "blocked", errorClass: route.errorClass, reasons: route.reasons };
  const venue = route.venue;

  const prepared = await prepareMigration(context, launch, venue, creationFeeCapMist);
  if (!("intent" in prepared)) return prepared;

  // The key has an unsettled submission (perhaps this record's): sign nothing, and never stall
  // a record whose attempt may still land.
  if (!context.canSign()) return { outcome: "retry", errorClass: "signer-busy" };
  if (record.attempts >= config.maxAttempts)
    return { outcome: "stalled", errorClass: "attempts-exhausted" };
  return { ...prepared, key: record.launchId, record, leaseKey, venue };
}

/**
 * Migrates a batch of ready launches in as few transactions as their failures
 * allow, sized to what the address balance pays, and settles each. After the
 * last lease renewal each transaction makes four node calls (submit, wait,
 * one read of every launch, one read of the batch's digest when its outcome
 * was not seen), as the lease TTL assumes, plus a read of each earlier digest
 * of a launch someone migrated meanwhile, as before batching.
 */
function migrateBatch(context: JobContext, batch: readonly Ready[]) {
  const { client, pool, provider, deployment } = context;
  const launchpad = deployment.packages.launchpad.originalPackageId;
  return sendLeasedBatch(context, MIGRATION_JOB, batch, {
    recordSubmissions: (records, digest) => recordSubmissions(pool, records.map((ready) => ready.record), digest),
    reconcile: async (records) => {
      const reads = await readLaunches(client, records.map((ready) => ready.record.launchId), launchpad, provider);
      return new Set([...reads].flatMap(([id, read]) => read.kind === "launch" && read.launch.lifecycle === "Migrated" ? [id] : []));
    },
    settler: () => {
      const byDigest = new Map<string, Promise<ReadonlySet<string> | "unknown">>();
      const launchesMigrated = (digest: string) => {
        if (!byDigest.has(digest)) byDigest.set(digest, launchesMigratedBy(client, digest, launchpad, provider));
        return byDigest.get(digest)!;
      };
      return async (ready, outcome, records) => {
        context.log(WORKER_METRICS.migrationRecord, {
          launchId: ready.record.launchId,
          venue: ready.venue,
          step: "submitted",
          outcome: outcome.attempt.outcome,
          digest: outcome.attempt.digest,
          records,
        });
        return settleSubmission(context, ready, outcome, launchesMigrated);
      };
    },
  });
}

/**
 * Resolve one launch of a submitted batch from its effects and the record's
 * own digests (a lagging lookup may have missed one of ours before this
 * attempt). `launchesMigrated` reads each digest once for the whole batch.
 */
async function settleSubmission(
  context: JobContext,
  ready: Ready,
  { attempt, blame }: BatchOutcome<ReadonlySet<string>>,
  launchesMigrated: (digest: string) => Promise<ReadonlySet<string> | "unknown">,
): Promise<Visit> {
  const { record, venue } = ready;
  if (attempt.outcome === "not-submitted") return notSubmitted(attempt.reason);
  if (attempt.reconciled?.has(normalizeSuiObjectId(record.launchId))) {
    return closeMigrated(context, record, await migratedOutcome(record, attempt, launchesMigrated), venue);
  }
  return unsettledVisit(attempt, blame);
}

/**
 * Who migrated a launch the reconciliation reads as migrated: ours when our
 * transaction executed, or when it or one of the record's earlier digests
 * emitted its `Migrated`; null while a digest lookup fails.
 */
async function migratedOutcome(
  record: MigrationRecord,
  attempt: AttemptResult<unknown>,
  launchesMigrated: (digest: string) => Promise<ReadonlySet<string> | "unknown">,
): Promise<MigrationOutcome | null> {
  if (attempt.outcome === "executed") return "migrated-by-worker";
  const launchId = normalizeSuiObjectId(record.launchId);
  const digests = attempt.digest ? [...record.digests, attempt.digest] : record.digests;
  return migrationOutcome(
    await attributeDigests(digests, async (digest) => {
      const migrated = await launchesMigrated(digest);
      if (migrated === "unknown") return "unknown";
      return migrated.has(launchId) ? "ours" : "not-ours";
    }),
  );
}

/** Records how a launch's visit ended, while its lease is held. */
async function record(context: JobContext, row: MigrationRecord, visit: Visit): Promise<void> {
  const { pool, config } = context;
  if (visit.outcome === "retry") {
    // A submission counted itself when it recorded its digest; a failed simulation or a local failure counts here,
    // and a launch whose batch another launch failed gets its attempt back, due again at the shortest backoff.
    await recordRetry(
      pool,
      row,
      visit.errorClass,
      retryDelayMs(context.backoffMs, row.attempts, visit),
      visit.counted ? 1 : visit.refunded ? -1 : 0,
    );
  } else if (visit.outcome === "blocked") {
    // Configuration may change, and someone may migrate it by hand: read it again, at the longest backoff.
    await recordBlocked(pool, row, visit.errorClass, config.timings.retryMaxMs);
  } else if (visit.outcome === "rejected" || visit.outcome === "stalled") {
    await recordFinal(pool, row, visit.outcome, visit.errorClass);
  }
}

function report(context: JobContext, row: MigrationRecord, visit: Visit): void {
  const errorClass = "errorClass" in visit ? visit.errorClass : null;
  context.log(WORKER_METRICS.migrationAttempt, {
    outcome: visit.outcome,
    errorClass,
    attempts: row.attempts,
  });
  context.log(WORKER_METRICS.migrationRecord, {
    launchId: row.launchId,
    step: "visited",
    outcome: visit.outcome,
    errorClass,
    reasons: "reasons" in visit ? visit.reasons : undefined,
  });
  if (visit.outcome === "migrated") {
    context.log(WORKER_METRICS.migrationMigrated, {
      outcome: visit.by,
      venue: visit.venue,
      detectionToCompletionMs: Math.max(0, Date.now() - row.detectedAt.getTime()),
    });
  }
}

/** The index must serve this deployment, and the deployment must have migrators, or nothing is discovered or signed. */
async function discover(context: JobContext): Promise<string[] | null> {
  const { pool, deployment, fingerprint, config } = context;
  if (!deployment.packages.migrators) return ["no-migrators-package"];
  const index = await checkIndex(pool, deployment.network, fingerprint);
  if (index.blocked) return [...index.blocked];
  if (index.checkpoint === null) return null;
  const found = await discoverReady(pool, {
    network: deployment.network,
    fingerprint,
    limit: config.batchSize,
  });
  if (found > 0) context.log(WORKER_METRICS.migrationDiscovered, { count: found });
  return null;
}

/** A launch whose own transaction failed last time, or that pays a creation fee, migrates alone. */
function migratesAlone(ready: Ready): boolean {
  return triesAlone(ready.record) || (ready.intent.kind === "launch-migrate" && BigInt(ready.intent.creationFeeMist) > 0n);
}

async function run(context: JobContext, creationFeeCapMist: bigint): Promise<JobPass> {
  const started = performance.now();
  const blocked = await discover(context);
  if (blocked) {
    context.log(WORKER_METRICS.migrationBlocked, { reasons: blocked.join(",") });
    return { blocked };
  }
  const { pool, config } = context;
  const network = context.deployment.network;
  const visits = await keepRecords<MigrationRecord, Visit, Ready>(context, {
    job: MIGRATION_JOB,
    leaseKey: (row) => `${row.network}:${row.launchId}`,
    examine: (row, leaseKey) => examine(context, row, leaseKey, creationFeeCapMist),
    classify: classifyFailure,
    record: (row, visit) => record(context, row, visit),
    report: async (row, visit) => report(context, row, visit),
    batching: {
      capacity: config.recordsPerTransaction,
      weight: () => 1,
      alone: migratesAlone,
      sendWhenFull: true,
      send: (batch) => migrateBatch(context, batch),
    },
  }, await dueRecords(pool, network, config.batchSize));
  context.log(WORKER_METRICS.migrationBacklog, await readBacklog(pool, network));
  context.log(WORKER_METRICS.migrationPass, {
    ...passCounts(visits),
    durationMs: Math.round(performance.now() - started),
  });
  return { blocked: null };
}

const migrationBatchSchema = z.object({ records: z.array(keeperActionSchema).min(1).max(MAX_RECORDS_PER_TRANSACTION) }).strict();

export function parseMigrationIntents(value: unknown): KeeperActionIntent[] {
  const parsed = migrationBatchSchema.safeParse(value);
  if (!parsed.success || parsed.data.records.some((intent) => intent.kind !== "launch-migrate")) throw new SignerRefusal("malformed launch migration batch");
  return parsed.data.records;
}

export function migrationJob(creationFeeCapMist = 0n): WorkerJob<ProtocolWorkerAccess, KeeperSigner> {
  return Object.freeze<WorkerJob<ProtocolWorkerAccess, KeeperSigner>>({
    name: MIGRATION_JOB, run: (context) => run(context, creationFeeCapMist),
    sign: (signer, bytes, intent, deployment) => signer.signActions(bytes, parseMigrationIntents(intent), deployment),
  });
}
