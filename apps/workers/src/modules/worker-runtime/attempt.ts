// The one submission path: simulate → sign → record (lease renewed, digest and
// open submission written) → submit once → await effects → reconcile. Records
// are written before the bytes leave the process, so a crash after submission
// still names what may have landed, and the signer gate (`submissions.ts`)
// blocks every new signature until the chain settles it. The bytes are
// submitted once here; only the gate resends them (the same bytes), and only
// the record's backoff retries.

import type { ClientWithCoreApi, SuiClientTypes } from "@mysten/sui/client";

import { bounded } from "./provider.ts";
import type { SignedTransaction } from "./signer.ts";

export type AttemptOutcome =
  /** The node rejected the bytes in simulation; nothing was signed. */
  | "simulation-failed"
  /** Nothing was sent: the gate is closed, the address balance cannot pay, or a lease or record write was lost. */
  | "not-submitted"
  /** Effects show the transaction succeeded. */
  | "executed"
  /** Effects show it failed on chain (only gas was spent). */
  | "failed"
  /** Sent, and no effects within the bounds: it may still land. */
  | "unknown";

export type AttemptResult<Reconciled> = Readonly<{
  outcome: AttemptOutcome;
  /** Why nothing was sent, for `not-submitted`. */
  reason?: "signer-busy" | "insufficient-gas" | "lease-lost" | "intent-enqueued" | "not-admitted";
  /** The simulated gas cost in MIST, when the attempt asked for it (`admit`). */
  gasCostMist?: bigint;
  digest: string | null;
  /** The fresh chain state after the attempt; null when nothing was sent. */
  reconciled: Reconciled | null;
  /** For `simulation-failed`: the node's execution error (abort location, command), or null when it gave none. */
  simulationError?: SuiClientTypes.ExecutionError | null;
  /** For `failed`: the effects' execution error (abort location, command), or null when they gave none. */
  executionError?: SuiClientTypes.ExecutionError | null;
}>;

export type AttemptBounds = Readonly<{ providerTimeoutMs: number; confirmTimeoutMs: number }>;

/**
 * What the simulated transaction would charge the sender: computation plus
 * storage less the storage rebate, never less than the computation cost.
 */
export function simulatedGasCostMist(gasUsed: SuiClientTypes.GasCostSummary): bigint {
  const computation = BigInt(gasUsed.computationCost);
  const net = computation + BigInt(gasUsed.storageCost) - BigInt(gasUsed.storageRebate);
  return net > computation ? net : computation;
}

export type GasEstimate =
  | { kind: "fits"; budgetMist: bigint }
  | { kind: "capacity" | "unavailable" | "simulation-failed" };

async function simulateExactGas(client: ClientWithCoreApi, bytes: Uint8Array, bounds: AttemptBounds, includeEvents = false) {
  const result = await bounded(bounds.providerTimeoutMs, (signal) => client.core.simulateTransaction({
    transaction: bytes,
    include: { effects: true, bcs: true, events: includeEvents },
    // Ask for real gas. Some fullnodes otherwise install a synthetic gas coin
    // for an empty payment list, even when the address balance covers gas.
    doGasSelection: true,
    signal,
  }));
  const simulatedBytes = (result.Transaction ?? result.FailedTransaction)?.bcs;
  if (result.gasPaymentMocked || !simulatedBytes || Buffer.compare(simulatedBytes, bytes) !== 0) return null;
  return result;
}

function withinGasBudget(gas: SuiClientTypes.GasCostSummary | undefined, budget: bigint | undefined): boolean {
  return budget === undefined || (gas !== undefined && simulatedGasCostMist(gas) <= budget);
}

/** Budget as Sui does: cover computation, plus storage charges net of the sender rebate. */
export async function estimateGasBudget(
  client: ClientWithCoreApi,
  bytes: Uint8Array,
  ceiling: bigint,
  bounds: AttemptBounds,
): Promise<GasEstimate> {
  const simulation = await simulateExactGas(client, bytes, bounds);
  if (!simulation) return { kind: "unavailable" };
  if (simulation.$kind === "FailedTransaction") {
    const status = simulation.FailedTransaction.status;
    const error = status && !status.success ? status.error : null;
    // The SDK maps InsufficientGas to Unknown. Nodes use Rust debug or display formatting.
    return error?.$kind === "SizeError" ||
      (error?.$kind === "Unknown" && /^Insufficient ?Gas(?: in command [0-9]+)?\.?$/i.test(error.message.trim()))
      ? { kind: "capacity" }
      : { kind: "simulation-failed" };
  }

  const gas = simulation.Transaction.effects?.gasUsed;
  if (!gas) return { kind: "unavailable" };
  const cost = simulatedGasCostMist(gas);
  if (cost > ceiling) return { kind: "capacity" };
  const padded = cost + (cost + 9n) / 10n;
  return { kind: "fits", budgetMist: padded > 0n && padded < ceiling ? padded : ceiling };
}

type Landed = Readonly<{ status: "executed" | "failed"; error: SuiClientTypes.ExecutionError | null }>;

/** The outcome of effects for `digest`, or null when they are another transaction's. */
function landedOf(
  answer: SuiClientTypes.TransactionResult<{ effects: true }>,
  digest: string,
): Landed | null {
  const effects = (answer.Transaction ?? answer.FailedTransaction)?.effects;
  if (effects?.transactionDigest !== digest) return null;
  return effects.status.success ? { status: "executed", error: null } : { status: "failed", error: effects.status.error };
}

/**
 * Sends signed bytes once and waits for their effects within the bounds: how
 * they landed (with the failure's error), or null when still unknown. Never
 * resends.
 */
async function sendForEffects(
  client: ClientWithCoreApi,
  bytes: Uint8Array,
  signed: SignedTransaction,
  bounds: AttemptBounds,
): Promise<Landed | null> {
  try {
    const answer = await bounded(bounds.providerTimeoutMs, (signal) =>
      client.core.executeTransaction({ transaction: bytes, signatures: [signed.signature], include: { effects: true }, signal }),
    );
    const landed = landedOf(answer, signed.digest);
    if (landed) return landed;
  } catch {
    // A lost or late answer: the bytes may have landed. Wait for them below.
  }
  try {
    const answer = await bounded(bounds.confirmTimeoutMs + bounds.providerTimeoutMs, (signal) =>
      client.core.waitForTransaction({
        digest: signed.digest,
        include: { effects: true },
        timeout: bounds.confirmTimeoutMs,
        signal,
      }),
    );
    return landedOf(answer, signed.digest);
  } catch {
    // Still unknown; the gate and later passes settle it.
    return null;
  }
}

/**
 * Sends signed bytes once and waits for their effects within the bounds:
 * `executed`, `failed`, or null when still unknown. Never resends.
 */
export async function sendOnce(
  client: ClientWithCoreApi,
  bytes: Uint8Array,
  signed: SignedTransaction,
  bounds: AttemptBounds,
): Promise<"executed" | "failed" | null> {
  return (await sendForEffects(client, bytes, signed, bounds))?.status ?? null;
}

export async function attemptOnce<Reconciled>({
  client,
  bytes,
  bounds,
  sign,
  beforeSubmit,
  reconcile,
  estimatedGasBudgetMist,
  admit,
}: Readonly<{
  client: ClientWithCoreApi;
  bytes: Uint8Array;
  bounds: AttemptBounds;
  /** The job's guarded signature over exactly these bytes. */
  sign(bytes: Uint8Array): Promise<SignedTransaction>;
  /** Renews the leases and records the submission; false stops before anything is sent. */
  beforeSubmit(digest: string, signed: SignedTransaction): Promise<boolean>;
  /** A fresh read of what the chain now says. */
  reconcile(): Promise<Reconciled>;
  /** Recheck the prepared address-balance bytes and confirm the estimated budget. */
  estimatedGasBudgetMist?: bigint;
  /**
   * Optional: after a successful simulation, whether the transaction is worth
   * its simulated gas cost, given the events it would emit. False stops it
   * before anything is signed (`not-submitted`, `not-admitted`).
   */
  admit?(gasCostMist: bigint, events: readonly SuiClientTypes.Event[]): boolean;
}>): Promise<AttemptResult<Reconciled>> {
  const simulation = estimatedGasBudgetMist !== undefined
    ? await simulateExactGas(client, bytes, bounds, admit !== undefined)
    : await bounded(bounds.providerTimeoutMs, (signal) =>
      admit
        ? client.core.simulateTransaction({ transaction: bytes, include: { effects: true, events: true }, signal })
        : client.core.simulateTransaction({ transaction: bytes, signal }),
    );
  if (!simulation) return { outcome: "not-submitted", reason: "not-admitted", digest: null, reconciled: null };
  if (simulation.$kind === "FailedTransaction") {
    const status = simulation.FailedTransaction?.status;
    const simulationError = status && !status.success ? status.error : null;
    return { outcome: "simulation-failed", digest: null, reconciled: await reconcile(), simulationError };
  }
  const simulated = simulation.Transaction as {
    effects?: SuiClientTypes.TransactionEffects;
    events?: readonly SuiClientTypes.Event[];
  };
  const gasUsed = simulated.effects?.gasUsed;
  if (!withinGasBudget(gasUsed, estimatedGasBudgetMist)) {
    return { outcome: "not-submitted", reason: "not-admitted", digest: null, reconciled: null };
  }
  let gasCostMist: bigint | undefined;
  if (admit) {
    // No gas figure is no evidence the transaction is worth it.
    if (!gasUsed) return { outcome: "not-submitted", reason: "not-admitted", digest: null, reconciled: null };
    gasCostMist = simulatedGasCostMist(gasUsed);
    if (!admit(gasCostMist, simulated.events ?? [])) {
      return { outcome: "not-submitted", reason: "not-admitted", digest: null, reconciled: null, gasCostMist };
    }
  }
  const signed = await sign(bytes);
  if (!(await beforeSubmit(signed.digest, signed))) {
    return { outcome: "not-submitted", reason: "lease-lost", digest: signed.digest, reconciled: null, gasCostMist };
  }
  const landed = await sendForEffects(client, bytes, signed, bounds);
  return {
    outcome: landed?.status ?? "unknown",
    digest: signed.digest,
    reconciled: await reconcile(),
    gasCostMist,
    ...(landed?.status === "failed" ? { executionError: landed.error } : {}),
  };
}
