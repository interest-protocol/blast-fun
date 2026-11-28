import { mayanRpc } from "./bridge-config.ts";

export type SolanaExpiry = Readonly<{ slot: number; blockhash: string; lastValidBlockHeight: number }>;

// A Solana blockhash is valid through age 150. The following finalized block closes the window.
const BLOCKHASH_VALID_AGE = 150;
const BLOCKS_TO_CHECK = BLOCKHASH_VALID_AGE + 1;
// Mayan's public RPC rejects larger requests. Keep one request in flight.
const BLOCKS_PER_REQUEST = 5;
const FINALIZED = { commitment: "finalized" } as const;
const SIGNATURES = { ...FINALIZED, transactionDetails: "signatures", rewards: false, maxSupportedTransactionVersion: 0 } as const;

type RpcCall = Readonly<{ method: string; params: readonly unknown[] }>;
type FinalizedBlock = Readonly<{
  blockHeight: number;
  blockhash: string;
  parentSlot: number;
  previousBlockhash: string;
  signatures: readonly string[];
}>;

/** A missing signature index entry is inconclusive. Prove absence from every finalized block in the validity window. */
export async function verifySolanaExpiry(expiry: SolanaExpiry, signature: string, signal: AbortSignal, request = fetch): Promise<boolean> {
  const [slots] = await rpcBatch(request, [{ method: "getBlocksWithLimit", params: [expiry.slot + 1, BLOCKS_TO_CHECK, FINALIZED] }], signal);
  if (!Array.isArray(slots) || slots.length !== BLOCKS_TO_CHECK || !slots.every(Number.isSafeInteger)) return false;

  let previous = { slot: expiry.slot, blockhash: expiry.blockhash, blockHeight: expiry.lastValidBlockHeight - BLOCKHASH_VALID_AGE };
  for (let offset = 0; offset < slots.length; offset += BLOCKS_PER_REQUEST) {
    const batch = slots.slice(offset, offset + BLOCKS_PER_REQUEST) as number[];
    // react-doctor-disable-next-line react-doctor/async-await-in-loop -- Keep one bounded batch in flight and stop when the validity window ends.
    const blocks = await rpcBatch(request, batch.map((slot) => ({ method: "getBlock", params: [slot, SIGNATURES] })), signal);
    for (const [index, slot] of batch.entries()) {
      const block = readFinalizedBlock(blocks[index]);
      if (!block || slot <= previous.slot || block.parentSlot !== previous.slot || block.previousBlockhash !== previous.blockhash || block.blockHeight !== previous.blockHeight + 1) return false;
      if (block.signatures.includes(signature)) return false;
      if (block.blockHeight > expiry.lastValidBlockHeight) return true;
      previous = { slot, blockhash: block.blockhash, blockHeight: block.blockHeight };
    }
  }
  return false;
}

function readFinalizedBlock(value: unknown): FinalizedBlock | null {
  if (!value || typeof value !== "object") return null;
  const block = value as Partial<FinalizedBlock>;
  if (typeof block.blockhash !== "string" || typeof block.previousBlockhash !== "string"
    || !Number.isSafeInteger(block.blockHeight) || !Number.isSafeInteger(block.parentSlot)
    || !Array.isArray(block.signatures) || !block.signatures.every((signature) => typeof signature === "string")) return null;
  return block as FinalizedBlock;
}

async function rpcBatch(request: typeof fetch, calls: readonly RpcCall[], signal: AbortSignal): Promise<unknown[]> {
  const response = await request(mayanRpc("solana"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(calls.map((call, id) => ({ jsonrpc: "2.0", id, ...call }))),
    signal,
  });
  if (!response.ok) throw new Error(`Solana RPC ${response.status}`);
  const rows: unknown = await response.json();
  if (!Array.isArray(rows) || rows.length !== calls.length) throw new Error("Incomplete Solana RPC batch");
  const replies = new Map<number, unknown>();
  for (const row of rows) {
    if (!row || row.jsonrpc !== "2.0" || !Number.isSafeInteger(row.id) || row.id < 0 || row.id >= calls.length
      || replies.has(row.id) || row.error || !("result" in row)) throw new Error("Invalid Solana RPC response");
    replies.set(row.id, row.result);
  }
  return calls.map((_call, id) => replies.get(id));
}
