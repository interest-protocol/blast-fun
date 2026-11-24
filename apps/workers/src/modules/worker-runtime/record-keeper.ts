// One record-keeper loop for the keeper jobs. Each pass a job discovers its
// records and reads the due ones; the loop then visits each under its lease:
// the job examines it from fresh reads, which either ends the visit or makes
// the record ready to send. Ready records ride in batches the job sends and
// settles; every record then finishes: the job records its visit, the lease
// is released, and the job reports it. A failure anywhere is classified the
// same way for every job.

import { errorLabel } from "@blast/core/lib/metrics.ts";
import { isDatabaseUnavailableError } from "@blast/core/modules/database/availability.ts";

import type { AttemptResult } from "./attempt.ts";
import { chunks, simulateSignSendBatch, type BatchOutcome, type BatchRecord } from "./batch.ts";
import { WORKER_METRICS } from "./log.ts";
import { ProviderUnavailable } from "./provider.ts";
import type { EnabledAccess, JobContext, WorkerSigner } from "./runtime.ts";
import { SignerRefusal } from "./signer.ts";

/** How a record's visit ended: every job's visit names its outcome. */
type KeptVisit = Readonly<{ outcome: string }>;

/** A visit that ended for later: `counted` grows the record's attempts, `refunded` gives one back. */
export type RetryVisit<ErrorClass extends string> = Readonly<{
  outcome: "retry";
  errorClass: ErrorClass;
  counted?: boolean;
  refunded?: boolean;
}>;

type SkippedVisit = Readonly<{ outcome: "skipped" }>;

/**
 * How a failure ends a visit. Outages of the node or the database are
 * uncounted retries: they say nothing about the record. A signer refusal
 * stalls, and anything else is a local failure (decoding, building, a
 * constraint): `internal-error`, counted, so it backs off further and ends in
 * `stalled`.
 */
type FailureVisit =
  | RetryVisit<"provider-unavailable" | "database-unavailable" | "internal-error">
  | Readonly<{ outcome: "stalled"; errorClass: "signer-refused" }>;

export function classifyFailure(error: unknown): FailureVisit {
  if (error instanceof ProviderUnavailable) return { outcome: "retry", errorClass: "provider-unavailable" };
  if (error instanceof SignerRefusal) return { outcome: "stalled", errorClass: "signer-refused" };
  if (isDatabaseUnavailableError(error)) return { outcome: "retry", errorClass: "database-unavailable" };
  return { outcome: "retry", errorClass: "internal-error", counted: true };
}

/** A record whose last attempt failed its own transaction is tried alone, so it cannot sink a batch twice. */
export function triesAlone(record: Readonly<{ errorClass: string | null }>): boolean {
  return record.errorClass === "simulation-failed" || record.errorClass === "execution-failed";
}

/** A retry's backoff: the shortest for a refunded attempt, otherwise grown by the record's attempts. */
export function retryDelayMs(
  backoffMs: (n: number) => number,
  attempts: number,
  visit: Pick<RetryVisit<string>, "refunded">,
): number {
  return backoffMs(visit.refunded ? 1 : attempts + 1);
}

/** The visits a pass logs: those that did something, and those the node could not serve. */
export function passCounts(visits: readonly KeptVisit[]): Readonly<{ visited: number; providerUnavailable: number }> {
  return {
    visited: visits.filter((visit) => visit.outcome !== "skipped").length,
    providerUnavailable: visits.filter((visit) => "errorClass" in visit && visit.errorClass === "provider-unavailable")
      .length,
  };
}

/**
 * Asks each distinct digest in turn who did it: `ours` as soon as one says
 * so, null while any could not say, `not-ours` when every one answered no.
 */
export async function attributeDigests(
  digests: readonly string[],
  verdictOf: (digest: string) => Promise<"ours" | "not-ours" | "unknown">,
): Promise<"ours" | "not-ours" | null> {
  let unknown = false;
  for (const digest of new Set(digests)) {
    const verdict = await verdictOf(digest);
    if (verdict === "ours") return "ours";
    if (verdict === "unknown") unknown = true;
  }
  return unknown ? null : "not-ours";
}

/** A record ready to send: what a batch needs of it, and its row with the lease held for it. */
type Leased<Row> = Readonly<{ record: Row; leaseKey: string }>;

/** How a job batches its ready records. */
type Batching<Ready, Visit extends KeptVisit> = Readonly<{
  /** Records per transaction. */
  capacity: number;
  /** How much of a transaction the record takes. */
  weight(ready: Ready): number;
  /** Sent in a batch of its own, at once; the open batch waits. */
  alone(ready: Ready): boolean;
  /** Send a batch as soon as it is full (otherwise only once the next record would not fit). */
  sendWhenFull: boolean;
  /** Sends a batch; resolves to how each of its records' visits ends. */
  send(batch: readonly Ready[]): Promise<(ready: Ready) => Promise<Visit>>;
}>;

type RecordKeeper<Row, Visit extends KeptVisit, Ready extends Leased<Row>> = Readonly<{
  /** The lease and log name. */
  job: string;
  leaseKey(row: Row): string;
  /** Everything before signing, from fresh reads: the visit when the record's pass ends here, or the record ready to send. */
  examine(row: Row, leaseKey: string): Promise<Visit | Ready>;
  /** The job's visit for a failure (built on `classifyFailure`). */
  classify(error: unknown): Visit;
  /** Writes how the visit ended, while the lease is held. */
  record(row: Row, visit: Visit): Promise<void>;
  /** Alerts and logs, once the lease is released. */
  report(row: Row, visit: Visit): Promise<void>;
  /** Absent for a job whose examine sends its own transaction. */
  batching?: Batching<Ready, Visit>;
}>;

type KeeperContext = Pick<JobContext, "leases" | "log">;

/** What finishing a visit needs of its job. */
type Finisher<Row, Visit extends KeptVisit> = Pick<RecordKeeper<Row, Visit, never>, "job" | "classify" | "record" | "report">;

/** Visits each row under its lease, in order, and returns the visit of every row whose lease it acquired. */
export async function keepRecords<Row, Visit extends KeptVisit, Ready extends Leased<Row>>(
  context: KeeperContext,
  keeper: RecordKeeper<Row, Visit, Ready>,
  rows: readonly Row[],
): Promise<Visit[]> {
  const visits: Visit[] = [];
  let batch: Ready[] = [];
  let load = 0;
  const flush = async (ready: readonly Ready[]) => {
    visits.push(...(await sendBatch(context, keeper, ready)));
  };

  for (const row of rows) {
    const leaseKey = keeper.leaseKey(row);
    if (!(await context.leases.acquire(keeper.job, leaseKey))) {
      continue;
    }
    const examined = await guarded(context, keeper, () => keeper.examine(row, leaseKey));
    if (isVisit<Visit>(examined)) {
      await finish(context, keeper, row, leaseKey, examined);
      visits.push(examined);
      continue;
    }

    const batching = keeper.batching;
    if (!batching) {
      await context.leases.release(keeper.job, leaseKey);
      throw new Error(`${keeper.job} made a record ready but sends no batches`);
    }
    if (batching.alone(examined)) {
      await flush([examined]);
      continue;
    }
    const weight = batching.weight(examined);
    if (load + weight > batching.capacity) {
      await flush(batch);
      batch = [];
      load = 0;
    }
    batch.push(examined);
    load += weight;
    if (batching.sendWhenFull && load >= batching.capacity) {
      await flush(batch);
      batch = [];
      load = 0;
    }
  }

  await flush(batch);
  return visits;
}

function isVisit<Visit extends KeptVisit>(value: Visit | object): value is Visit {
  return "outcome" in value;
}

/** Sends `batch` and finishes every record in it; a failure to send finishes them all as that failure. */
async function sendBatch<Row, Visit extends KeptVisit, Ready extends Leased<Row>>(
  context: KeeperContext,
  keeper: RecordKeeper<Row, Visit, Ready>,
  batch: readonly Ready[],
): Promise<Visit[]> {
  if (batch.length === 0) {
    return [];
  }
  let settle: ((ready: Ready) => Promise<Visit>) | null = null;
  let failure: Visit | null = null;
  try {
    settle = await keeper.batching!.send(batch);
  } catch (error) {
    failure = failed(context, keeper, error);
  }

  const visits: Visit[] = [];
  for (const ready of batch) {
    const visit = failure ?? (await guarded(context, keeper, () => settle!(ready)));
    await finish(context, keeper, ready.record, ready.leaseKey, visit);
    visits.push(visit);
  }
  return visits;
}

/** Runs one step of a visit; a failure becomes the job's visit for it. */
async function guarded<Row, Visit extends KeptVisit, Result>(
  context: KeeperContext,
  keeper: Finisher<Row, Visit>,
  step: () => Promise<Result>,
): Promise<Result | Visit> {
  try {
    return await step();
  } catch (error) {
    return failed(context, keeper, error);
  }
}

/** Classifies a failure, and logs it when it is a local or database one. */
function failed<Row, Visit extends KeptVisit>(
  context: KeeperContext,
  keeper: Finisher<Row, Visit>,
  error: unknown,
): Visit {
  const visit = keeper.classify(error);
  const errorClass = "errorClass" in visit ? visit.errorClass : null;
  if (visit.outcome === "retry" && (errorClass === "internal-error" || errorClass === "database-unavailable")) {
    context.log(WORKER_METRICS.jobError, { job: keeper.job, error: errorLabel(error) });
  }
  return visit;
}

/** Records how a record's visit ended, releases its lease, and reports it. */
async function finish<Row, Visit extends KeptVisit>(
  context: KeeperContext,
  keeper: Finisher<Row, Visit>,
  row: Row,
  leaseKey: string,
  visit: Visit,
): Promise<void> {
  try {
    await keeper.record(row, visit);
  } finally {
    await context.leases.release(keeper.job, leaseKey);
  }
  await keeper.report(row, visit);
}

/** A record of a batch the job sends whole: its commands and intent, its row and the lease held for it. */
export type LeasedReady<Row, Intent> = BatchRecord<Intent> & Leased<Row>;

/** A batch the runtime did not send: busy or unfunded keys retry uncounted; anything else is skipped. */
export function notSubmitted(reason: string | undefined): RetryVisit<"signer-busy" | "insufficient-gas"> | SkippedVisit {
  if (reason === "signer-busy" || reason === "insufficient-gas") return { outcome: "retry", errorClass: reason };
  return { outcome: "skipped" };
}

/**
 * A sent record its reconciliation does not show done. A failed simulation
 * counts here (a submission counted itself when it recorded its digest); a
 * record whose transaction another record failed gets its attempt back.
 */
export function unsettledVisit(
  attempt: AttemptResult<unknown>,
  blame: BatchOutcome<unknown>["blame"],
): RetryVisit<"simulation-failed" | "batch-failed" | "submission-unknown" | "awaiting-effects" | "execution-failed"> {
  if (attempt.outcome === "simulation-failed") return { outcome: "retry", errorClass: "simulation-failed", counted: true };
  if (attempt.outcome === "failed" && blame === "another") {
    return { outcome: "retry", errorClass: "batch-failed", refunded: true };
  }
  return {
    outcome: "retry",
    errorClass:
      attempt.outcome === "unknown"
        ? "submission-unknown"
        : attempt.outcome === "executed"
          ? "awaiting-effects"
          : "execution-failed",
  };
}

/** One chunk's settlement of each record: its outcome, and how many records shared its transaction. */
type Settle<Ready, Reconciled, Visit> = (
  ready: Ready,
  outcome: BatchOutcome<Reconciled>,
  records: number,
) => Promise<Visit>;

type LeasedBatchSteps<Ready, Reconciled, Visit> = Readonly<{
  /** Writes the digest on every record of the transaction, before its bytes are sent. */
  recordSubmissions(records: readonly Ready[], digest: string): Promise<boolean>;
  reconcile(records: readonly Ready[]): Promise<Reconciled>;
  /** A settlement for one chunk (it may cache reads across the chunk's records). */
  settler(): Settle<Ready, Reconciled, Visit>;
}>;

/**
 * Sends ready records in as few transactions as their failures allow
 * (`simulateSignSendBatch`), sized to what the address balance pays, and
 * settles each. Examining took time: a record whose lease is lost is skipped,
 * and each lease is renewed again just before the digest is recorded.
 */
export async function sendLeasedBatch<
  Row,
  Intent,
  Ready extends LeasedReady<Row, Intent>,
  Reconciled,
  Visit,
  Access extends EnabledAccess,
  Signer extends WorkerSigner,
>(
  context: JobContext<Access, Signer>,
  job: string,
  batch: readonly Ready[],
  steps: LeasedBatchSteps<Ready, Reconciled, Visit>,
): Promise<(ready: Ready) => Promise<Visit | SkippedVisit | RetryVisit<"insufficient-gas">>> {
  const visits = new Map<Ready, Visit | SkippedVisit | RetryVisit<"insufficient-gas">>();
  const settled = async (ready: Ready) => visits.get(ready) ?? { outcome: "skipped" as const };
  const affordable = await context.affordableRecords();
  if (affordable === 0) {
    for (const ready of batch) visits.set(ready, { outcome: "retry", errorClass: "insufficient-gas" });
    return settled;
  }

  for (const part of chunks(batch, affordable)) {
    const held = await stillHeld(context, job, part, visits);
    if (held.length > 0) await sendHeld(context, job, held, steps, visits);
  }
  return settled;
}

/** The records whose leases are still ours; each lost one is skipped. */
async function stillHeld<Ready extends Leased<unknown>>(
  context: KeeperContext,
  job: string,
  part: readonly Ready[],
  visits: Map<Ready, unknown>,
): Promise<Ready[]> {
  const held: Ready[] = [];
  for (const ready of part) {
    if (await context.leases.renew(job, ready.leaseKey)) held.push(ready);
    else visits.set(ready, { outcome: "skipped" });
  }
  return held;
}

async function sendHeld<Row, Intent, Ready extends LeasedReady<Row, Intent>, Reconciled, Visit, Access extends EnabledAccess, Signer extends WorkerSigner>(
  context: JobContext<Access, Signer>,
  job: string,
  held: readonly Ready[],
  steps: LeasedBatchSteps<Ready, Reconciled, Visit>,
  visits: Map<Ready, Visit | SkippedVisit | RetryVisit<"insufficient-gas">>,
): Promise<void> {
  const outcomes = await simulateSignSendBatch(context, held, {
    beforeSubmit: async (digest, records) => {
      for (const ready of records) {
        if (!(await context.leases.renew(job, ready.leaseKey))) return false;
      }
      return steps.recordSubmissions(records, digest);
    },
    reconcile: (records) => steps.reconcile(records),
  });
  const settle = steps.settler();
  for (const [ready, outcome] of outcomes) {
    const records = [...outcomes.values()].filter((other) => other.attempt === outcome.attempt).length;
    visits.set(ready, await settle(ready, outcome, records));
  }
}
