// The signer gate. Every transaction the worker's key sends is written here
// (open) before its bytes leave the process. While any of the key's
// submissions is open, the worker signs no new transaction: a job's next
// transaction must never run beside one that may still land. Gas comes from
// the key's address balance (no gas coin) and the bytes are valid during one
// epoch only (`ValidDuring`), so an open submission is settled only by the
// chain:
//
// - its digest has effects (`executed` or `failed`);
// - the epoch its expiration names has ended (`expired`): these bytes can
//   never run;
// - otherwise the same bytes are resent (the same transaction, never a new
//   one), and the submission stays open until one of the above holds.

import { and, eq, isNull, sql } from "drizzle-orm";
import type { ClientWithCoreApi } from "@mysten/sui/client";
import type { Pool } from "pg";

import { workerDatabase } from "#workers/lib/database.ts";
import { workerSubmissions as submissions } from "#workers/lib/database/schema.ts";
import { readDigestOutcome } from "./outcome.ts";
import type { Provider } from "./provider.ts";

const MODULE = "worker-runtime";

export type Resolution = "executed" | "failed" | "expired";

export type OpenSubmission = Readonly<{
  digest: string;
  job: string;
  /** Every record the transaction carries, in command order. */
  recordKeys: readonly string[];
  /** What the job's guarded sign method checks the bytes against. */
  intent: unknown;
  bytes: Uint8Array;
  /** The one epoch the bytes are valid during (`ValidDuring`). */
  expiresEpoch: bigint;
}>;

export async function openSubmissions(pool: Pool, signer: string, network: string): Promise<OpenSubmission[]> {
  const rows = await workerDatabase(pool, MODULE).select({
    digest: submissions.digest,
    job: submissions.job,
    recordKeys: submissions.recordKeys,
    intent: submissions.intent,
    bytes: submissions.transactionBytes,
    expiresEpoch: submissions.expiresEpoch,
  }).from(submissions).where(and(
    eq(submissions.signerAddress, signer), eq(submissions.network, network), isNull(submissions.resolvedAt),
  )).orderBy(submissions.submittedAt);
  return rows.map((row) => ({ ...row, bytes: new Uint8Array(row.bytes), expiresEpoch: BigInt(row.expiresEpoch) }));
}

/** Opens a submission before its bytes are sent; true when the row exists (a resend keeps its row). */
export async function recordOpenSubmission(
  pool: Pool,
  row: OpenSubmission & Readonly<{ signer: string; network: string }>,
): Promise<boolean> {
  await workerDatabase(pool, MODULE).insert(submissions).values({
    digest: row.digest,
    signerAddress: row.signer,
    network: row.network,
    job: row.job,
    recordKeys: [...row.recordKeys],
    intent: row.intent,
    transactionBytes: Buffer.from(row.bytes),
    expiresEpoch: row.expiresEpoch.toString(),
    submittedAt: sql`now()`,
  }).onConflictDoNothing({ target: submissions.digest });
  return true;
}

export async function resolveSubmission(pool: Pool, digest: string, resolution: Resolution): Promise<void> {
  await workerDatabase(pool, MODULE).update(submissions).set({ resolvedAt: sql`now()`, resolution }).where(and(
    eq(submissions.digest, digest), isNull(submissions.resolvedAt),
  ));
}


/** `executed`, `failed`, or null when the node has no effects for the digest (or cannot say). */
async function outcomeOf(client: ClientWithCoreApi, provider: Provider, digest: string): Promise<"executed" | "failed" | null> {
  const outcome = await readDigestOutcome(client, provider, digest, { effects: true });
  return outcome.kind === "executed" || outcome.kind === "failed" ? outcome.kind : null;
}

/**
 * Settles one open submission from fresh chain state, or resends its bytes.
 * Returns its resolution, or null while it may still run. Provider failures
 * other than the digest lookup propagate: the gate stays closed for the pass.
 */
export async function settleSubmission({
  client,
  provider,
  submission,
  resend,
}: Readonly<{
  client: ClientWithCoreApi;
  provider: Provider;
  submission: OpenSubmission;
  /** Signs and sends the same bytes again; returns the effects' outcome, or null when still unknown. */
  resend(): Promise<"executed" | "failed" | null>;
}>): Promise<Resolution | null> {
  const landed = await outcomeOf(client, provider, submission.digest);
  if (landed) return landed;

  const { systemState } = await provider((signal) => client.core.getCurrentSystemState({ signal }));
  if (BigInt(systemState.epoch) > submission.expiresEpoch) return "expired";

  return resend();
}

