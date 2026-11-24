import assert from "node:assert/strict";
import test from "node:test";
import { addCardHolders } from "./card-holders.ts";
const wallet = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
test("holder additions use the original mean, retain overlapping caps, and deduplicate", () => {
  const original = [{ wallet: wallet(1), walletCap: 1n }, { wallet: wallet(2), walletCap: 8n }];
  const result = addCardHolders(original, [wallet(1), wallet(3), wallet(3), wallet(4)]);
  assert.equal(result.cap, 4n);
  assert.equal(result.added, 2);
  assert.deepEqual(result.entries, [...original, { wallet: wallet(3), walletCap: 4n }, { wallet: wallet(4), walletCap: 4n }]);
});
test("large caps retain atom precision when averaged", () => {
  const result = addCardHolders([{ wallet: wallet(1), walletCap: 18446744073709551615n }, { wallet: wallet(2), walletCap: 18446744073709551613n }], [wallet(3)]);
  assert.equal(result.entries[2].walletCap, 18446744073709551614n);
});
test("the combined list cannot exceed the participant limit", () => {
  assert.throws(() => addCardHolders([{ wallet: wallet(1), walletCap: 1n }], Array.from({ length: 65537 }, (_, index) => wallet(index + 1))), { code: "allowlist_too_large" });
});
