import assert from "node:assert/strict";
import test from "node:test";

import { INTENT_EXPIRY_MS, INTENT_LATE_AFTER_MS } from "@blast/core/modules/social/contracts/intents.ts";
import { doTheSameDescriptor } from "@blast/core/modules/social/items/do-the-same.ts";
import { INTENT_EXPIRY_EVERY_MS, INTENT_STATEMENTS, attributes, intentOutcome } from "./resolve.ts";

/**
 * Resolving intents (T-026), decided from the facts alone: lateness, the
 * sender, and whether the source post credits the action. Every rule of the
 * ticket is one assertion here; the integration suite then proves the same
 * rules against real rows.
 */

const PRESALE = `0x${"ab".repeat(32)}`;
const OTHER_PRESALE = `0x${"cd".repeat(32)}`;
const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT = "22222222-2222-4222-8222-222222222222";
const EVENT_MS = 1_791_000_000_000;

const source = (overrides: Partial<Parameters<typeof attributes>[0]["source"] & object> = {}) => ({
  kind: "presale_commit",
  presale_id: PRESALE,
  actor: `0x${"11".repeat(32)}`,
  named_account_id: OTHER_ACCOUNT,
  actor_account_id: OTHER_ACCOUNT,
  lifecycle: "open",
  start_ms: String(EVENT_MS - 3_600_000),
  end_ms: String(EVENT_MS + 3_600_000),
  shown: true,
  ...overrides,
});

const ask = (overrides: Partial<Parameters<typeof attributes>[0]> = {}) => ({
  action: "commit" as const,
  activityPresale: PRESALE,
  source: source(),
  accountId: ACCOUNT,
  nowMs: EVENT_MS,
  ...overrides,
});

test("T-026-AC-2 (AC-097): a registration more than 30 s after its event is late", () => {
  assert.equal(intentOutcome({ registeredMs: EVENT_MS - 1_000, eventMs: EVENT_MS, senderOwned: true }), "applied");
  assert.equal(intentOutcome({ registeredMs: EVENT_MS + INTENT_LATE_AFTER_MS, eventMs: EVENT_MS, senderOwned: true }), "applied");
  assert.equal(intentOutcome({ registeredMs: EVENT_MS + INTENT_LATE_AFTER_MS + 1, eventMs: EVENT_MS, senderOwned: true }), "late");
  // Late outranks the sender check: a late claim is not even examined.
  assert.equal(intentOutcome({ registeredMs: EVENT_MS + 31_000, eventMs: EVENT_MS, senderOwned: false }), "late");
});

test("T-026-AC-1 (AC-098): a transaction the account's wallets did not send is rejected", () => {
  assert.equal(intentOutcome({ registeredMs: EVENT_MS, eventMs: EVENT_MS, senderOwned: false }), "rejected_sender");
  assert.equal(intentOutcome({ registeredMs: EVENT_MS, eventMs: EVENT_MS, senderOwned: true }), "applied");
  // The SQL carries the "linked no later than the event" half of the rule.
  assert.match(INTENT_STATEMENTS.sender, /FROM social_wallet_owners/);
  assert.match(INTENT_STATEMENTS.sender, /address = \$1 AND account_id = \$2/);
  assert.match(INTENT_STATEMENTS.sender, /extract\(epoch FROM linked_at\) \* 1000 <= \$3/);
});

test("T-026-AC-3 (AC-100): an attribution needs the post, its kind, its sale and another person's wallet", () => {
  assert.ok(attributes(ask()));
  // No source stored (it was invisible at registration): nothing to credit.
  assert.ok(!attributes(ask({ source: null })));
  // The post's sale must be the sale the transaction committed to.
  assert.ok(!attributes(ask({ activityPresale: OTHER_PRESALE })));
  assert.ok(!attributes(ask({ source: source({ presale_id: OTHER_PRESALE }) })));
  assert.ok(!attributes(ask({ activityPresale: null })));
  // One's own post is not a referral.
  assert.ok(!attributes(ask({ source: source({ actor_account_id: ACCOUNT }) })));
  // A post whose actor belongs to nobody still credits its author (there is none).
  assert.ok(attributes(ask({ source: source({ actor_account_id: null, named_account_id: null }) })));
});

test("T-026-AC-3 (AC-103): a lifecycle and a milestone post each credit with no author", () => {
  for (const kind of ["presale_opened", "presale_funded", "milestone_participants", "milestone_raise", "milestone_holders"]) {
    const post = source({ kind, actor: null, actor_account_id: null, named_account_id: null });
    assert.ok(attributes(ask({ source: post })), kind);
    assert.equal(post.named_account_id, null);
  }
});

test("T-026-AC-3: a commit resolved after the sale closed or funded still credits its post", () => {
  // The descriptor is no longer *enabled* then, and the ticket says that must
  // not matter: only its kind does.
  const ended = source({ lifecycle: "funded", end_ms: String(EVENT_MS - 1) });
  const descriptor = doTheSameDescriptor(ended.kind, { presale_id: PRESALE, lifecycle: "funded", start_ms: 0, end_ms: EVENT_MS - 1 }, EVENT_MS);
  assert.deepEqual(descriptor, { kind: "commit", enabled: false, label: "View presale", href: `/presale/${PRESALE}` });
  assert.ok(attributes(ask({ source: ended, nowMs: EVENT_MS + 86_400_000 })));
});

test("T-026-AC-4 (AC-139): a sell never credits a post, and a buy credits a Buy-too post", () => {
  assert.ok(!attributes(ask({ action: "sell", source: source({ kind: "trade_sell" }) })));
  assert.ok(!attributes(ask({ action: "sell" })));
  // A trade post's descriptor kind is `buy`, so a buy matches it and a commit does not.
  const tradePost = source({ kind: "trade_buy" });
  assert.ok(attributes(ask({ action: "buy", source: tradePost })));
  assert.ok(!attributes(ask({ action: "commit", source: tradePost })));
  // And a commit post never credits a buy.
  assert.ok(!attributes(ask({ action: "buy" })));
});

test("T-026: a kind with no descriptor credits nothing, and no list of kinds is hard-coded", () => {
  // An activity kind blast-infra may add later has no descriptor at all.
  assert.equal(doTheSameDescriptor("boost_mint", { presale_id: PRESALE, lifecycle: "open", start_ms: 0, end_ms: EVENT_MS + 1 }, EVENT_MS), null);
  assert.ok(!attributes(ask({ source: source({ kind: "boost_mint" }) })));
  // A sale `SHOWN_PRESALES` does not pass has no lifecycle row here, so the
  // descriptor is null and nothing is credited.
  assert.ok(!attributes(ask({ source: source({ lifecycle: null, start_ms: null, end_ms: null }) })));
  // The step names no kinds of its own: the descriptor decides.
  const stepSource = INTENT_STATEMENTS.sourceActivity + INTENT_STATEMENTS.batch;
  for (const kind of ["presale_opened", "milestone_raise", "presale_claim"]) assert.ok(!stepSource.includes(kind), kind);
});

test("T-026-AC-4 (AC-101): one digest gives at most one attribution and one status write", () => {
  assert.match(INTENT_STATEMENTS.attribution, /INSERT INTO social_attributions/);
  assert.match(INTENT_STATEMENTS.attribution, /ON CONFLICT \(tx_digest\) DO NOTHING/);
  // The status write is guarded on `pending`, so a second pass changes nothing
  // and `resolved_at` keeps the first pass's time.
  assert.match(INTENT_STATEMENTS.apply, /WHERE tx_digest = \$1 AND status = 'pending'/);
  assert.match(INTENT_STATEMENTS.apply, /resolved_at = now\(\)/);
});

test("T-026-AC-6 (AC-099): expiry deletes pending intents 24 h old, and sweeps at most every 10 minutes", () => {
  assert.match(INTENT_STATEMENTS.expire, /DELETE FROM social_intents WHERE status = 'pending'/);
  // The cutoff compares against the column, so the partial index range-scans it.
  assert.match(INTENT_STATEMENTS.expire, /registered_at < to_timestamp\(\$1::numeric \/ 1000\)/);
  assert.equal(INTENT_EXPIRY_MS, 86_400_000);
  assert.equal(INTENT_EXPIRY_EVERY_MS, 600_000);
});
