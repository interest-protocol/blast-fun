import assert from "node:assert/strict";
import test from "node:test";

import { tradeBalanceMessage } from "./trade-balance";

// Fails if the required amount passes through a float (u64's largest loses its last digits) or the gas case reads the wrong coin.
test("a short balance names the exact amount the wallet needs, in the coin it lacks", () => {
  assert.equal(
    tradeBalanceMessage({ reason: "balance", required_atoms: "18446744073709551615" } as never, "ORBIT", 6),
    "Not enough ORBIT. Your wallet needs at least 18,446,744,073,709.551615 ORBIT. Check the amount.",
  );
  assert.equal(
    tradeBalanceMessage({ reason: "gas", required_atoms: "2570000" } as never, "ORBIT", 6),
    "Not enough native SUI for the network fee. Your wallet needs at least 0.00257 SUI. Add SUI and try again.",
  );
});
