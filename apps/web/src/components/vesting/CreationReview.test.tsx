import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PUBLIC_PREFERRED_COINS } from "#web/components/social/coins/coin-model.ts";
import { CreationReview, type CreationReviewState } from "./CreationReview";
import { reviewVestingAmount } from "./creation-display";

const A = `0x${"a".repeat(64)}`;
const coin = PUBLIC_PREFERRED_COINS.find((item) => item.symbol === "SUI")!;
const review: CreationReviewState = {
  coin, sender: A,
  intent: { action: "create", coinType: coin.coinType, total: "124968397112711982", beneficiary: A, refundRecipient: A, cancelCapRecipient: `0x${"b".repeat(64)}`,
    schedule: { kind: "linear", start_ms: String(Date.parse("2026-10-17T22:30:00Z")), period_ms: "2592000000", periods: "12", cliff_ms: "0" } },
  attempt: { request_id: "fixture", action: "create", state: "submitted", digest: "fixture", transaction_bytes: "not-signable", schedule_id: null, gas_budget: "7388640", expires_at_ms: 9999999999999, sponsor_reservation_id: "fixture" },
};
function render(value = review) {
  return renderToStaticMarkup(<CreationReview review={value} setReview={() => {}} wallet={{ busy: false, phase: "idle" }} confirm={async () => {}} error={null} />);
}

test("review amount groups whole digits and preserves every token digit and atomic fallback", () => {
  assert.equal(reviewVestingAmount("124968397112711982", 9), "124,968,397.112711982");
  assert.equal(reviewVestingAmount("18446744073709551615", 0), "18,446,744,073,709,551,615");
  assert.equal(reviewVestingAmount("1", 18), "0.000000000000000001");
  assert.equal(reviewVestingAmount("1234567", null), "1,234,567 atoms");
});

test("review prioritizes schedule, retains separate roles and shows UTC directly across DST", () => {
  const html = render();
  assert.match(html, /124,968,397.112711982/);
  assert.ok(html.indexOf("Release schedule") < html.indexOf('id="review-cancellation-title"'));
  assert.doesNotMatch(html, /Europe\/Lisbon|23:30/);
  assert.match(html, /2026-10-17 22:30 UTC/);
  assert.match(html, /2026-11-16 22:30 UTC/);
  for (const label of ["Recipient wallet", "Refund wallet", "Who can cancel", "Cancellation authority transfers with the CancelCap", "Paid by Blast"]) assert.ok(html.includes(label));
  assert.doesNotMatch(html, /Show exact UTC timestamps/);
  assert.doesNotMatch(html, /aria-expanded="true"/);
});

test("cliff and single effective releases retain the model's actual dates and release count", () => {
  const schedule = review.intent.schedule;
  assert.equal(schedule.kind, "linear");
  const html = render({ ...review, intent: { ...review.intent, schedule: { ...schedule, kind: "linear", cliff_ms: "31104000000" } } });
  assert.match(html, /Cliff ends/);
  assert.match(html, /1 release/);
  assert.match(html, /Release date/);
  assert.doesNotMatch(html, /Final release|First release/);
});

test("custom review shows incremental exact amounts and irrevocable roles accurately", () => {
  const html = render({ ...review, intent: { ...review.intent, refundRecipient: null, cancelCapRecipient: null, schedule: { kind: "checkpoints", checkpoints: [
    { timestamp_ms: "1792276200000", cumulative_amount: "1" },
    { timestamp_ms: "1794868200000", cumulative_amount: "124968397112711982" },
  ] } } });
  assert.match(html, /2 custom releases/);
  assert.match(html, /0.000000001/);
  assert.match(html, /124,968,397.112711981/);
  assert.match(html, /Nobody can cancel/);
  assert.doesNotMatch(html, /Refund wallet|Who can cancel/);
});

test("continuous linear review preserves first-claimable, cliff and fully-vested instants", () => {
  const start = BigInt(Date.parse("2026-10-17T22:30:00Z"));
  const duration = 31_104_000_000n;
  const continuous = { ...review, intent: { ...review.intent, total: "1", schedule: {
    kind: "linear" as const, start_ms: String(start), period_ms: "1", periods: String(duration), cliff_ms: "2592000000",
  } } };
  const html = render(continuous);
  assert.match(html, /First claimable/);
  assert.match(html, /Fully vested/);
  assert.match(html, /Linear · continuous/);
  assert.match(html, /Cliff ends/);
  assert.match(html, /2026-11-16 22:30 UTC/);
  assert.match(html, /2027-10-12 22:30 UTC/);
  assert.doesNotMatch(html, /First release|Final release|releases · every|1 release/);
});

test("historical stepped review counts effective releases after cliff catch-up and zero-atom steps", () => {
  assert.match(render({ ...review, intent: { ...review.intent, total: "2" } }), /2 releases · every 30 days/);
  const schedule = review.intent.schedule;
  assert.equal(schedule.kind, "linear");
  assert.match(render({ ...review, intent: { ...review.intent, schedule: { ...schedule, kind: "linear", cliff_ms: "7776000000" } } }), /10 releases · every 30 days/);
});

test("pending creation retains the original transaction and offers status checks", () => {
  const html = renderToStaticMarkup(<CreationReview review={review} pending setReview={() => {}} wallet={{ busy: false, phase: "idle" }} confirm={async () => {}} error={null} />);
  assert.match(html, /Check transaction status/);
  assert.match(html, /Submitted. Awaiting confirmation/);
  assert.match(html, /https:\/\/suiscan.xyz\/mainnet\/tx\/fixture/);
  assert.doesNotMatch(html, /Create vesting in wallet/);
});
