import assert from "node:assert/strict";
import test from "node:test";
import { originalAllowlistCsv, savedAllowlistCsv } from "./saved-allowlist";
test("saved downloads keep exact decimal caps and rebuilding starts with original rows only", () => {
  const list = { quote: "USDC", source: { file_name: "crew.csv", uploaded_count: 1, include_blast_holders: true, added_count: 1, holder_cap: "1" as const }, entries: [{ wallet: "0x1", cap: "18446744073709551615" as const }, { wallet: "0x2", cap: "1" as const }] };
  assert.equal(savedAllowlistCsv(list, 6), "address,amount\n0x1,18446744073709.551615\n0x2,0.000001\n");
  assert.equal(originalAllowlistCsv(list), "wallet,cap\n0x1,18446744073709551615\n");
  assert.throws(() => originalAllowlistCsv({ ...list, source: null }));
});
