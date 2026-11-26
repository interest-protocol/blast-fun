import assert from "node:assert/strict";
import test from "node:test";
import { bcs } from "@mysten/sui/bcs";
import { createVestingTransaction } from "@blast/server/modules/vesting/create-transaction.ts";
import { createIntent } from "./creation-model.ts";

const wallet = `0x${"a".repeat(64)}`;

for (const cancelable of [false, true]) {
  test(`continuous creation encodes millisecond linear terms (${cancelable ? "cancelable" : "irrevocable"})`, () => {
    const input = createIntent(
      {
        coinType: "0x2::sui::SUI",
        decimals: 0,
        total: "101",
        beneficiary: wallet,
        kind: "linear",
        start: "2030-01-01T00:00:00Z",
        end: "2030-01-11T00:00:00Z",
        cliffDays: "2",
        periodDays: "30",
        periods: "12",
        releases: [],
        cancelable,
        refund: wallet,
        capRecipient: wallet,
      },
      1_000_000n,
    );
    const data = createVestingTransaction(input, 1_000_000n).getData();
    const call = data.commands.find(
      (command) =>
        command.MoveCall?.function ===
        (cancelable ? "new_cancelable" : "new_irrevocable"),
    )!.MoveCall!;
    assert.equal(call.module, "blast_fun_linear_vesting");
    const values = call.arguments.flatMap((arg) => {
      if (arg.$kind !== "Input") return [];
      const value = data.inputs[arg.Input];
      return value?.Pure ? [value.Pure.bytes] : [];
    });
    for (const value of [1893456000000n, 172800000n, 1n, 864000000n]) {
      assert.ok(
        values.includes(bcs.u64().serialize(value).toBase64()),
        `missing linear argument ${value}`,
      );
    }
    assert.equal(
      data.commands.at(-1)?.MoveCall?.module,
      "blast_fun_linear_vesting",
    );
  });
}
