import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStructTag } from "@mysten/sui/utils";
import { createVestingTransaction } from "@blast/server/modules/vesting/create-transaction.ts";
import type { CreateVesting } from "@blast/core/modules/vesting/model.ts";

const wallet = `0x${"a".repeat(64)}`;
const intent: CreateVesting = {
  action: "create",
  coinType: "0x2::sui::SUI",
  total: "123",
  beneficiary: wallet,
  refundRecipient: null,
  cancelCapRecipient: null,
  schedule: {
    kind: "linear",
    start_ms: "2000000",
    cliff_ms: "0",
    period_ms: "1000",
    periods: "2",
  },
};
for (const kind of ["linear", "checkpoints"] as const) {
  for (const cancelable of [false, true]) {
    test(`sponsored ${kind} ${cancelable ? "cancelable" : "irrevocable"} creation spends sender SUI, never sponsor gas`, () => {
      const input: CreateVesting = {
        ...intent,
        ...(cancelable
          ? { refundRecipient: wallet, cancelCapRecipient: wallet }
          : {}),
        schedule:
          kind === "linear"
            ? intent.schedule
            : {
                kind: "checkpoints",
                checkpoints: [
                  { timestamp_ms: "2000000", cumulative_amount: "123" },
                ],
              },
      };
      const tx = createVestingTransaction(input, 1_000_000n);
      const commands = tx.getData().commands;
      const funding = commands.find(
        (command) => command.$Intent?.name === "CoinWithBalance",
      )!;
      assert.equal(
        funding.$Intent!.data.type,
        normalizeStructTag("0x2::sui::SUI"),
      );
      assert.equal(funding.$Intent!.data.balance, 123n);
      assert.equal(
        commands.filter((command) => command.TransferObjects).length,
        cancelable ? 1 : 0,
      );
      assert.ok(
        commands.some(
          (command) =>
            command.MoveCall?.function ===
            (cancelable ? "new_cancelable" : "new_irrevocable"),
        ),
      );
      assert.equal(commands.at(-1)?.MoveCall?.function, "share");
    });
  }
}
test("invalid release terms are rejected", () => {
  assert.throws(() =>
    createVestingTransaction(
      {
        ...intent,
        schedule: {
          kind: "checkpoints",
          checkpoints: [{ timestamp_ms: "2000000", cumulative_amount: "1" }],
        },
      },
      1_000_000n,
    ),
  );
});
