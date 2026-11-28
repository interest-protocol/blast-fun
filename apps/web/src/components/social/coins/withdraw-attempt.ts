import { isValidTransactionDigest } from "@mysten/sui/utils";

type Receipt = Readonly<{ requestId: string; digest: string }>;
const prefix = "blast:pending-withdrawal:";
const receipts = new Map<string, Receipt>();
const unsaved = new Set<string>();
let broadcasts = 0;

export async function duringWithdrawalBroadcast<T>(send: () => Promise<T>): Promise<T> {
  broadcasts += 1;
  try {
    return await send();
  } finally {
    broadcasts -= 1;
  }
}

export function withdrawalBlocksAccountSwitch(): boolean {
  return broadcasts > 0 || unsaved.size > 0;
}

/** Keep the original request and digest for the same withdrawal after an account reload. */
export function saveWithdrawReceipt(key: string, receipt: Receipt): void {
  receipts.set(key, receipt);
  try {
    window.sessionStorage.setItem(prefix + key, `${receipt.requestId}:${receipt.digest}`);
    unsaved.delete(key);
  } catch {
    unsaved.add(key);
  }
}

export function readWithdrawReceipt(key: string): Receipt | null {
  const inMemory = receipts.get(key);
  if (inMemory) return inMemory;
  try {
    const [requestId, digest] = window.sessionStorage.getItem(prefix + key)?.split(":") ?? [];
    if (requestId && digest && isValidTransactionDigest(digest)) return { requestId, digest };
  } catch {
    // Blocked browser storage still allows the current document to settle a withdrawal.
  }
  return null;
}

export function clearWithdrawReceipt(key: string): void {
  receipts.delete(key);
  unsaved.delete(key);
  try {
    window.sessionStorage.removeItem(prefix + key);
  } catch {
    // There may be no stored receipt.
  }
}
