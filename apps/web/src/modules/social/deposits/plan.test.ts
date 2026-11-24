import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSuiAddress } from "@mysten/sui/utils";

import type { BridgeTransfer } from "@blast/core/modules/presale/bridge/contracts.ts";
import { cctpMessageFixture } from "../../../../../../packages/core/test/fixtures/modules/presale/bridge/relayer-fixtures.ts";
import type { BridgeQuoteResponse } from "@blast/core/modules/presale/contracts/web-api.ts";
import { depositPlan, depositTransferView, depositVerdict, mintedAmount, standardMaxFee } from "@blast/server/modules/social/deposits/plan.ts";

/**
 * OA-25: the deposit's pure rules — which route a burn takes and what it
 * signs (`depositPlan`), and what a registered burn's state means for the
 * attempt in the transaction log (`depositVerdict`, `mintedAmount`,
 * `depositTransferView`). Messages are the relayer's fixture CCTP bytes
 * (V2 fixtures carry `maxFee` 1000 and `feeExecuted` 500).
 */

const WALLET = `0x${"3f".repeat(32)}`;
const RELAYER = `0x${"7a".repeat(32)}`;
const ZERO = `0x${"0".repeat(64)}`;
const HOOK = "0x636374702d666f72776172640000000000000000000000000000000000000000";
const PARKED = new Date("9999-12-31T00:00:00Z");

function quote(overrides: Partial<BridgeQuoteResponse> = {}): BridgeQuoteResponse {
  return {
    fast: { eta_seconds: 18, fee_bps: "1.3", max_fee: "81250", allowance_ok: true },
    standard: { eta_seconds: 1_150, fee_bps: "0" },
    destination_domain: 8,
    forwarding: "blast",
    destination_caller: RELAYER,
    hook_data: null,
    ...overrides,
  };
}

function transfer(overrides: Partial<BridgeTransfer> = {}): BridgeTransfer {
  const sent = new Date("2026-10-06T12:00:00Z");
  return {
    id: `bt_${"a".repeat(32)}`,
    source: "base",
    sourceDomain: 6,
    txHash: `0x${"ab".repeat(32)}`,
    suiAddress: WALLET,
    amount: "500000000",
    presaleId: ZERO,
    privyDid: null,
    status: "sent",
    sentAt: sent,
    attestedAt: null,
    mintedAt: null,
    failedAt: null,
    error: null,
    nonce: null,
    message: null,
    attestation: null,
    suiDigest: null,
    nextPollAt: sent,
    pollCount: 0,
    circleNotFoundAt: null,
    observedFrom: null,
    ...overrides,
  };
}

const EXPECT = { source: "base", blastWallet: WALLET, amount: 500_000_000n } as const;
const v2 = (options: Parameters<typeof cctpMessageFixture>[0] = {}) =>
  cctpMessageFixture({ version: 1, source: "base", recipient: WALLET, amount: 500_000_000n, ...options });
const DIGEST = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";

test("standardMaxFee is ceil(amount × fee_bps / 10,000) in integer atoms", () => {
  assert.equal(standardMaxFee(500_000_000n, "0"), 0n);
  assert.equal(standardMaxFee(500_000_000n, "0.5"), 25_000n);
  // 1 atom × 1.3 bps rounds up to one atom, never down to zero.
  assert.equal(standardMaxFee(1n, "1.3"), 1n);
  assert.equal(standardMaxFee(10_000n, "1"), 1n);
  assert.equal(standardMaxFee(10_001n, "1"), 2n);
  assert.equal(standardMaxFee(123_456_789n, "2.25"), 27_778n);
});

test("depositPlan: Fast when Circle lists it, the allowance covers it and its fee leaves something to mint", () => {
  const fast = depositPlan(quote(), 500_000_000n, "0x3F" + "3f".repeat(31));
  assert.deepEqual(fast, {
    speed: "fast",
    eta_seconds: 18,
    fee_bps: "1.3",
    max_fee: "81250",
    min_finality_threshold: 1000,
    destination_domain: 8,
    mint_recipient: WALLET,
    destination_caller: RELAYER,
    hook_data: null,
  });
  // Circle forwarding: the zero caller and the forward hook pass through.
  const circle = depositPlan(quote({ forwarding: "circle", destination_caller: ZERO, hook_data: HOOK }), 500_000_000n, WALLET);
  assert.deepEqual([circle?.destination_caller, circle?.hook_data], [ZERO, HOOK]);
});

test("depositPlan: Standard without a Fast route, past the Fast allowance, or when Fast's fee would take it all; null when even Standard's would", () => {
  const standard = (overrides: Partial<BridgeQuoteResponse>, amount = 500_000_000n) => depositPlan(quote(overrides), amount, WALLET);
  for (const plan of [
    standard({ fast: null }),
    standard({ fast: { eta_seconds: 18, fee_bps: "1.3", max_fee: "81250", allowance_ok: false } }),
    standard({ fast: { eta_seconds: 18, fee_bps: "1.3", max_fee: "500000000", allowance_ok: true } }),
  ]) {
    assert.deepEqual(
      [plan?.speed, plan?.eta_seconds, plan?.fee_bps, plan?.max_fee, plan?.min_finality_threshold],
      ["standard", 1_150, "0", "0", 2000],
    );
  }
  // A Standard fee rate is applied to the amount, rounded up.
  assert.equal(standard({ fast: null, standard: { eta_seconds: 35, fee_bps: "0.5" } })?.max_fee, "25000");
  // The token messenger refuses maxFee ≥ amount.
  assert.equal(standard({ fast: null, standard: { eta_seconds: 35, fee_bps: "10000" } }, 3n), null);
  assert.equal(standard({ fast: { eta_seconds: 18, fee_bps: "1.3", max_fee: "1", allowance_ok: true }, standard: { eta_seconds: 35, fee_bps: "10000" } }, 1n), null);
});

test("depositVerdict: open while in flight; confirmed only once the attested burn minted exactly this to the Blast wallet", () => {
  const mintedAt = new Date("2026-10-06T12:00:30Z");
  assert.deepEqual(depositVerdict(transfer(), EXPECT), { state: "open" });
  assert.deepEqual(depositVerdict(transfer({ status: "attested", message: v2(), attestedAt: mintedAt }), EXPECT), { state: "open" });
  // A Circle delay or a not-yet-parked timeout is still in flight.
  assert.deepEqual(depositVerdict(transfer({ error: "Soft finality delay" }), EXPECT), { state: "open" });
  assert.deepEqual(depositVerdict(transfer({ status: "failed", error: "attestation_timeout", failedAt: mintedAt, nextPollAt: mintedAt }), EXPECT), { state: "open" });
  assert.deepEqual(
    depositVerdict(transfer({ status: "minted", message: v2(), attestedAt: mintedAt, mintedAt, suiDigest: DIGEST }), EXPECT),
    { state: "confirmed", digest: DIGEST, settledAtMs: mintedAt.getTime() },
  );
  // V1 messages settle the same way.
  const v1 = cctpMessageFixture({ version: 0, source: "base", recipient: WALLET, amount: 500_000_000n });
  assert.equal(depositVerdict(transfer({ status: "minted", message: v1, attestedAt: mintedAt, mintedAt, suiDigest: DIGEST }), EXPECT).state, "confirmed");
});

test("depositVerdict: mismatch for a refused burn or one attested for anything else; expired once the relayer parked a burn Circle never saw", () => {
  const at = new Date("2026-10-06T12:05:00Z");
  const settled = (overrides: Partial<BridgeTransfer>) => depositVerdict(transfer({ status: "minted", attestedAt: at, mintedAt: at, suiDigest: DIGEST, ...overrides }), EXPECT);
  for (const message of [
    v2({ recipient: `0x${"50".repeat(32)}` }),
    v2({ amount: 499_999_999n }),
    v2({ source: "arbitrum" }),
    v2({ destinationDomain: 7 }),
    "0x00",
  ]) {
    assert.deepEqual(settled({ message }), { state: "failed", failureCode: "mismatch", settledAtMs: at.getTime() });
  }
  assert.deepEqual(
    depositVerdict(transfer({ status: "failed", error: "invalid_burn", failedAt: at }), EXPECT),
    { state: "failed", failureCode: "mismatch", settledAtMs: at.getTime() },
  );
  assert.deepEqual(
    depositVerdict(transfer({ status: "failed", error: "attestation_timeout", failedAt: at, nextPollAt: PARKED }), EXPECT),
    { state: "failed", failureCode: "expired", settledAtMs: null },
  );
});

test("mintedAmount: the amount less V2's feeExecuted (body offset 164); V1 mints all of it; anything else is null", () => {
  assert.equal(mintedAmount(v2()), 499_999_500n);
  assert.equal(mintedAmount(cctpMessageFixture({ version: 0, amount: 7_000_000n })), 7_000_000n);
  // feeExecuted (500) above the amount is not a burn this mints.
  assert.equal(mintedAmount(v2({ amount: 100n })), null);
  assert.equal(mintedAmount("0x00"), null);
  assert.equal(mintedAmount("not hex"), null);
  // A message whose body is not a burn.
  assert.equal(mintedAmount(v2().slice(0, 2 + 148 * 2)), null);
});

test("depositTransferView: fixed labels only, never Circle's delay text; the minted amount once attested", () => {
  assert.deepEqual(depositTransferView(transfer()), { id: `bt_${"a".repeat(32)}`, status: "sent", error: null, minted_amount: null });
  assert.equal(depositTransferView(transfer({ error: "Soft finality: waiting for 65 blocks" })).error, "delayed");
  assert.equal(depositTransferView(transfer({ status: "failed", error: "invalid_burn" })).error, "invalid_burn");
  assert.equal(depositTransferView(transfer({ status: "failed", error: "attestation_timeout" })).error, "attestation_timeout");
  assert.equal(depositTransferView(transfer({ status: "attested", message: v2() })).minted_amount, "499999500");
  assert.equal(normalizeSuiAddress(WALLET), WALLET);
});
