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

export function rememberSolanaSubmission(address: string, signature: string) {
  if (!writeBrowserStorage("local", keyFor(address), signature)) throw unavailable();
  window.dispatchEvent(new Event(CHANGE));
}

export type SolanaSubmissionState = "pending" | "confirmed" | "failed";

/** A missing signature can mean the RPC lost its history. Only a finalized result releases the wallet. */
export async function settleSolanaSubmission(
  connection: Pick<Connection, "getSignatureStatuses">,
  address: string,
): Promise<Readonly<{ signature: string; state: SolanaSubmissionState }> | null> {
  const signature = readSolanaSubmission(address);
  if (!signature) return null;
  const { value: [status] } = await connection.getSignatureStatuses([signature], { searchTransactionHistory: true });
  if (status?.confirmationStatus !== "finalized") return { signature, state: "pending" };

  const storage = browserStorage("local");
  if (!storage) throw unavailable();
  storage.removeItem(keyFor(address));
  window.dispatchEvent(new Event(CHANGE));
  return { signature, state: status.err ? "failed" : "confirmed" };
}
