import assert from "node:assert/strict";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";

import { decodeLinearVesting, vestingClaimedEvents } from "./linear-vesting.ts";
import { VESTING_PACKAGE } from "@blast/core/modules/vesting/model.ts";

/** P-13: a `Vesting<T>` read from a node's object, the whole struct as the chain stores it. */
const Vesting = bcs.struct("Vesting", {
  id: bcs.Address,
  balance: bcs.u64(),
  beneficiary: bcs.Address,
  cancel_refund_recipient: bcs.option(bcs.Address),
  start_ms: bcs.u64(),
  cliff_ms: bcs.u64(),
  period_ms: bcs.u64(),
  periods: bcs.u64(),
  released: bcs.u64(),
});
const ID = `0x${"70".repeat(32)}`;
const BENEFICIARY = `0x${"a1".repeat(32)}`;
const COIN = `0x${"5a".repeat(32)}::meme::MEME`;
const object = {
  objectId: ID,
  type: `${VESTING_PACKAGE}::blast_fun_linear_vesting::Vesting<${COIN}>`,
  owner: { $kind: "Shared", Shared: { initialSharedVersion: "12" } },
  content: Vesting.serialize({
    id: ID, balance: 1_000n, beneficiary: BENEFICIARY, cancel_refund_recipient: null, start_ms: 1n, cliff_ms: 0n, period_ms: 86_400_000n, periods: 30n, released: 0n,
  }).toBytes(),
};

test("P-13: a shared Vesting<T> of the pinned package reads as its coin and beneficiary; anything else is null", () => {
  assert.deepEqual(decodeLinearVesting(object), { objectId: ID, initialSharedVersion: "12", coinType: COIN, beneficiary: BENEFICIARY });
  assert.equal(decodeLinearVesting({ ...object, type: object.type.replace(VESTING_PACKAGE, `0x${"7".repeat(64)}`) }), null, "another package");
  assert.equal(decodeLinearVesting({ ...object, type: object.type.replace("::Vesting<", "::CancelCap<") }), null, "another struct");
  assert.equal(decodeLinearVesting({ ...object, owner: { $kind: "AddressOwner" } }), null, "not shared");
  assert.equal(decodeLinearVesting({ ...object, content: new Uint8Array(3) }), null, "short contents");
});

test("a pinned VestingClaimed event binds its schedule, beneficiary and normalized coin", () => {
  const Event = bcs.struct("VestingClaimed", {
    vesting_id: bcs.Address,
    coin_type: bcs.struct("TypeName", { name: bcs.string() }),
    beneficiary: bcs.Address,
    amount: bcs.u64(),
    released_total: bcs.u64(),
  });
  const event = {
    eventType: `${VESTING_PACKAGE}::blast_fun_linear_vesting::VestingClaimed`,
    bcs: Event.serialize({ vesting_id: ID, coin_type: { name: COIN.slice(2) }, beneficiary: BENEFICIARY, amount: 5n, released_total: 5n }).toBytes(),
  };
  assert.deepEqual(vestingClaimedEvents([event]), [{ vestingId: ID, beneficiary: BENEFICIARY, coinType: COIN }]);
  assert.deepEqual(vestingClaimedEvents([{ ...event, eventType: event.eventType.replace(VESTING_PACKAGE, "0x1") }]), []);
  assert.deepEqual(vestingClaimedEvents([{ ...event, bcs: new Uint8Array(3) }]), []);
});

test("the vesting package is the one the presale package links on mainnet", () => {
  assert.equal(VESTING_PACKAGE, "0x85fdb7e3d28162b99e0df758069a3d23cff874c400b2160fc0d4618aefd3ec5c");
});
