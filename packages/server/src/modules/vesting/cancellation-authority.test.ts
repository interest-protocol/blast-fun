import assert from "node:assert/strict";
import test from "node:test";
import { VestingReadError } from "@blast/core/modules/vesting/errors.ts";
import { bcs } from "@mysten/sui/bcs";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import { cancellationCapForWallet } from "@blast/server/modules/vesting/cancellation-authority.ts";

const address = normalizeSuiAddress;
const packageId = address("0x123");
const sender = address("0x456");
const coinType = `${address("0x789")}::coin::COIN`;
const capId = address("0xabc");
const scheduleId = address("0xdef");
const schedule = {
  schedule_id: scheduleId,
  status: "active" as const,
  cancel_cap_id: capId,
  refund_recipient: sender,
  coin_type: coinType,
  terms: {
    kind: "linear" as const,
    start_ms: "0",
    cliff_ms: "0",
    period_ms: "1",
    periods: "10",
  },
};
const capBcs = bcs.struct("CancelCap", {
  id: bcs.Address,
  vesting_id: bcs.Address,
});
const cap = {
  objectId: capId,
  type: `${packageId}::blast_fun_linear_vesting::CancelCap<${coinType}>`,
  owner: { $kind: "AddressOwner" as const, AddressOwner: sender },
  content: capBcs.serialize({ id: capId, vesting_id: scheduleId }).toBytes(),
};

test("the owner of a matching generic cancellation key has authority", async () => {
  assert.equal(
    await cancellationCapForWallet(
      schedule,
      sender,
      packageId,
      async () => cap,
    ),
    capId,
  );
});

test("normalizes equivalent package and coin addresses without weakening type checks", async () => {
  const shortType =
    "0x123::blast_fun_linear_vesting::CancelCap<0x789::coin::COIN>";
  assert.equal(
    await cancellationCapForWallet(schedule, "0x456", packageId, async () => ({
      ...cap,
      type: shortType,
    })),
    capId,
  );
});

test("checkpoint schedules require the checkpoint module's generic key", async () => {
  const checkpoints = {
    ...schedule,
    terms: { kind: "checkpoints" as const, checkpoints: [] },
  };
  const checkpointCap = {
    ...cap,
    type: cap.type.replace("linear", "checkpoint"),
  };
  assert.equal(
    await cancellationCapForWallet(
      checkpoints,
      sender,
      packageId,
      async () => checkpointCap,
    ),
    capId,
  );
});

for (const [name, type] of [
  ["nongeneric key", `${packageId}::blast_fun_linear_vesting::CancelCap`],
  ["wrong coin", cap.type.replace("::coin::COIN", "::coin::OTHER")],
  ["wrong module", cap.type.replace("linear", "checkpoint")],
  ["wrong package", cap.type.replace(packageId, address("0x999"))],
]) {
  test(`rejects a ${name}`, async () => {
    assert.equal(
      await cancellationCapForWallet(schedule, sender, packageId, async () => ({
        ...cap,
        type: type!,
      })),
      null,
    );
  });
}

test("beneficiary or refund recipient identity does not grant key ownership", async () => {
  const otherOwner = {
    ...cap,
    owner: { $kind: "AddressOwner" as const, AddressOwner: address("0x999") },
  };
  assert.equal(
    await cancellationCapForWallet(
      schedule,
      sender,
      packageId,
      async () => otherOwner,
    ),
    null,
  );
});

test("rejects a matching key whose contents identify another schedule", async () => {
  const wrongSchedule = {
    ...cap,
    content: capBcs
      .serialize({ id: capId, vesting_id: address("0x999") })
      .toBytes(),
  };
  assert.equal(
    await cancellationCapForWallet(
      schedule,
      sender,
      packageId,
      async () => wrongSchedule,
    ),
    null,
  );
});

test("rejects a key whose embedded ID differs from the indexed key", async () => {
  const wrongId = {
    ...cap,
    content: capBcs
      .serialize({ id: address("0x999"), vesting_id: scheduleId })
      .toBytes(),
  };
  assert.equal(
    await cancellationCapForWallet(
      schedule,
      sender,
      packageId,
      async () => wrongId,
    ),
    null,
  );
});

test("missing authority data is unavailable, not a denial", async () => {
  await assert.rejects(
    cancellationCapForWallet(
      { ...schedule, cancel_cap_id: null },
      sender,
      packageId,
      async () => cap,
    ),
    (error: unknown) => error instanceof VestingReadError && error.reason === "authority_unavailable",
  );
});

test("RPC failures and malformed cap data remain failed checks", async () => {
  await assert.rejects(
    cancellationCapForWallet(schedule, sender, packageId, async () => {
      throw new Error("RPC unavailable");
    }),
    /RPC unavailable/,
  );
  await assert.rejects(
    cancellationCapForWallet(schedule, sender, packageId, async () => ({
      ...cap,
      content: new Uint8Array(),
    })),
  );
});

test("deleted keys, irrevocable schedules and ended schedules cannot cancel", async () => {
  assert.equal(
    await cancellationCapForWallet(
      schedule,
      sender,
      packageId,
      async () => null,
    ),
    null,
  );
  const unexpectedRead = async () => {
    throw new Error("Should not load a key");
  };
  assert.equal(
    await cancellationCapForWallet(
      { ...schedule, refund_recipient: null, cancel_cap_id: null },
      sender,
      packageId,
      unexpectedRead,
    ),
    null,
  );
  assert.equal(
    await cancellationCapForWallet(
      { ...schedule, status: "canceled" },
      sender,
      packageId,
      unexpectedRead,
    ),
    null,
  );
  assert.equal(
    await cancellationCapForWallet(
      { ...schedule, status: "closed" },
      sender,
      packageId,
      unexpectedRead,
    ),
    null,
  );
});
