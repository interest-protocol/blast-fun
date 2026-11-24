import assert from "node:assert/strict";
import test from "node:test";

import { socialNotificationPageSchema, socialNotificationWirePageSchema } from "@blast/core/modules/social/contracts/notifications.ts";
import { utc } from "@blast/core/lib/format.ts";
import { renderNotification, timeLeftWords, untilWords, type NotificationRow } from "@blast/server/modules/social/notifications/copy.ts";
import { decodeNotificationCursor, encodeNotificationCursor, parseNotificationPage } from "@blast/server/modules/social/notifications/store.ts";

const NOW = Date.UTC(2026, 9, 3, 12);
const HOUR = 3_600_000;
const DAY = 86_400_000;
const P = `0x${"e1d1a".padStart(64, "0")}`;

function row(fields: Partial<NotificationRow>): NotificationRow {
  return {
    id: "1", kind: "fill", presale_id: P, occurred_at_ms: NOW - 14 * 60_000, data: {}, read: false,
    sale_name: "Meridian", sale_symbol: "MRDN", sale_icon_url: "https://cdn/m.png", quote_decimals: 6, lifecycle: "open",
    start_ms: String(NOW - 2 * DAY), end_ms: String(NOW + 6 * HOUR - 14 * 60_000 + 12 * 60_000), raise_target: "250000000000",
    total_commitments: "184221000000", venue: "bluefin",
    callsign: null, display_name: null, avatar_url: null, x_handle: null, why: null,
    ...fields,
  };
}

test("UI-13 copy: the design's six sample notifications, verbatim", () => {
  const fill = renderNotification(row({ data: { m: "participants", v: 1000, pct: 73, c: "100000000" } }), NOW);
  assert.deepEqual([fill.title, fill.sub], ["Meridian passed 1,000 backers", "You have $100 in · 6 hours remained when sent"]);
  assert.equal(fill.href, `/presale/${P}`);
  assert.deepEqual(fill.presale, { presale_id: P, coin_type: undefined, name: "Meridian", symbol: "MRDN", icon_url: "https://cdn/m.png" });

  const follow = renderNotification(row({
    kind: "follow", data: { usd: "2000" }, callsign: "mirachen", display_name: "Mira Chen", x_handle: "mirachen",
    why: "Been using their app for months…",
  }), NOW);
  assert.deepEqual([follow.title, follow.sub], ["Mira blasted $2,000 into Meridian", "“Been using their app for months…”"]);
  assert.deepEqual(follow.actor, { callsign: "mirachen", display_name: "Mira Chen", avatar_url: null, verified: true });

  const claim = renderNotification(row({ kind: "claim", sale_name: "Kestrel", sale_symbol: "KSTL", data: { refund: false, c: "300000000" } }), NOW);
  assert.deepEqual([claim.title, claim.sub], ["Claims are open for Kestrel", "Your KSTL are ready"]);

  const funded = renderNotification(row({ kind: "funded", sale_name: "Cobalt", raise_target: "400000000000", total_commitments: "500000000000", lifecycle: "funded" }), NOW);
  assert.deepEqual([funded.title, funded.sub], ["Cobalt is funded", "1.25× oversubscribed · trading opens on Bluefin"]);

  const soon = renderNotification(row({ kind: "soon", sale_name: "Sable", lifecycle: "pending", start_ms: String(Date.UTC(2026, 9, 14, 18)), data: { at: "opens" } }), NOW);
  assert.deepEqual([soon.title, soon.sub], ["Sable opens Oct 14, 18:00 UTC", "You asked to be notified"]);

  const start = NOW + 91 * DAY;
  const unlock = renderNotification(row({ kind: "unlock", sale_name: "Kestrel", data: { s: start, e: start + 360 * DAY } }), NOW);
  assert.deepEqual([unlock.title, unlock.sub], ["Kestrel team unlock in 3 months", "Linear over 12 mo from launch"]);
});

test("R3-05 / visual check 2026-10-05 (NOT-1): a followed account's commit reads \"blasted … into\" with the activity amount rule", () => {
  // The gate's ALERTS say "Mira blasted $2,000 into Meridian".
  for (const [usd, amount] of [["2000", "$2,000"], ["86", "$86"], ["12.5", "$12.50"], ["1240", "$1,240"]] as const) {
    const notification = renderNotification(row({ kind: "follow", data: { usd }, callsign: "mirachen", display_name: "Mira Chen" }), NOW);
    assert.equal(notification.title, `Mira blasted ${amount} into Meridian`);
  }
  assert.doesNotMatch(renderNotification(row({ kind: "follow", data: {}, callsign: "mirachen", display_name: "Mira Chen" }), NOW).title, /committed/);
});

test("UI-13 copy: the lines the design does not draw", () => {
  const follower = renderNotification(row({ data: { m: "participants", v: 50, pct: 12 } }), NOW);
  assert.equal(follower.sub, "12% filled · 6 hours remained when sent");
  assert.equal(renderNotification(row({ data: { m: "filled", v: 80 } }), NOW).title, "Meridian is 80% filled");
  const refund = renderNotification(row({ kind: "claim", lifecycle: "cancelled", data: { refund: true, c: "250000000" } }), NOW);
  assert.deepEqual([refund.title, refund.sub], ["Refunds are open for Meridian", "Your $250 refund is ready"]);
  const exact = renderNotification(row({ kind: "funded", raise_target: "100", total_commitments: "100", venue: "cetus" }), NOW);
  assert.equal(exact.sub, "Trading opens on Cetus");
  const noWhy = renderNotification(row({ kind: "follow", data: {}, callsign: "anon_1", display_name: null }), NOW);
  assert.equal(noWhy.title, "@anon_1 blasted into Meridian");
  assert.equal(noWhy.sub, "73% filled · 5h 58m left");
  // Open on chain with its scheduled start ahead: still upcoming (#774).
  const scheduled = renderNotification(row({ kind: "follow", data: {}, callsign: "anon_1", start_ms: String(Date.UTC(2026, 9, 14, 18)) }), Date.UTC(2026, 9, 14, 17));
  assert.equal(scheduled.sub, "Opens Oct 14, 18:00 UTC");
  const last = renderNotification(row({ kind: "soon", data: { at: "closes", c: "250000000" } }), NOW);
  assert.deepEqual([last.title, last.sub], ["Last hour for Meridian", "You have $250 in · 73% filled"]);
  const unlocking = renderNotification(row({ kind: "unlock", data: { s: NOW - DAY, e: NOW + 20 * DAY } }), NOW);
  assert.deepEqual([unlocking.title, unlocking.sub], ["Meridian team tokens are unlocking", "Linear over 3 wk from launch"]);
  const gone = renderNotification(row({ sale_name: null, data: { m: "participants", v: 10 } }), NOW);
  assert.equal(gone.presale, null);
  assert.equal(gone.title, "A presale passed 10 backers");
});

test("call_up copy: the Notifications board's line, the threshold crossed and the price now while fresh", () => {
  const call = (fields: Partial<NotificationRow>) => renderNotification(row({
    kind: "call_up", sale_name: "Walrus", sale_symbol: "WAL", lifecycle: "migrated", data: { t: 100, e: "0.31", p: "0.62" }, ...fields,
  }), NOW);
  const live = call({ price_usd: "0.4127", price_as_of_ms: String(NOW - 30_000) });
  assert.deepEqual([live.title, live.sub], ["WAL is up 100% since your call", "Called at $0.3100 · now $0.4127"]);
  assert.equal(live.actor, null);
  assert.equal(live.href, `/presale/${P}`);
  // A price older than two minutes is not "now"; the line keeps the entry alone.
  assert.equal(call({ price_usd: "0.4127", price_as_of_ms: String(NOW - 5 * 60_000) }).sub, "Called at $0.3100");
  assert.equal(call({ data: { t: 1000, e: "0.31", p: "3.5" } }).title, "WAL is up 1,000% since your call");
  assert.equal(call({ sale_symbol: null }).title, "Walrus is up 100% since your call");
});

test("UI-13 copy: time words", () => {
  assert.equal(utc(Date.UTC(2026, 0, 2, 0, 5)), "Jan 2, 00:05 UTC");
  assert.equal(timeLeftWords(6 * HOUR + 12 * 60_000), "6 hours");
  assert.equal(timeLeftWords(HOUR + 1), "1 hour");
  assert.equal(timeLeftWords(3 * DAY), "3 days");
  assert.equal(timeLeftWords(30_000), "1 minute");
  assert.equal(untilWords(20 * DAY), "3 weeks");
  assert.equal(untilWords(7 * DAY - 30 * 60_000), "7 days");
  assert.equal(untilWords(60_000), "1 minute");
  assert.equal(untilWords(5 * 60_000), "5 minutes");
  assert.equal(untilWords(30_000), "less than a minute");
});

test("minute unlock copy uses the full schedule from launch, including the cliff", () => {
  const unlock = renderNotification(row({ kind: "unlock", data: { s: NOW + 60_000, v: NOW, e: NOW + 5 * 60_000 } }), NOW);
  assert.deepEqual([unlock.title, unlock.sub], ["Meridian team unlock in 1 minute", "Linear over 5 min from launch"]);
  assert.equal(renderNotification(row({ kind: "unlock", data: { s: NOW + 60_000 } }), NOW).sub, "View the vesting schedule");
});

test("UI-13 paging: the cursor round-trips and refuses edits; limit 1 to 50", () => {
  const cursor = encodeNotificationCursor({ occurredAtMs: 1_790_000_000_000, id: "42" });
  assert.deepEqual(decodeNotificationCursor(cursor), { occurredAtMs: 1_790_000_000_000, id: "42" });
  assert.throws(() => decodeNotificationCursor(`${cursor}x`), { code: "invalid_parameter" });
  assert.throws(() => decodeNotificationCursor("e30.abc"), { code: "invalid_parameter" });
  assert.deepEqual(parseNotificationPage(new URLSearchParams()), { limit: 30, before: null });
  assert.equal(parseNotificationPage(new URLSearchParams("limit=50")).limit, 50);
  assert.throws(() => parseNotificationPage(new URLSearchParams("limit=0")), { code: "invalid_parameter" });
  assert.throws(() => parseNotificationPage(new URLSearchParams("limit=51")), { code: "invalid_parameter" });
});

test("R3-40-AC-1: a SUI sale's notifications: what you have in and your refund in SUI (the row holds no dollars for them); a followed account's commit in dollars, the gate's grammar", () => {
  const sui = { quote_symbol: "SUI", quote_decimals: 9, sale_name: "Driftwood", sale_symbol: "DRFT" } as const;
  const fill = renderNotification(row({ ...sui, data: { m: "participants", v: 500, pct: 99, c: "125000000000" } }), NOW);
  assert.deepEqual([fill.title, fill.sub], ["Driftwood passed 500 backers", "You have 125 SUI in · 6 hours remained when sent"]);
  // "Mira blasted $2,000 into Meridian": one grammar with the tape and the ticker, dollars at the commit's time.
  const follow = renderNotification(row({ ...sui, kind: "follow", data: { usd: "13680" }, callsign: "lucaromano", display_name: "Luca Romano" }), NOW);
  assert.equal(follow.title, "Luca blasted $13,680 into Driftwood");
  const refund = renderNotification(row({ ...sui, kind: "claim", lifecycle: "cancelled", data: { refund: true, c: "125500000000" } }), NOW);
  assert.deepEqual([refund.title, refund.sub], ["Refunds are open for Driftwood", "Your 125.5 SUI refund is ready"]);
  // A USDC sale is unchanged.
  assert.equal(renderNotification(row({ quote_symbol: "USDC", data: { m: "participants", v: 1000, pct: 73, c: "100000000" } }), NOW).sub, "You have $100 in · 6 hours remained when sent");
});


test("an old fill alert explicitly preserves the event-time countdown", () => {
  const original = row({ data: { m: "participants", v: 1000, pct: 73 } });
  const old = renderNotification(original, NOW + 30 * DAY);
  assert.match(old.sub, /6 hours remained when sent/);
  assert.doesNotMatch(old.sub, /hours left/);
});

test("the first-party notification boundary keeps complete producer copy", () => {
  const notification = renderNotification(row({
    kind: "follow", callsign: "mirachen", sale_name: "x".repeat(301), why: "y".repeat(601),
  }), NOW);
  const page = { items: [notification], next_cursor: null, unread_count: 1 };
  assert.ok(notification.title.length > 300);
  assert.equal(notification.sub, `“${"y".repeat(601)}”`);
  assert.equal(socialNotificationPageSchema.safeParse(page).success, false);
  assert.deepEqual(socialNotificationWirePageSchema.parse(page), page);
});
