// Several records in one transaction. A PTB is atomic: one record's abort
// fails them all, so the batch isolates it before anything is signed. A
// simulation that fails names the failing command; its record is dropped
// (it ends `simulation-failed`) and the rest are built and simulated again,
// at most once per record. A failure that names no command sends each record
// alone. A batch the job does not admit (its `admit` says the transaction is
// not worth its gas) drops its last record and tries again, so a job orders
// records most valuable first. Once signed, the batch lands or fails as one;
// the effects' error names the record to blame for a failure.
//
// Command spans are counted while the records add their commands. A
// `tx.coin` intent occupies one command and resolves in place when built,
// so the counts hold for the built bytes.

import { Transaction } from "@mysten/sui/transactions";

import type { AttemptResult } from "./attempt.ts";
import type { EnabledAccess, JobContext, WorkerSigner } from "./runtime.ts";

/** One record of a batch: its key (its lease key), the intent its commands are checked against, and the commands. */
export type BatchRecord<Intent> = Readonly<{
  key: string;
  intent: Intent;
  /** Adds this record's commands to the batch's transaction. */
  add(transaction: Transaction): void;
}>;

export type BatchOutcome<Reconciled> = Readonly<{
  attempt: AttemptResult<Reconciled>;
  /**
   * Whose failure it is. `this`: this record's command failed the simulation
   * or the effects, or it was dropped as not worth its gas. `another`: it rode
   * in a transaction another record's command failed. `none`: nothing failed,
   * or the failure named no command.
   */
  blame: "this" | "another" | "none";
}>;

/** The stored intent of a batch: the records' intents in command order. */
export type BatchIntent<Intent> = Readonly<{ records: readonly Intent[] }>;

type Steps<Item, Reconciled> = Readonly<{
  beforeSubmit(digest: string, records: readonly Item[]): Promise<boolean>;
  reconcile(records: readonly Item[]): Promise<Reconciled>;
  admit?(gasCostMist: bigint, records: readonly Item[]): boolean;
}>;

/**
 * Simulates, signs and sends `records` in as few transactions as their
 * failures allow, through the runtime's `submit` (so the signer gate, the
 * guarded signature and the ledger apply to each). Returns every record's
 * outcome. `beforeSubmit`, `reconcile` and `admit` receive the records of the
 * transaction at hand.
 */
export async function simulateSignSendBatch<
  Intent,
  Item extends BatchRecord<Intent>,
  Reconciled,
  Access extends EnabledAccess,
  Signer extends WorkerSigner,
>(
  context: JobContext<Access, Signer>,
  records: readonly Item[],
  steps: Steps<Item, Reconciled>,
): Promise<Map<Item, BatchOutcome<Reconciled>>> {
  const outcomes = new Map<Item, BatchOutcome<Reconciled>>();
  let batch: readonly Item[] = records;
  while (batch.length > 0) batch = await sendIsolatingFailures(context, batch, steps, outcomes);
  return outcomes;
}

/** The record whose commands hold the command the error names, if it names one. */
function recordOfError<Item>(
  attempt: AttemptResult<unknown>,
  records: readonly Item[],
  ends: readonly number[],
): Item | undefined {
  const error =
    attempt.outcome === "simulation-failed" ? attempt.simulationError
    : attempt.outcome === "failed" ? attempt.executionError
    : undefined;
  const command = error?.command;
  return command === undefined ? undefined : records[ends.findIndex((end) => command < end)];
}

/** One transaction of `records`, and where each record's commands end. */
function buildBatch(records: readonly BatchRecord<unknown>[]): Readonly<{ transaction: Transaction; ends: number[] }> {
  const transaction = new Transaction();
  const ends: number[] = [];
  for (const record of records) {
    record.add(transaction);
    ends.push(transaction.getData().commands.length);
  }
  return { transaction, ends };
}

/**
 * Records the outcomes `attempt` settles for `current`. Returns the records to
 * send again (the rest after a dropped record, or none), or `alone` when a
 * failed simulation named no command.
 */
function settleAttempt<Item, Reconciled>(
  attempt: AttemptResult<Reconciled>,
  current: readonly Item[],
  ends: readonly number[],
  outcomes: Map<Item, BatchOutcome<Reconciled>>,
): readonly Item[] | "alone" {
  const culprit = recordOfError(attempt, current, ends);
  const several = current.length > 1;
  if (several && attempt.outcome === "simulation-failed") {
    if (!culprit) return "alone";
    outcomes.set(culprit, { attempt, blame: "this" });
    return current.filter((record) => record !== culprit);
  }
  if (several && attempt.outcome === "not-submitted" && attempt.reason === "not-admitted") {
    outcomes.set(current.at(-1)!, { attempt, blame: "this" });
    return current.slice(0, -1);
  }
  const blamed = culprit ?? (attempt.outcome === "simulation-failed" ? current[0] : undefined);
  for (const record of current) {
    outcomes.set(record, { attempt, blame: !blamed ? "none" : record === blamed ? "this" : "another" });
  }
  return [];
}

/**
 * Sends `current` as one transaction and records the outcomes it settles.
 * Returns the records to send again: the rest after a dropped record, or none.
 */
async function sendIsolatingFailures<Intent, Item extends BatchRecord<Intent>, Reconciled, Access extends EnabledAccess, Signer extends WorkerSigner>(
  context: JobContext<Access, Signer>,
  current: readonly Item[],
  steps: Steps<Item, Reconciled>,
  outcomes: Map<Item, BatchOutcome<Reconciled>>,
): Promise<readonly Item[]> {
  const { transaction, ends } = buildBatch(current);
  const intent: BatchIntent<Intent> = { records: current.map((record) => record.intent) };
  const admit = steps.admit;
  const attempt = await context.submit({
    recordKeys: current.map((record) => record.key),
    intent,
    transaction,
    beforeSubmit: (digest) => steps.beforeSubmit(digest, current),
    reconcile: () => steps.reconcile(current),
    admit: admit ? (gasCostMist) => admit(gasCostMist, current) : undefined,
  });
  const next = settleAttempt(attempt, current, ends, outcomes);
  if (next !== "alone") return next;
  // A failed simulation that named no command: each record alone.
  for (const record of current) {
    outcomes.set(record, (await simulateSignSendBatch(context, [record], steps)).get(record)!);
  }
  return [];
}

/** Splits `items` into consecutive batches of at most `size`. */
export function chunks<Item>(items: readonly Item[], size: number): Item[][] {
  const batches: Item[][] = [];
  for (let start = 0; start < items.length; start += size) batches.push(items.slice(start, start + size));
  return batches;
}
