// The operational runtime validates the deployment, bounds provider reads and
// runs guarded jobs. Outbox jobs coordinate exact prepared inputs before crypto
// signing and retain those resources until definitive resolution. Other worker
// domains retain their own signer lease and submission gate.
//
// Step 1 is the caller's `AccessCheck`; the runtime, its jobs and their signer
// are typed by what that check accepts.

import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";
import { Inputs, type Transaction } from "@mysten/sui/transactions";
import { normalizeSuiObjectId } from "@mysten/sui/utils";
import type { Pool } from "pg";

import { errorLabel } from "@blast/core/lib/metrics.ts";
import { retryDelayMs } from "@blast/core/modules/database/retry.ts";
import { sql } from "drizzle-orm";
import { workerDatabase } from "#workers/lib/database.ts";
import { workerJobs as jobs } from "#workers/lib/database/schema.ts";
import { ChainMismatch, budgetSenderBalanceGas, payFromSenderBalance, readSenderBalanceGas, type SenderBalanceGas } from "./address-balance.ts";
import { attemptOnce, estimateGasBudget, sendOnce, type AttemptResult, type GasEstimate } from "./attempt.ts";
import type { WorkerConfig } from "./config.ts";
import type { WorkerAccess } from "./deployment.ts";
import { leases as leaseRows, type Leases } from "./lease.ts";
import { pollUntilAborted } from "./poll.ts";
import {
  redactingLog,
  WORKER_METRICS,
  type WorkerLog,
} from "./log.ts";
import { boundedProvider } from "./provider.ts";
import { gasBudgetFor, type SignedTransaction } from "./signer.ts";
import {
  openSubmissions,
  recordOpenSubmission,
  resolveSubmission,
  settleSubmission,
} from "./submissions.ts";

export type FundingAlert = Readonly<{
  balanceMist: bigint;
  thresholdMist: bigint;
  gasBudgetMist: bigint;
}>;

/** The lease job that makes one process per signer key the active one. */
export const SIGNER_LEASE_JOB = "signer";

/** The durable custody barrier an outbox job holds around the crypto signature. */
export type SigningReservation = Readonly<{
  beforeSign(bytes: Uint8Array): Promise<void>;
  afterSign(bytes: Uint8Array): Promise<void>;
}>;

/** One transaction a job wants signed, with what its guarded sign method checks. */
export type Submission<Reconciled> = Readonly<{
  /**
   * The job's key of every record the transaction carries (each its lease
   * key), in command order, stored with the open submission. The gas budget
   * is `gasBudgetFor(BLAST_WORKER_GAS_BUDGET_MIST, recordKeys.length)`.
   */
  recordKeys: readonly string[];
  inputReservation?: SigningReservation;
  /** What the job's `sign` checks the bytes against; stored to resend the same bytes. */
  intent: unknown;
  /** The SDK-built transaction; the runtime sets sender, gas (the address balance), budget and expiration. */
  transaction: Transaction;
  /** Use this simulation-derived gas budget and verify the prepared bytes before signing. */
  estimatedGasBudgetMist?: bigint;
  /** Renews the job's own lease and records the digest; false stops before anything is sent. */
  beforeSubmit(
    digest: string,
    signed: SignedTransaction,
    bytes: Uint8Array,
  ): Promise<boolean>;
  /** A fresh read of what the chain now says. */
  reconcile(): Promise<Reconciled>;
  /**
   * Optional: after a successful simulation, whether the transaction is worth
   * its simulated gas cost in MIST, given the events it would emit; false
   * signs and sends nothing (`not-submitted`, `not-admitted`).
   */
  admit?(gasCostMist: bigint, events: readonly SuiClientTypes.Event[]): boolean;
}>;

/**
 * Pass step 1's verdict when this process may sign: the accepted deployment
 * (whose `network` keys the signer lease and the submissions) and whatever
 * else the check hands its jobs. Every field but `status` reaches `JobContext`.
 */
export type EnabledAccess = Readonly<{
  status: "enabled";
  deployment: Readonly<{ network: string; chainIdentifier: string }>;
}>;

/** Pass step 1's verdict when nothing may be signed: short reason codes (`^[a-z][a-z0-9-]*$`). */
export type BlockedAccess = Readonly<{
  status: "blocked";
  network: string;
  reasons: readonly string[];
}>;

/**
 * The launchpad's verdict, the default: the SDK deployment, its fingerprint
 * and `protocol` (the SDK's evaluation this pass: a venue action also needs
 * `protocol.venues[venue].available`).
 */
export type ProtocolWorkerAccess = Extract<WorkerAccess, { status: "enabled" }>;

/** Pass step 1: whether this process may sign this pass, and against what. Runs every pass. */
export type AccessCheck<Access extends EnabledAccess> = () => Promise<
  Access | BlockedAccess
>;

/** What every signer gives the runtime: the address that sends and pays. Jobs add guarded methods. */
export type WorkerSigner = Readonly<{ address: string }>;

/** What one job may use for one pass. Everything it signs goes through `submit`. */
export type JobContext<
  Access extends EnabledAccess = ProtocolWorkerAccess,
  Signer extends WorkerSigner = WorkerSigner,
> = Readonly<
  Omit<Access, "status"> & {
    pool: Pool;
    client: ClientWithCoreApi;
    config: WorkerConfig;
    signer: Signer;
    leases: Leases;
    /** Metrics and logs; never throws (a failing sink is dropped). */
    log: WorkerLog;
    /** One provider call within the configured budget. */
    provider<Result>(
      call: (signal: AbortSignal) => Promise<Result>,
    ): Promise<Result>;
    /** Reads the key's SUI address balance; fires the funding alert below its threshold; false when it cannot pay the gas budget. */
    gasAvailable(): Promise<boolean>;
    /** Like `gasAvailable`: how many records' gas budgets the address balance covers (0 when not one). */
    affordableRecords(): Promise<number>;
    /** False while the key has an unsettled submission (or lost its lease): sign nothing. */
    canSign(): boolean;
    /** Full-jitter backoff ceiling base × 2^(n − 1), capped at the configured maximum. */
    backoffMs(n: number): number;
    /** Take one funding snapshot for unsigned gas probes, or return null when unavailable. */
    gasEstimator(ceiling: bigint): Promise<((transaction: Transaction) => Promise<GasEstimate>) | null>;
    /** Prepares, simulates, signs (through the job's `sign`), records, submits once, awaits, reconciles. */
    submit<Reconciled>(
      submission: Submission<Reconciled>,
    ): Promise<AttemptResult<Reconciled>>;
  }
>;

/** A job's verdict on its pass: reason codes while it refuses its input, or null. */
export type JobPass = Readonly<{ blocked: readonly string[] | null }>;

export interface WorkerJob<
  Access extends EnabledAccess = ProtocolWorkerAccess,
  Signer extends WorkerSigner = WorkerSigner,
> {
  /** Its lease and job-state name (`^[a-z][a-z0-9-]*$`). */
  readonly name: string;
  readonly inputReservations?: boolean;
  readonly signsNothing?: boolean;
  /**
   * The job's guarded signature: the signer method that refuses anything but
   * exactly this job's transaction for `intent`. Also used to resend the same
   * bytes of an open submission, whose intent comes back from storage as
   * `unknown`: the job parses it (never casts) and refuses a malformed one.
   * `deployment` is this pass's accepted deployment: what the job signs is
   * bound to its packages, never to what a stored intent names.
   */
  sign(
    signer: Signer,
    bytes: Uint8Array,
    intent: unknown,
    deployment: Access["deployment"],
    beforeCrypto?: () => Promise<void>,
  ): Promise<SignedTransaction>;
  run(context: JobContext<Access, Signer>): Promise<JobPass>;
}

export type PassReport = Readonly<{
  access:
    | Readonly<{ status: "enabled" }>
    | Readonly<{ status: "blocked"; reasons: readonly string[] }>;
  /** `standby`: another process holds this key's signer lease; this one did nothing. */
  role: "active" | "standby" | "blocked";
}>;

export type OperationalWorker = Readonly<{
  holder: string;
  runPass(): Promise<PassReport>;
  /** Runs passes every poll interval until `signal` aborts; the current pass finishes first, then `release`. */
  run(signal: AbortSignal): Promise<void>;
  /** Releases the signer lease, so a standby takes over at once. */
  release(): Promise<void>;
}>;

async function recordBlock(
  pool: Pool,
  job: string,
  network: string,
  reasons: readonly string[] | null,
): Promise<void> {
  await workerDatabase(pool, "worker-runtime")
    .insert(jobs)
    .values({
      job,
      network,
      blockedReasons: reasons === null ? null : [...reasons],
      blockedAt: reasons === null ? null : sql`now()`,
      updatedAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: [jobs.job, jobs.network],
      set: {
        blockedReasons: sql`excluded.blocked_reasons`,
        blockedAt: sql`CASE
        WHEN excluded.blocked_reasons IS NULL THEN NULL
        WHEN ${jobs.blockedReasons} = excluded.blocked_reasons THEN ${jobs.blockedAt}
        ELSE now() END`,
        updatedAt: sql`now()`,
      },
    });
}

/**
 * A build-only client: the transaction's shared inputs come from reads
 * already made. Every unresolved input must be a shared object, and it is
 * built as a **mutable** shared reference (`finalize_registration` takes
 * `&mut CoinRegistry`); any other unresolved object is refused. A job that
 * needs an immutable shared input (such as the Clock) or an owned object
 * passes it pre-resolved (`tx.sharedObjectRef({ …, mutable: false })`,
 * `tx.objectRef`, `tx.receivingRef`).
 */
function offlineClient(shared: ReadonlyMap<string, string>): ClientWithCoreApi {
  const plugin = async (
    data: {
      inputs: Array<{ $kind: string; UnresolvedObject?: { objectId: string } }>;
    },
    _options: unknown,
    next: () => Promise<void>,
  ) => {
    for (const [index, input] of data.inputs.entries()) {
      if (input.$kind !== "UnresolvedObject" || !input.UnresolvedObject)
        continue;
      const objectId = normalizeSuiObjectId(input.UnresolvedObject.objectId);
      const initialSharedVersion = shared.get(objectId);
      if (initialSharedVersion === undefined)
        throw new Error("The transaction names an object that is not shared.");
      data.inputs[index] = Inputs.SharedObjectRef({
        objectId,
        initialSharedVersion,
        mutable: true,
      }) as never;
    }
    await next();
  };
  return {
    core: { resolveTransactionPlugin: () => plugin },
  } as unknown as ClientWithCoreApi;
}

export function createWorker<
  Access extends EnabledAccess = ProtocolWorkerAccess,
  Signer extends WorkerSigner = WorkerSigner,
>({
  config,
  pool,
  client,
  signer,
  jobs,
  holder,
  log: sink = redactingLog([]),
  onFundingAlert,
  random = Math.random,
  access: accessCheck,
}: Readonly<{
  config: WorkerConfig;
  pool: Pool;
  client: ClientWithCoreApi;
  signer: Signer;
  jobs: readonly WorkerJob<Access, Signer>[];
  /** This process's lease holder ID. */
  holder: string;
  log?: WorkerLog;
  /** Called (besides the `worker.funding_alert` metric) when the address balance is below the alert threshold. */
  onFundingAlert?: (alert: FundingAlert) => void;
  random?: () => number;
  /** Pass step 1. */
  access: AccessCheck<Access>;
}>): OperationalWorker {
  /** Telemetry never blocks: a failing metric write is dropped here, so none can fail a pass, the gate or a job. */
  const log: WorkerLog = (name, fields) => {
    try {
      sink(name, fields);
    } catch {
      // Dropped: the work carries on.
    }
  };
  const leases = leaseRows(pool, holder, config.timings.leaseTtlMs);
  const bounds = {
    providerTimeoutMs: config.timings.providerTimeoutMs,
    confirmTimeoutMs: config.timings.confirmTimeoutMs,
  };
  const provider = boundedProvider(config.timings.providerTimeoutMs);
  /** The signer lease key of the network this process last served, for `release`. */
  let signerKey: string | null = null;

  /** The key's SUI address balance, with the funding alert below its threshold. */
  function alertLowBalance(balanceMist: bigint): void {
    if (balanceMist < config.fundingAlertMist) {
      const alert = {
        balanceMist,
        thresholdMist: config.fundingAlertMist,
        gasBudgetMist: config.gasBudgetMist,
      };
      log(WORKER_METRICS.fundingAlert, {
        balanceMist: String(balanceMist),
        thresholdMist: String(config.fundingAlertMist),
        canSubmit: balanceMist >= config.gasBudgetMist,
      });
      try {
        onFundingAlert?.(alert);
      } catch {
        // An alert hook's failure is telemetry's too: the visit carries on.
      }
    }
  }

  async function addressBalanceMist(): Promise<bigint> {
    const { balance } = await provider((signal) =>
      client.core.getBalance({ owner: signer.address, signal }),
    );
    // Only the address balance pays gas: coin objects at the key's address never do.
    const balanceMist = BigInt(balance.addressBalance);
    alertLowBalance(balanceMist);
    return balanceMist;
  }

  async function gasAvailable(): Promise<boolean> {
    return (await addressBalanceMist()) >= config.gasBudgetMist;
  }

  async function affordableRecords(): Promise<number> {
    const records = (await addressBalanceMist()) / config.gasBudgetMist;
    return records > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(records);
  }

  /**
   * Pays from the key's SUI address balance (`payFromSenderBalance`) for the
   * requested budget or available balance when estimating. The bytes run in the current epoch alone;
   * resolves shared inputs from fresh reads, and builds offline. Null when the
   * address balance cannot pay the gas budget plus the SUI the transaction
   * itself withdraws from it (a Bluefin pool-creation fee). Throws
   * `ChainMismatch` when the node is on another chain than `deployment`.
   * Build errors are local, never provider outages.
   */
  async function prepare(
    transaction: Transaction,
    deployment: Access["deployment"],
    gasBudgetMist: bigint,
    estimateGasFrom?: SenderBalanceGas,
  ) {
    const unresolved = transaction.getData().inputs.flatMap((input) =>
      input.$kind === "UnresolvedObject"
        ? [normalizeSuiObjectId(input.UnresolvedObject.objectId)]
        : [],
    );
    const [payment, objects] = await Promise.all([
      estimateGasFrom
        ? budgetSenderBalanceGas(transaction, estimateGasFrom, gasBudgetMist, true)
        : payFromSenderBalance(transaction, {
            client,
            provider,
            sender: signer.address,
            gasBudgetMist,
            chainIdentifier: deployment.chainIdentifier,
          }),
      unresolved.length === 0
        ? Promise.resolve({ objects: [] })
        : provider((signal) =>
            client.core.getObjects({ objectIds: unresolved, signal }),
          ),
    ]);
    if (payment.kind === "wrong-chain") {
      throw new ChainMismatch();
    }
    if (payment.kind === "insufficient-gas") {
      return null;
    }
    const shared = new Map<string, string>();
    for (const object of objects.objects) {
      if (object instanceof Error || object.owner.$kind !== "Shared") continue;
      shared.set(
        normalizeSuiObjectId(object.objectId),
        String(object.owner.Shared.initialSharedVersion),
      );
    }
    const bytes = await transaction.build({ client: offlineClient(shared) });
    return { bytes, expiresEpoch: BigInt(payment.epoch), gasBudgetMist: payment.gasBudgetMist };
  }

  async function signingAvailable(
    deployment: Access["deployment"],
    network: string,
    holdSigner: () => Promise<boolean>,
  ): Promise<boolean> {
    let signing = true;
    try {
      for (const open of await openSubmissions(pool, signer.address, network)) {
        const job = jobs.find((candidate) => candidate.name === open.job);
        const resolution = await settleSubmission({
          client,
          provider,
          submission: open,
          resend: async () => {
            if (!job || !(await holdSigner())) return null;
            const signed = await job.sign(
              signer,
              open.bytes,
              open.intent,
              deployment,
            );
            if (signed.digest !== open.digest)
              throw new Error("A resend must be the same transaction.");
            log(WORKER_METRICS.resent, { job: open.job });
            return sendOnce(client, open.bytes, signed, bounds);
          },
        });
        log(WORKER_METRICS.gate, {
          job: open.job,
          resolution: resolution ?? "open",
        });
        if (resolution === null) {
          signing = false;
          break;
        }
        await resolveSubmission(pool, open.digest, resolution);
      }
    } catch (error) {
      // A provider failure: no definite answer, so nothing new is signed this pass.
      signing = false;
      log(WORKER_METRICS.gate, {
        job: "signer-gate",
        resolution: "unreadable",
        error: errorLabel(error),
      });
    }
    return signing;
  }

  async function runPass(): Promise<PassReport> {
    const started = performance.now();
    const access = await accessCheck();
    if (access.status === "blocked") {
      log(WORKER_METRICS.configBlocked, { reasons: access.reasons.join(",") });
      for (const job of jobs)
        await recordBlock(pool, job.name, access.network, access.reasons);
      log(WORKER_METRICS.pass, {
        access: "blocked",
        durationMs: Math.round(performance.now() - started),
      });
      return {
        access: { status: "blocked", reasons: access.reasons },
        role: "blocked",
      };
    }
    const network = access.deployment.network;
    const key = `${network}:${signer.address}`;
    signerKey = key;
    const independent = jobs.every(
      (job) => job.inputReservations || job.signsNothing,
    );
    const holdSigner = () =>
      independent ? Promise.resolve(true) : leases.renew(SIGNER_LEASE_JOB, key);
    if (
      !independent &&
      !((await holdSigner()) || (await leases.acquire(SIGNER_LEASE_JOB, key)))
    ) {
      log(WORKER_METRICS.standby, { network });
      return { access: { status: "enabled" }, role: "standby" };
    }

    let signing =
      independent ||
      (await signingAvailable(access.deployment, network, holdSigner));

    // Every field of the verdict but `status` reaches the jobs.
    const { status, ...accepted } = access;
    for (const job of jobs) {
      const context = Object.freeze({
        ...accepted,
        pool,
        client,
        config,
        signer,
        leases,
        log,
        provider,
        gasAvailable,
        affordableRecords,
        canSign: () => signing,
        backoffMs: (n: number) =>
          retryDelayMs(
            Math.max(1, n),
            {
              attempts: 1,
              baseDelayMs: config.timings.retryBaseMs,
              maxDelayMs: config.timings.retryMaxMs,
            },
            random,
          ),
        async gasEstimator(ceiling: bigint) {
          if (!signing) return null;
          const gas = await readSenderBalanceGas({ client, provider, sender: signer.address, chainIdentifier: access.deployment.chainIdentifier });
          if (!gas) throw new ChainMismatch();
          alertLowBalance(gas.balanceMist);
          if (gas.balanceMist <= 0n) return null;
          return async (transaction: Transaction): Promise<GasEstimate> => {
            const prepared = await prepare(transaction, access.deployment, ceiling, gas);
            if (!prepared) return { kind: "unavailable" };
            return estimateGasBudget(client, prepared.bytes, prepared.gasBudgetMist, bounds);
          };
        },
        async submit<Reconciled>(
          submission: Submission<Reconciled>,
        ): Promise<AttemptResult<Reconciled>> {
          if (!signing)
            return {
              outcome: "not-submitted",
              reason: "signer-busy",
              digest: null,
              reconciled: null,
            };
          if (independent && !submission.inputReservation)
            throw new Error("Independent signing requires input reservations.");
          const budget = submission.estimatedGasBudgetMist ?? gasBudgetFor(config.gasBudgetMist, submission.recordKeys.length);
          const prepared = await prepare(submission.transaction, access.deployment, budget);
          if (!prepared)
            return {
              outcome: "not-submitted",
              reason: "insufficient-gas",
              digest: null,
              reconciled: null,
            };
          const result = await attemptOnce({
            client,
            bytes: prepared.bytes,
            bounds,
            estimatedGasBudgetMist: submission.estimatedGasBudgetMist,
            sign: async (bytes) => {
              let guarded = false;
              const signed = await job.sign(
                signer,
                bytes,
                submission.intent,
                access.deployment,
                submission.inputReservation
                  ? async () => {
                      guarded = true;
                      await submission.inputReservation!.beforeSign(bytes);
                    }
                  : undefined,
              );
              if (submission.inputReservation) {
                if (!guarded)
                  throw new Error(
                    "Job bypassed the guarded input signing barrier.",
                  );
                await submission.inputReservation.afterSign(bytes);
              }
              return signed;
            },
            beforeSubmit: async (digest, signed) => {
              // Outbox ownership and prepared inputs fence reserved work; other jobs renew the signer lease.
              if (!(await holdSigner())) {
                signing = false;
                return false;
              }
              // A durable write may commit before its acknowledgement fails.
              if (!independent) signing = false;
              if (
                !(await submission.beforeSubmit(digest, signed, prepared.bytes))
              )
                return false;
              if (submission.inputReservation) return true;
              return recordOpenSubmission(pool, {
                digest,
                signer: signer.address,
                network,
                job: job.name,
                recordKeys: submission.recordKeys,
                intent: submission.intent,
                bytes: prepared.bytes,
                expiresEpoch: prepared.expiresEpoch,
              });
            },
            reconcile: submission.reconcile,
            admit: submission.admit,
          });
          if (
            result.digest &&
            (result.outcome === "executed" || result.outcome === "failed")
          ) {
            await resolveSubmission(pool, result.digest, result.outcome);
            signing = true;
          }
          return result;
        },
      }) as JobContext<Access, Signer>;
      try {
        const verdict = await job.run(context);
        await recordBlock(pool, job.name, network, verdict.blocked);
      } catch (error) {
        log(WORKER_METRICS.jobError, {
          job: job.name,
          error: errorLabel(error),
        });
      }
    }
    // Keep the key between passes, so the standby stays idle.
    await holdSigner();
    log(WORKER_METRICS.pass, {
      access: "enabled",
      signing,
      durationMs: Math.round(performance.now() - started),
    });
    return { access: { status }, role: "active" };
  }

  async function release() {
    if (signerKey) await leases.release(SIGNER_LEASE_JOB, signerKey);
  }

  return Object.freeze({
    holder,
    runPass,
    release,
    async run(signal: AbortSignal) {
      await pollUntilAborted(signal, async () => {
        try {
          await runPass();
        } catch (error) {
          log(WORKER_METRICS.jobError, {
            job: "runtime",
            error: errorLabel(error),
          });
        }
        return config.timings.pollIntervalMs;
      });
      await release();
    },
  });
}
