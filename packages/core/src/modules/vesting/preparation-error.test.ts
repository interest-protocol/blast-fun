import assert from "node:assert/strict";
import test from "node:test";

import { preparationMessage, vestingPreparationReason } from "./preparation-error.ts";

test("only confirmed gas failures produce gas advice; unknown RPC content stays private", () => {
  assert.equal(
    vestingPreparationReason(
      new Error(
        "Unable to perform gas selection due to insufficient SUI balance (in address balance or coins) for account 0xabc to satisfy required budget 3551871.",
      ),
    ),
    "insufficient_sui_gas",
  );
  assert.match(preparationMessage(["insufficient_sui_gas"]), /Add SUI/);
  const unknown = vestingPreparationReason(new Error("RPC credential=private"));
  assert.equal(unknown, "preparation_failed");
  assert.doesNotMatch(preparationMessage([unknown]), /credential|gas|SUI/);
  assert.match(preparationMessage([unknown]), /couldn’t prepare this transaction/);
});

test("a short coin balance and an unavailable sponsor each get their own advice", () => {
  const coins = vestingPreparationReason(
    new Error("Not enough coins of type 0x2::coin::TOKEN to satisfy requested balance"),
  );
  assert.equal(coins, "insufficient_coin_balance");
  // @mysten/sui 2.x `tx.coin()` (CoinWithBalance) wording.
  const sdk = vestingPreparationReason(
    new Error("Insufficient balance of 0x2::coin::TOKEN for owner 0xabc. Required: 10, Available: 4"),
  );
  assert.equal(sdk, "insufficient_coin_balance");
  assert.match(preparationMessage([coins]), /coin balance no longer covers/);
  const sponsor = preparationMessage(["insufficient_sui_gas", "sponsorship_unavailable"]);
  assert.match(sponsor, /can’t sponsor network gas/);
  assert.doesNotMatch(sponsor, /Add SUI/);
});
