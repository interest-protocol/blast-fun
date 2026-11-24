import assert from "node:assert/strict";
import test from "node:test";
import type { PresaleState } from "@interest-protocol/blast-presale-sdk/state";
import { presaleAction } from "./jobs.ts";
import { permittedBluefinFee, requireBluefinFee } from "./bluefin-fee.ts";
import { gasPoolSettings } from "./gas-pool.ts";
const sale = (changes: Partial<PresaleState>) => ({ lifecycle: "Open", endMs: 1000n, hardCap: null, hardCapFromMs: null, totalCommitments: 100n, raiseTarget: 100n, liquidityDeadlineMs: 2000n, ...changes }) as PresaleState;
test("presale settles only at its end or a filled, active early-close hard cap", () => {
  assert.equal(presaleAction(sale({}), 999n), null);
  assert.equal(presaleAction(sale({}), 1000n), "settle");
  const early = sale({ hardCap: { closesWhenFilled: true, startsAfterMs: 100n }, hardCapFromMs: 100n });
  assert.equal(presaleAction(early, 99n), null); assert.equal(presaleAction(early, 100n), "settle");
  assert.equal(presaleAction({ ...early, totalCommitments: 99n }, 100n), null);
});
test("funded presale migrates before the exclusive deadline and cancels at it", () => {
  assert.equal(presaleAction(sale({ lifecycle: "Funded" }), 1999n), "migrate");
  assert.equal(presaleAction(sale({ lifecycle: "Funded" }), 2000n), "cancel");
  assert.equal(presaleAction(sale({ lifecycle: "Migrated" }), 3000n), null);
});
test("gas pool monitor requires the fresh production variables", () => {
  assert.throws(() => gasPoolSettings({ PRESALE_SPONSOR_ADDRESS: "0x1" }, true), /GAS_POOL_SPONSOR_ADDRESS/);
  assert.equal(gasPoolSettings({}, false), null);
  assert.throws(() => gasPoolSettings({ GAS_POOL_SPONSOR_ADDRESS: "0x1", GAS_POOL_LOW_BALANCE_MIST: "0" }, true));
});

test("fresh Bluefin creation fees must fit the operator cap and u64", () => {
  assert.equal(permittedBluefinFee(1n, 0n), false);
  assert.equal(permittedBluefinFee(123n, 123n), true);
  assert.equal(permittedBluefinFee(124n, 123n), false);
  assert.equal(permittedBluefinFee(18446744073709551615n, 18446744073709551615n), true);
  assert.equal(permittedBluefinFee(18446744073709551616n, 18446744073709551616n), false);
});

test("unreadable Bluefin fees retain a distinct refusal from an exceeded cap", () => {
  assert.throws(() => requireBluefinFee({ code: "rpc-unavailable" }, 10n), /bluefin-fee-unreadable/);
  assert.throws(() => requireBluefinFee(11n, 10n), /creation-fee-exceeds-cap/);
  assert.equal(requireBluefinFee(10n, 10n), 10n);
});
