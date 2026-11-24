import assert from "node:assert/strict";
import test from "node:test";
import { toBase64 } from "@mysten/sui/utils";

import { signExactly, type TransactionSigner } from "#web/components/social/sponsored-transaction.ts";
import { sponsoredWalletSigner, WalletChangedBytes } from "./sui-signing.ts";

const ADDRESS = `0x${"ca1".padEnd(64, "0")}`;
const SPONSOR_BYTES = new Uint8Array([1, 2, 3, 4]);

function wallet(answer: (bytes: Uint8Array) => Uint8Array): Extract<TransactionSigner, { fee: "wallet" }> {
  return { fee: "wallet", address: ADDRESS, signTransaction: async (bytes) => ({ bytes: toBase64(answer(bytes)), signature: "c2lnbmF0dXJl" }) };
}

test("a wallet session on Blast's gas signs exactly the sponsor's bytes, and refuses any it changed", async () => {
  const signer = sponsoredWalletSigner(wallet((bytes) => bytes));
  assert.equal(signer.fee, "sponsored");
  assert.deepEqual(await signExactly(signer, SPONSOR_BYTES), { status: "signed", signature: "c2lnbmF0dXJl" });

  // A wallet that rebuilt the transaction (its own gas, say): nothing signed may go out.
  const changed = await signExactly(sponsoredWalletSigner(wallet(() => new Uint8Array([9, 9]))), SPONSOR_BYTES);
  assert.equal(changed.status, "unsigned");
  assert.equal(changed.status === "unsigned" && changed.reason, "mismatch");
  assert.ok(changed.status === "unsigned" && changed.error instanceof WalletChangedBytes);
});
