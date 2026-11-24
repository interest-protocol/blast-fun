import assert from "node:assert/strict";
import test from "node:test";

import { ACTIVITY_CURSOR_PATTERN, type SocialActivityPage } from "@blast/core/modules/social/contracts/activity.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { activityEvent, activityPageSql, decodeActivityCursor } from "@blast/server/modules/social/activity/read.ts";
import { parseActivityQuery } from "@blast/server/modules/social/activity/route.ts";
import { hex } from "../../../../../core/test/kit.ts";

/** R3-57's read without a database: its statement, its cursor and its mapping. The database suite is `activity.integration.test.ts`. */

const validator = createSocialValidator();

function row(extra: Record<string, unknown> = {}) {
  return {
    activity_id: "70001:0:0:0", kind: "presale_commit", timestamp_ms: "1800000000000", checkpoint: "70001", tx_slot: "0", event_slot: "0", part: "0",
    actor: hex("aa01"), presale_id: hex("a4"), sale_name: "Tidal", sale_symbol: "TIDE", sale_decimals: 9, quote_symbol: "USDC", quote_decimals: 6,
    usd_value: "86.000000000000000000", quote_amount: "86000000", coin_amount: null, quote_refund: null,
    callsign: null, display_name: null, avatar_url: null, x_handle: null, verified: null,
    ...extra,
  } as Parameters<typeof activityEvent>[0];
}

test("the page statement keeps a stable keyset order and uses its cursor without OFFSET", () => {
  for (const withCursor of [false, true]) {
    const sql = activityPageSql(withCursor);
    assert.doesNotMatch(sql.replace(/OFFSET 0\) AS n/, ""), /\bOFFSET\b/, "the only OFFSET is the naming lateral's planner fence");
    const inner = sql.slice(sql.indexOf("FROM ("), sql.indexOf("LIMIT $5::int"));
    assert.match(inner, /ORDER BY a\.timestamp_ms DESC, a\.checkpoint DESC, a\.tx_slot DESC, a\.event_slot DESC, a\.part DESC/);
    assert.equal(/\(a\.timestamp_ms, a\.checkpoint, a\.tx_slot, a\.event_slot, a\.part\) < \(\$6::bigint/.test(inner), withCursor);
  }
});

test("`before` is the cursor exactly, once; anything else is invalid_parameter", () => {
  assert.equal(parseActivityQuery(new URL("https://blast.fun/api/social/activity")), null);
  assert.deepEqual(parseActivityQuery(new URL("https://blast.fun/api/social/activity?before=1800000000000:70001:3:2:1&limit=9")), {
    timestampMs: "1800000000000", checkpoint: "70001", txSlot: "3", eventSlot: "2", part: "1",
  });
  for (const bad of ["", "1:2:3:4", "1:2:3:4:5:6", "a:2:3:4:5", "-1:2:3:4:5", "01:2:3:4:5", "1.5:2:3:4:5", `${"9".repeat(17)}:1:1:1:1`, "1:2:3:4:99999999999"]) {
    assert.throws(() => decodeActivityCursor(bad), (error: { code?: string }) => error.code === "invalid_parameter", bad);
    assert.equal(ACTIVITY_CURSOR_PATTERN.test(bad), false, bad);
  }
  assert.throws(() => parseActivityQuery(new URL("https://blast.fun/a?before=1:1:1:1:1&before=1:1:1:1:1")), (error: { code?: string }) => error.code === "invalid_parameter");
});

test("each kind carries its own figures, in whole units, and a row with no shown sale is not described", () => {
  const commit = activityEvent(row())!;
  assert.deepEqual([commit.usd, commit.quote, commit.tokens, commit.refund], ["86.00", "86", null, null]);
  const claim = activityEvent(row({ kind: "presale_claim", usd_value: null, quote_amount: "0", coin_amount: "45734000000000", quote_refund: "0" }))!;
  assert.deepEqual([claim.usd, claim.quote, claim.tokens, claim.refund], [null, null, "45734", null]);
  const refund = activityEvent(row({ kind: "presale_claim", usd_value: "250", quote_amount: "0", coin_amount: "0", quote_refund: "250000000" }))!;
  assert.deepEqual([refund.usd, refund.tokens, refund.refund], ["250.00", null, "250"]);
  const buy = activityEvent(row({ kind: "trade_buy", usd_value: "757", quote_amount: "757000000", coin_amount: "1200000000000" }))!;
  assert.deepEqual([buy.usd, buy.quote, buy.tokens], ["757.00", "757", "1200"]);
  assert.equal(activityEvent(row({ presale_id: null })), null);
  assert.equal(activityEvent(row({ sale_symbol: null })), null);
  assert.equal(activityEvent(row({ kind: "launch_buy" })), null);
  // The naming rule's answer: an account, else the wallet only.
  assert.deepEqual(activityEvent(row())!.actor, { type: "address", address: hex("aa01"), short: "0x0000…aa01" });
  assert.deepEqual(activityEvent(row({ callsign: "anapark", display_name: "Ana Park", verified: true }))!.actor, {
    type: "account", callsign: "anapark", display_name: "Ana Park", avatar_url: null, x_handle: null, verified: true, path: "/@anapark",
  });
});

test("the published schema takes a page of every kind and refuses what the contract does not carry", () => {
  const events = [
    activityEvent(row())!,
    activityEvent(row({ activity_id: "70002:0:0:0", kind: "presale_claim", usd_value: null, quote_amount: "0", coin_amount: "45734000000000", quote_refund: "0" }))!,
    activityEvent(row({ activity_id: "70003:0:0:0", kind: "trade_sell", coin_amount: "300000000000" }))!,
  ];
  const body: SocialActivityPage = { events, next_cursor: "1800000000000:70003:0:0:0", as_of: { checkpoint: 70003, timestamp_ms: 1800000000000, lag_ms: 0 } };
  assert.deepEqual(validator.validate("activity-page", body).errors, []);
  assert.equal(validator.validate("activity-page", { ...body, next_cursor: "1:2:3:4" }).valid, false);
  assert.equal(validator.validate("activity-page", { ...body, events: [{ ...events[0], kind: "launch_buy" }] }).valid, false);
  assert.equal(validator.validate("activity-page", { ...body, events: [{ ...events[0], presale_id: null }] }).valid, false);
  assert.equal(validator.validate("activity-page", { ...body, viewer: {} }).valid, false);
  assert.equal(validator.validate("activity-page", { ...body, events: Array.from({ length: 31 }, () => events[0]) }).valid, false);
});
