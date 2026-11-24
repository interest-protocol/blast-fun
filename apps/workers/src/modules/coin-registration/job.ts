import { z } from "zod";

// The Coin Registry registration job. Each pass it discovers new candidates
// from `chain_read_v1.coins`, then examines every due record under its lease:
// a fresh chain read first (a currency shared by anyone closes the record as
// success without submitting, and so does one our own last digest shared
// while the node's object reads lag), the pending currency and its
// publication's lineage next. A record that passes joins the pass's batch: up
// to `BLAST_WORKER_RECORDS_PER_TRANSACTION` gas-only `finalize_registration`
// calls go into one transaction through `simulateSignSendBatch`, which
// isolates a failing record before signing; a record whose own transaction
// failed last time goes alone. Each record then settles from one fresh read of
// the batch's shared currencies; failures back off.

import { launchpadDeployment, type BlastDeployment } from "@interest-protocol/blast-deployments-sdk";
import { COIN_REGISTRY_ID } from "@interest-protocol/blast-core/effects";
import { LaunchpadTransactions } from "@interest-protocol/blast-launchpad-sdk";
import type { Transaction } from "@mysten/sui/transactions";

import { errorLabel } from "@blast/core/lib/metrics.ts";
import { sharedCurrencyId } from "../blast-keeper/chain.ts";
import {
  MAX_RECORDS_PER_TRANSACTION,
  SignerRefusal,
  type KeeperSigner,
  type RegistrationIntent,
} from "../blast-keeper/signer.ts";
import type { BatchOutcome } from "../worker-runtime/batch.ts";
import { checkIndex } from "../worker-runtime/index-identity.ts";
import { WORKER_METRICS } from "../worker-runtime/log.ts";
import {
  classifyFailure,
  keepRecords,
  notSubmitted,
  retryDelayMs,
  sendLeasedBatch,
  triesAlone,
  unsettledVisit,
  type LeasedReady,
  type RetryVisit,
} from "../worker-runtime/record-keeper.ts";
import type { JobContext as RuntimeJobContext, JobPass, WorkerJob, ProtocolWorkerAccess } from "../worker-runtime/runtime.ts";
import {
  checkLineage,
  ForeignLineage,
  readEffects,
  readPendingCurrency,
  readSharedCurrencies,
  readSharedCurrency,
  sharedBy,
  type TransactionEffectsRead,
} from "./chain.ts";
import {
  discoverCandidates,
  dueRecords,
  readBacklog,
  recordPublication,
  recordRegistered,
  recordRejected,
  recordRetry,
  recordSubmissions,
  REGISTRATION_JOB,
  type RegistrationRecord,
} from "./repository.ts";

/** Why a record's pass ended without registration. */
export type RegistrationErrorClass =
  | "provider-unavailable"
  | "pending-currency-missing"
  | "pending-currency-ambiguous"
  | "publication-unavailable"
  | "awaiting-effects"
  | "signer-busy"
  | "database-unavailable"
  | "foreign-lineage"
  | "insufficient-gas"
  | "simulation-failed"
  | "execution-failed"
  // Another record of its batch failed the transaction: its attempt is refunded.
  | "batch-failed"
  | "submission-unknown"
  | "attempts-exhausted"
  | "signer-refused"
  | "internal-error";

type JobContext = RuntimeJobContext<ProtocolWorkerAccess, KeeperSigner>;

export type Visit =
  | Readonly<{ outcome: "registered"; by: "registered-by-worker" | "already-registered" }>
  | RetryVisit<RegistrationErrorClass>
  | Readonly<{ outcome: "rejected" | "stalled"; errorClass: RegistrationErrorClass }>
  | Readonly<{ outcome: "skipped" }>;

/** The index's blocks: it must serve this deployment, or nothing it lists is signed. */
async function discover(context: JobContext): Promise<string[] | null> {
  const { pool, deployment, fingerprint, leases, config, log } = context;
  const index = await checkIndex(pool, deployment.network, fingerprint);
  if (index.blocked) return [...index.blocked];
  if (index.checkpoint === null) return null;
  const key = `${deployment.network}:discovery`;
  if (!(await leases.acquire(REGISTRATION_JOB, key))) return null;
  try {
    const found = await discoverCandidates(pool, {
      network: deployment.network,
      checkpoint: index.checkpoint,
      limit: config.batchSize,
    });
    if (found > 0) log(WORKER_METRICS.discovered, { count: found });
  } finally {
    await leases.release(REGISTRATION_JOB, key);
  }
  return null;
}

/** One digest's effects, read once per batch. */
type EffectsOf = (digest: string) => Promise<TransactionEffectsRead | "unknown">;

function effectsReader(context: JobContext): EffectsOf {
  const read = new Map<string, Promise<TransactionEffectsRead | "unknown">>();
  return (digest) => {
    if (!read.has(digest)) {
      read.set(
        digest,
        readEffects(context.client, digest, context.provider).catch((error: unknown) => {
          // Unknown effects never attribute a registration to us; the label says why.
          context.log(WORKER_METRICS.handledError, { job: REGISTRATION_JOB, error: errorLabel(error) });
          return "unknown" as const;
        }),
      );
    }
    return read.get(digest)!;
  };
}

/** Whether our own submission shared it, judged from that digest's effects; any doubt is `already-registered`. */
async function attribution(
  effectsOf: EffectsOf,
  digest: string | null,
  currencyId: string,
): Promise<"registered-by-worker" | "already-registered"> {
  if (!digest) return "already-registered";
  const effects = await effectsOf(digest);
  return effects !== "unknown" && sharedBy(effects, currencyId) ? "registered-by-worker" : "already-registered";
}

/** One record ready to register: its command and intent, its record and the lease held for it. */
type Ready = LeasedReady<RegistrationRecord, RegistrationIntent>;

/** Closes the record when its currency is shared, or when its own latest digest shared it; null otherwise. */
async function alreadyShared(context: JobContext, record: RegistrationRecord): Promise<Visit | null> {
  const effectsOf = effectsReader(context);
  const close = async (by: "registered-by-worker" | "already-registered", currencyId: string): Promise<Visit> =>
    (await recordRegistered(context.pool, record, by, currencyId)) ? { outcome: "registered", by } : { outcome: "skipped" };

  const shared = await readSharedCurrency(context.client, record.memeType, context.provider);
  if (shared) return close(await attribution(effectsOf, record.latestDigest, shared), shared);
  // Before another attempt: our last digest may have shared it while this node's object reads lag.
  // The signer gate settled every earlier digest first, so only the latest can have landed.
  if (record.state !== "submitted" || !record.latestDigest) return null;
  const landed = await effectsOf(record.latestDigest);
  const currencyId = sharedCurrencyId(record.memeType);
  return landed !== "unknown" && sharedBy(landed, currencyId) ? close("registered-by-worker", currencyId) : null;
}

/**
 * Everything before signing, from fresh reads: a visit when the record's pass
 * ends here (registered, rejected, a retry), or the record ready to register
 * in the next batch.
 */
async function examine(context: JobContext, record: RegistrationRecord, leaseKey: string): Promise<Visit | Ready> {
  const { client, pool, provider, deployment, config } = context;
  const memeType = record.memeType;

  const registered = await alreadyShared(context, record);
  if (registered) return registered;

  const pending = await readPendingCurrency(client, memeType, provider);
  if (pending === "ambiguous")
    return { outcome: "rejected", errorClass: "pending-currency-ambiguous" };
  if (!pending) {
    // Our submission may still be landing; otherwise the node has not seen the publication yet.
    return {
      outcome: "retry",
      errorClass: record.state === "submitted" ? "awaiting-effects" : "pending-currency-missing",
    };
  }
  if (!pending.publicationDigest)
    return { outcome: "retry", errorClass: "publication-unavailable" };
  const publicationDigest = pending.publicationDigest;
  const effects = await readEffects(client, publicationDigest, provider);
  const publication = checkLineage(effects, memeType, pending.currency, launchpadDeployment(deployment));
  await recordPublication(pool, record, {
    currency: pending.currency,
    publicationDigest,
    ticketId: publication.ticket.objectId,
  });

  // The key has an unsettled submission (perhaps this record's): sign nothing, and never stall
  // a record whose attempt may still land.
  if (!context.canSign()) return { outcome: "retry", errorClass: "signer-busy" };
  if (record.attempts >= config.maxAttempts)
    return { outcome: "stalled", errorClass: "attempts-exhausted" };

  const intent: RegistrationIntent = { memeType, currency: pending.currency };
  const { objects: registryObjects } = await context.provider((signal) => context.client.core.getObjects({ objectIds: [COIN_REGISTRY_ID], signal }));
  const registry = registryObjects[0];
  if (!registry || registry instanceof Error || registry.owner.$kind !== "Shared") return { outcome: "retry", errorClass: "provider-unavailable" };
  const call = new LaunchpadTransactions(launchpadDeployment(deployment)).call.finalizeCurrencyRegistration({ ...intent, coinRegistry: { objectId: COIN_REGISTRY_ID, initialSharedVersion: registry.owner.Shared.initialSharedVersion } });
  return {
    key: memeType,
    intent,
    add: (transaction: Transaction) => transaction.add(call),
    record,
    leaseKey,
  };
}

/**
 * Registers a batch of ready records in as few transactions as their failures
 * allow, sized to what the address balance pays, and settles each. After the
 * last lease renewal each transaction makes four node calls (submit, wait,
 * one read of every shared currency, one read of the batch's digest when its
 * outcome was not seen), as the lease TTL assumes.
 */
function registerBatch(context: JobContext, batch: readonly Ready[]) {
  const { client, pool, provider } = context;
  return sendLeasedBatch(context, REGISTRATION_JOB, batch, {
    recordSubmissions: (records, digest) => recordSubmissions(pool, records.map((ready) => ready.record), digest),
    reconcile: (records) => readSharedCurrencies(client, records.map((ready) => ready.record.memeType), provider),
    settler: () => {
      const effectsOf = effectsReader(context);
      return async (ready, outcome, records) => {
        context.log(WORKER_METRICS.record, {
          memeType: ready.record.memeType,
          step: "submitted",
          outcome: outcome.attempt.outcome,
          digest: outcome.attempt.digest,
          records,
        });
        return settleSubmission(context, ready, outcome, effectsOf);
      };
    },
  });
}

/** Close a submitted registration only from fresh shared-currency evidence. */
async function settleSubmission(
  context: JobContext,
  { record }: Ready,
  { attempt, blame }: BatchOutcome<ReadonlyMap<string, string>>,
  effectsOf: EffectsOf,
): Promise<Visit> {
  const { pool } = context;
  if (attempt.outcome === "not-submitted") return notSubmitted(attempt.reason);
  const shared = attempt.reconciled?.get(record.memeType);
  if (shared) {
    const by =
      attempt.outcome === "simulation-failed"
        ? "already-registered"
        : attempt.outcome === "executed"
          ? "registered-by-worker"
          : await attribution(effectsOf, attempt.digest, shared);
    return (await recordRegistered(pool, record, by, shared))
      ? { outcome: "registered", by }
      : { outcome: "skipped" };
  }
  return unsettledVisit(attempt, blame);
}

/** How a failure ends a visit: a lineage refusal is final; everything else as for every keeper job. */
function classify(error: unknown): Visit {
  if (error instanceof ForeignLineage) return { outcome: "rejected", errorClass: "foreign-lineage" };
  return classifyFailure(error);
}

/** Records how a record's visit ended, while its lease is held. */
async function record(context: JobContext, row: RegistrationRecord, visit: Visit): Promise<void> {
  if (visit.outcome === "retry") {
    // A submission counted itself when it recorded its digest; a failed simulation or a local failure counts here,
    // and a record whose batch another record failed gets its attempt back, due again at the shortest backoff.
    await recordRetry(
      context.pool,
      row,
      visit.errorClass,
      retryDelayMs(context.backoffMs, row.attempts, visit),
      visit.counted ? 1 : visit.refunded ? -1 : 0,
    );
  } else if (visit.outcome === "rejected" || visit.outcome === "stalled") {
    await recordRejected(context.pool, row, visit.outcome, visit.errorClass);
  }
}

function report(context: JobContext, row: RegistrationRecord, visit: Visit): void {
  const errorClass = "errorClass" in visit ? visit.errorClass : null;
  context.log(WORKER_METRICS.attempt, { outcome: visit.outcome, errorClass, attempts: row.attempts });
  context.log(WORKER_METRICS.record, {
    memeType: row.memeType,
    step: "visited",
    outcome: visit.outcome,
    errorClass,
  });
  if (visit.outcome === "registered") {
    context.log(WORKER_METRICS.registered, {
      outcome: visit.by,
      detectionToRegistrationMs: Math.max(0, Date.now() - row.detectedAt.getTime()),
    });
  }
}

async function run(context: JobContext): Promise<JobPass> {
  const blocked = await discover(context);
  if (blocked) {
    context.log(WORKER_METRICS.indexBlocked, { reasons: blocked.join(",") });
    return { blocked };
  }
  const { pool, config } = context;
  const network = context.deployment.network;
  await keepRecords<RegistrationRecord, Visit, Ready>(context, {
    job: REGISTRATION_JOB,
    leaseKey: (row) => `${row.network}:${row.memeType}`,
    examine: (row, leaseKey) => examine(context, row, leaseKey),
    classify,
    record: (row, visit) => record(context, row, visit),
    report: async (row, visit) => report(context, row, visit),
    batching: {
      capacity: config.recordsPerTransaction,
      weight: () => 1,
      alone: (ready) => triesAlone(ready.record),
      sendWhenFull: true,
      send: (batch) => registerBatch(context, batch),
    },
  }, await dueRecords(pool, network, config.batchSize));
  context.log(WORKER_METRICS.backlog, await readBacklog(pool, network));
  return { blocked: null };
}

/**
 * A registration intent as it comes back from storage (JSONB): parsed, never
 * cast. Anything malformed is a `SignerRefusal`, so nothing is signed.
 */
const registrationIntentSchema = z.object({
  memeType: z.string(),
  currency: z.object({ objectId: z.string(), version: z.string(), digest: z.string() }),
});

const registrationBatchSchema = z.object({
  records: z.array(registrationIntentSchema).min(1).max(MAX_RECORDS_PER_TRANSACTION),
});

/** A batch's stored intent (`{ records }`, in command order): parsed, never cast. */
export function parseRegistrationIntents(value: unknown): RegistrationIntent[] {
  const parsed = registrationBatchSchema.safeParse(value);
  if (!parsed.success) throw new SignerRefusal("a malformed intent");
  return parsed.data.records;
}

/** The registration job for the operational worker runtime. */
export function registrationJob(): WorkerJob<ProtocolWorkerAccess, KeeperSigner> {
  return Object.freeze({
    name: REGISTRATION_JOB,
    run,
    // Only `finalize_registration` of each intended pending currency, paying only gas.
    sign: async (signer: KeeperSigner, bytes: Uint8Array, intent: unknown, deployment: BlastDeployment) =>
      signer.signRegistrations(bytes, parseRegistrationIntents(intent), deployment),
  });
}
