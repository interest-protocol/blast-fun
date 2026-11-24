import assert from "node:assert/strict";
import test from "node:test";

import { addProtocolAllocation } from "@interest-protocol/blast-sdk/launchpad";
import { deriveLaunchEconomics } from "@interest-protocol/blast-sdk/launchpad";
import { memeAtomicSupply } from "@interest-protocol/blast-sdk/launchpad/template";

import { CREATE_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import {
  blankLaunchDraft,
  launchArguments,
  launchIssues,
  launchSplit,
  LAUNCH_DEAD_ADDRESS,
  launchRecipientLimit,
  LaunchDraftShapeError,
  parseStoredLaunchDraft,
  parseLaunchDraft,
  toAtomic,
  type LaunchDraft,
  type LaunchRules,
} from "./model.ts";

/** The mainnet LaunchConfig, RuntimeConfig and LpFeePolicy as read on 2026-10-29. */
const RULES: LaunchRules = {
  meme_decimals: [6, 9],
  quote_fee_bps: 100,
  meme_fee_bps: 50,
  protocol_meme_bps: 250,
  protocol_quote_bps: 150,
  creation_fee: "0",
  protocol_fee_share_bps: 6_500,
  pool_fee_meme_bps: 5_000,
  pool_fee_quote_bps: 1_500,
  quotes: [CREATE_SUI_QUOTE_TYPE],
  cetus_tiers: { [CREATE_SUI_QUOTE_TYPE]: [[200, 10_000], [60, 2_500]] },
  bluefin_options: { status: "ready", min_tick: -443_636, max_tick: 443_636 },
};
const LOGO = "https://assets.blast.fun/create-logos/pip.webp";

function finished(change: Partial<LaunchDraft> = {}): LaunchDraft {
  return { ...blankLaunchDraft(CREATE_SUI_QUOTE_TYPE), name: "Pip", symbol: "PIP", ...change };
}

/** Curve-terminal and DEX-opening valuations, as the SDK derives them from the plan the draft builds. */
function valuations(draft: LaunchDraft) {
  const args = launchArguments(draft, RULES);
  const economics = deriveLaunchEconomics({
    atomicSupply: memeAtomicSupply(draft.decimals),
    allocationPlan: addProtocolAllocation(args.allocationPlan, { memeBps: BigInt(RULES.protocol_meme_bps), quoteBps: BigInt(RULES.protocol_quote_bps) }),
    virtualQuote: args.virtualQuote,
    graduationTarget: args.graduationTarget,
  });
  return { curve: Number(economics.curveTerminalValuation), dex: Number(economics.dexOpeningValuation) };
}

test("the default draft is complete once named, and its pool opens at the curve's last price", () => {
  const draft = finished();
  assert.deepEqual(launchIssues(draft, { rules: RULES, logoUrl: LOGO }), []);
  const { curve, dex } = valuations(draft);
  assert.ok(Math.abs(dex - curve) / curve < 0.001, `pool opens ${(((dex - curve) / curve) * 100).toFixed(3)}% from the curve`);
});

test("curve and pool shares stay fixed while recipients consume the 0xdead remainder", () => {
  const draft = finished({ curve_bps: 5_000, pool_bps: 2_000 });
  const split = launchSplit(draft, RULES);
  assert.equal(split.pool_bps, 2_000);
  assert.equal(split.unallocated_bps, 2_750);
  assert.equal(split.sold_bps + split.unsold_bps, 5_000);
  assert.deepEqual(launchIssues(draft, { rules: RULES, logoUrl: LOGO }), []);
  const recipient = { label: "Treasury", address: `0x${"5e".repeat(32)}`, bps: 1_000 };
  const allocated = { ...draft, recipients: [recipient] };
  const after = launchSplit(allocated, RULES);
  assert.equal(after.curve_bps, split.curve_bps);
  assert.equal(after.pool_bps, split.pool_bps);
  assert.equal(after.unallocated_bps, 1_750);
  assert.deepEqual(launchIssues(allocated, { rules: RULES, logoUrl: LOGO }), []);
  assert.deepEqual(launchArguments(allocated, RULES).allocationPlan.recipients, [
    { recipient: { destination: recipient.address, vestingTerms: null }, memeBps: 1_000n, quoteBps: 0n },
    { recipient: { destination: LAUNCH_DEAD_ADDRESS, vestingTerms: null }, memeBps: 1_750n, quoteBps: 0n },
  ]);
  assert.deepEqual(valuations(allocated), valuations(draft));
  assert.notEqual(valuations(draft).curve, valuations(draft).dex);
  assert.equal(launchSplit({ ...draft, recipients: [] }, RULES).unallocated_bps, 2_750);
});

test("allocations cannot exceed supply or consume the curve, pool or Blast share", () => {
  const draft = finished({ curve_bps: 5_000, pool_bps: 2_000 });
  const recipient = { label: "Treasury", address: `0x${"5e".repeat(32)}`, bps: 2_751 };
  assert.match(launchIssues({ ...draft, recipients: [recipient] }, { rules: RULES, logoUrl: LOGO }).find(i => i.path === "recipients")!.message, /0.01%/);
  for (const pool_bps of [0, 4_751]) {
    assert.ok(launchIssues({ ...draft, pool_bps }, { rules: RULES, logoUrl: LOGO }).length > 0);
  }
});

test("legacy stored drafts preserve their old pool allocation while incoming drafts stay strict", () => {
  const { pool_bps: omitted, ...legacy } = finished({ curve_bps: 5_000 });
  assert.equal(typeof omitted, "number");
  assert.throws(() => parseLaunchDraft(legacy), LaunchDraftShapeError);
  assert.equal(parseStoredLaunchDraft(legacy, RULES).pool_bps, 4_750);
  assert.deepEqual(parseStoredLaunchDraft(finished(), RULES), finished());
  assert.equal(parseStoredLaunchDraft({ ...legacy, curve_bps: 10_000 }, RULES).pool_bps, 0);
  assert.throws(() => parseStoredLaunchDraft({ ...legacy, extra: true }, RULES), LaunchDraftShapeError);
});

test("0xdead uses the existing allocation plan for both fixed and burn-only supply", () => {
  const draft = finished({ curve_bps: 5_000, pool_bps: 2_000 });
  for (const burnable of [false, true]) {
    const selected = { ...draft, burnable };
    assert.deepEqual(launchIssues(selected, { rules: RULES, logoUrl: LOGO }), []);
    const args = launchArguments(selected, RULES);
    assert.deepEqual(args.allocationPlan.recipients, [
      { recipient: { destination: LAUNCH_DEAD_ADDRESS, vestingTerms: null }, memeBps: 2_750n, quoteBps: 0n },
    ]);
    assert.ok(valuations(selected).dex > 0);
  }
  assert.deepEqual(launchArguments(finished(), RULES).allocationPlan.recipients, []);
});

test("the automatic allocation reserves one slot while fully allocated legacy plans retain sixteen", () => {
  const recipients = Array.from({ length: 16 }, (_, index) => ({ label: `Recipient ${index}`, address: `0x${(index + 1).toString(16).padStart(64, "0")}`, bps: 100 }));
  const draft = finished({ curve_bps: 5_000, pool_bps: 2_000, recipients: recipients.slice(0, 15) });
  assert.equal(launchRecipientLimit(draft, RULES), 15);
  assert.deepEqual(launchIssues(draft, { rules: RULES, logoUrl: LOGO }), []);
  assert.equal(launchArguments(draft, RULES).allocationPlan.recipients.length, 16);
  assert.match(launchIssues({ ...draft, recipients }, { rules: RULES, logoUrl: LOGO }).find(i => i.path === "recipients")!.message, /At most 15/);
  const full = { ...draft, recipients: recipients.map((row, index) => ({ ...row, bps: index === 15 ? 1_250 : 100 })) };
  assert.equal(launchRecipientLimit(full, RULES), 16);
  assert.deepEqual(launchIssues(full, { rules: RULES, logoUrl: LOGO }), []);
  assert.equal(launchArguments(full, RULES).allocationPlan.recipients.length, 16);
});

test("recipients are paid in tokens only, and 0x0 is refused as the contract does", () => {
  const zero = { label: "Burn", address: `0x${"0".repeat(64)}`, bps: 1_000 };
  const draft = finished({ curve_bps: 7_000, recipients: [zero] });
  assert.ok(launchIssues(draft, { rules: RULES, logoUrl: LOGO }).some((issue) => issue.path === "recipients.0.address"));
  const args = launchArguments(finished({ curve_bps: 7_000, recipients: [{ ...zero, address: `0x${"ab".repeat(32)}` }] }), RULES);
  assert.equal(args.allocationPlan.recipients[0]!.quoteBps, 0n);
  assert.equal(args.allocationPlan.lpQuoteBps, 9_850n);
});

test("venues follow the quote coin", () => {
  const usdc = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
  const rules = { ...RULES, quotes: [...RULES.quotes, usdc] };
  const issues = launchIssues(finished({ quote_type: usdc }), { rules, logoUrl: LOGO });
  assert.deepEqual(issues.map((issue) => issue.path), ["venue"]);
  assert.match(issues[0]!.message, /Cetus does not support USDC/);
  assert.deepEqual(launchIssues(finished({ quote_type: usdc, venue: "bluefin" }), { rules, logoUrl: LOGO }), []);
});

test("pool fee shares must add up to 100%, with distinct fee recipients", () => {
  const row = { label: "Ops", address: `0x${"cd".repeat(32)}`, bps: 1_000 };
  const draft = finished({ creator_fee_bps: 4_000, holders_fee_bps: 4_000, burn_fee_bps: 1_000, fee_recipients: [row] });
  assert.deepEqual(launchIssues(draft, { rules: RULES, logoUrl: LOGO }), []);
  const duplicate = finished({ creator_fee_bps: 4_000, holders_fee_bps: 4_000, fee_recipients: [row, row] });
  assert.ok(launchIssues(duplicate, { rules: RULES, logoUrl: LOGO }).some((issue) => issue.path === "fee_recipients.1.address"));
  assert.ok(launchIssues(finished({ burn_fee_bps: 100 }), { rules: RULES, logoUrl: LOGO }).some((issue) => issue.path === "fee_total"));
});

test("a draft needs its logo, name and ticker", () => {
  const issues = launchIssues(blankLaunchDraft(CREATE_SUI_QUOTE_TYPE), { rules: RULES, logoUrl: null });
  assert.deepEqual(issues.map((issue) => issue.path), ["logo", "name", "symbol"]);
  assert.deepEqual(launchIssues(finished({ symbol: "1PIP" }), { rules: RULES, logoUrl: LOGO }).map((issue) => issue.path), ["symbol"]);
});

test("parsing is strict: exact keys, bounded values", () => {
  const draft = finished();
  assert.deepEqual(parseLaunchDraft(JSON.parse(JSON.stringify(draft))), draft);
  assert.throws(() => parseLaunchDraft({ ...draft, extra: 1 }), LaunchDraftShapeError);
  assert.throws(() => parseLaunchDraft({ ...draft, virtual_quote: 1.00001 }), (error: unknown) => error instanceof LaunchDraftShapeError && error.field === "virtual_quote");
  assert.throws(() => parseLaunchDraft({ ...draft, sell_burn_bps: 5_001 }), LaunchDraftShapeError);
  assert.throws(() => parseLaunchDraft({ ...draft, symbol: "pip" }), LaunchDraftShapeError);
});

test("amounts convert to atomic units exactly", () => {
  assert.equal(toAtomic(8_000, 9), 8_000_000_000_000n);
  assert.equal(toAtomic(0.1234, 6), 123_400n);
  assert.equal(toAtomic(12.5, 9), 12_500_000_000n);
  assert.equal(toAtomic(0, 9), 0n);
});

test("a different pool opening price is allowed without forcing recipients", () => {
  const draft = finished({ curve_bps: 10, pool_bps: 7, recipients: [{ label: "Team", address: `0x${"1".repeat(64)}`, bps: 9733 }] });
  assert.deepEqual(launchIssues(draft, { rules: RULES, logoUrl: LOGO }), []);
});

test("a first buy that rounds to no token units is a field issue", () => {
  const draft = finished({ curve_bps: 1, decimals: 6, virtual_quote: 1e9, graduation_target: 1e9, recipients: [{ label: "Team", address: `0x${"1".repeat(64)}`, bps: 9748 }], first_buy: .0001 });
  assert.ok(launchIssues(draft, { rules: RULES, logoUrl: LOGO }).length > 0);
});
