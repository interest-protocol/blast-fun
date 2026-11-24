import assert from "node:assert/strict";
import test from "node:test";
import { TransactionError, type ClientWithCoreApi } from "@mysten/sui/client";

import { readDigestOutcome } from "./outcome.ts";
import { boundedProvider, ProviderUnavailable } from "./provider.ts";

const digest = "8x1Ct5qnZ6YXaf1Rnb3QLMvmQ7a9qy9C5hZPEN5U1Uxk";
const another = "5Ve1Qb4AzByU3bcpQnbcHJbDV9yHGDBwyrfBuvVLmtBk";

/** The SDK's answer for one transaction: `$kind` follows the status, as `parseGrpcTransactionResponse` sets it. */
function answer(kind: "Transaction" | "FailedTransaction", success: boolean, effectsDigest: string | null, transactionDigest = digest) {
  const effects = effectsDigest === null ? undefined : { transactionDigest: effectsDigest, status: success ? { success: true, error: null } : { success: false, error: { $kind: "Unknown", message: "failed", Unknown: null } } };
  return { $kind: kind, [kind]: { digest: transactionDigest, status: { success }, effects } };
}

function client(getTransaction: () => Promise<unknown>): ClientWithCoreApi {
  return { core: { getTransaction } } as unknown as ClientWithCoreApi;
}

// This fails if a digest outcome is read from effects of another digest, if the SDK's
// not-found answer is reported as unknown (or unknown as not-found), if an answer for
// another digest reads as no effects or loses which side named it (sites decide on each), or if a failed
// status reads as executed.
test("a digest reads as executed, failed, not found, without effects, for another digest, or unknown", async () => {
  const provider = boundedProvider(50);
  const cases: [label: string, reply: () => Promise<unknown>, kind: string][] = [
    ["executed", async () => answer("Transaction", true, digest), "executed"],
    ["a failed Transaction", async () => answer("Transaction", false, digest), "failed"],
    ["a FailedTransaction", async () => answer("FailedTransaction", false, digest), "failed"],
    ["effects for another digest", async () => answer("Transaction", true, another, another), "other-transaction"],
    ["effects naming another digest", async () => answer("Transaction", true, another), "other-effects"],
    ["a transaction naming another digest", async () => answer("Transaction", true, digest, another), "other-transaction"],
    ["no effects", async () => answer("FailedTransaction", false, null), "no-effects"],
    ["not found", async () => { throw new TransactionError("notFound", digest); }, "not-found"],
    ["a node error", async () => { throw new Error("connection reset"); }, "unknown"],
    ["a timeout", () => new Promise(() => {}), "unknown"],
  ];
  for (const [label, reply, kind] of cases) {
    const outcome = await readDigestOutcome(client(reply), provider, digest, { effects: true });
    assert.equal(outcome.kind, kind, label);
    if (outcome.kind === "unknown") assert.ok(outcome.error instanceof ProviderUnavailable, label);
  }
});
