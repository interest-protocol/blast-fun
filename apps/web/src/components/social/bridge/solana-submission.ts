import type { Connection } from "@solana/web3.js";

import { browserStorage, readBrowserStorage, writeBrowserStorage } from "#web/lib/browser-storage.ts";

const CHANGE = "blast:solana-bridge-submission";
const keyFor = (address: string) => `${CHANGE}:${address}`;

export const SOLANA_RETRY_UNAVAILABLE = "bridge_solana_retry_unavailable";

function unavailable() {
  return Object.assign(new Error("Cannot safely track the Solana transfer"), { code: SOLANA_RETRY_UNAVAILABLE });
}

export function readSolanaSubmission(address: string) {
  return readBrowserStorage("local", keyFor(address));
}

export function subscribeSolanaSubmission(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGE, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGE, onChange);
  };
}

export function withSolanaSubmissionLock<T>(address: string, work: () => Promise<T>): Promise<T> {
  // Closing the bridge or opening another tab must not start a second wallet prompt.
  if (!navigator.locks || !browserStorage("local")) throw unavailable();
  return navigator.locks.request(keyFor(address), { ifAvailable: true }, (lock) => {
    if (!lock) throw unavailable();
    return work();
  });
}

type SignedSubmission = Readonly<{ signature: string; lastValidBlockHeight: number; slot: number }>;

export function rememberSolanaSubmission(address: string, submission: SignedSubmission) {
  const { signature, lastValidBlockHeight, slot } = submission;
  if (!writeBrowserStorage("local", keyFor(address), `${signature}:${lastValidBlockHeight}:${slot}`)) throw unavailable();
  window.dispatchEvent(new Event(CHANGE));
}

export type SolanaSubmissionState = "pending" | "confirmed" | "failed";

/** The RPC must be past expiry and able to look back to signing before absence permits another send. */
export async function settleSolanaSubmission(
  connection: Pick<Connection, "getEpochInfo" | "getSignatureStatuses" | "getFirstAvailableBlock">,
  address: string,
): Promise<Readonly<{ signature: string; state: SolanaSubmissionState }> | null> {
  const saved = readSolanaSubmission(address);
  if (!saved) return null;
  const [signature, expiry, signedSlot] = saved.split(":");
  if (!signature || !expiry || !signedSlot || !Number.isSafeInteger(Number(expiry)) || !Number.isSafeInteger(Number(signedSlot))) throw unavailable();

  const finalized = await connection.getEpochInfo("finalized");
  const { context, value: [status] } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  let state: SolanaSubmissionState = "pending";
  if (status?.confirmationStatus === "finalized") {
    state = status.err ? "failed" : "confirmed";
  } else if (status === null && context.slot >= finalized.absoluteSlot && (finalized.blockHeight ?? 0) > Number(expiry)
    && await connection.getFirstAvailableBlock() <= Number(signedSlot)) {
    state = "failed";
  }
  if (state !== "pending") {
    const storage = browserStorage("local");
    if (!storage) throw unavailable();
    storage.removeItem(keyFor(address));
    window.dispatchEvent(new Event(CHANGE));
  }
  return { signature, state };
}
