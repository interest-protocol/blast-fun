import type { Connection } from "@solana/web3.js";

import { browserStorage, readBrowserStorage, writeBrowserStorage } from "#web/lib/browser-storage.ts";

import type { SolanaExpiry } from "./solana-expiry.ts";

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

export function solanaSubmissionSignature(saved: string | null): string | null {
  return saved?.split(":", 1)[0] || null;
}

export function rememberSolanaSubmission(address: string, signature: string, expiry: SolanaExpiry) {
  const { slot, blockhash, lastValidBlockHeight } = expiry;
  if (!writeBrowserStorage("local", keyFor(address), `${signature}:${slot}:${blockhash}:${lastValidBlockHeight}`)) throw unavailable();
  window.dispatchEvent(new Event(CHANGE));
}

export type SolanaSubmissionState = "pending" | "confirmed" | "failed";

/** A missing signature can mean the RPC lost its history. Clear only after a finalized result or a complete expiry proof. */
export async function settleSolanaSubmission(
  connection: Pick<Connection, "getSignatureStatuses">,
  address: string,
  verifyExpiry: (expiry: SolanaExpiry, signature: string) => Promise<boolean>,
): Promise<Readonly<{ signature: string; state: SolanaSubmissionState }> | null> {
  const saved = readSolanaSubmission(address);
  const signature = solanaSubmissionSignature(saved);
  if (!signature) return null;
  const { value: [status] } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  let state: SolanaSubmissionState;
  if (status?.confirmationStatus === "finalized") {
    state = status.err ? "failed" : "confirmed";
  } else {
    const [, slot, blockhash, height] = saved!.split(":");
    const expiry = Number(slot) > 0 && blockhash && Number(height) > 0
      && Number.isSafeInteger(Number(slot)) && Number.isSafeInteger(Number(height))
      ? { slot: Number(slot), blockhash, lastValidBlockHeight: Number(height) } : null;
    if (!expiry || !await verifyExpiry(expiry, signature)) return { signature, state: "pending" };
    state = "failed";
  }

  const storage = browserStorage("local");
  if (!storage) throw unavailable();
  storage.removeItem(keyFor(address));
  window.dispatchEvent(new Event(CHANGE));
  return { signature, state };
}
