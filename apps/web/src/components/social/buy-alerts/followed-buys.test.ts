import assert from "node:assert/strict";
import test from "node:test";

import type { SocialBuyAlert } from "@blast/core/modules/social/contracts/buy-alerts.ts";

import type { FreshnessHint } from "../home/feed-freshness.ts";
import { ALERT_SPREAD_MS, FollowedBuys, followedBuyOf, readBuyAlertCard } from "./followed-buys.ts";

const MAYA = `0x${"a1".repeat(32)}`;
const KAI = `0x${"b2".repeat(32)}`;
const ME = `0x${"c3".repeat(32)}`;
const ID = "1200:3:1:0";

function hint(trade: Partial<NonNullable<FreshnessHint["trade"]>> & { actor?: string }, cause: FreshnessHint["cause"] = "hint"): FreshnessHint {
  return { atMs: 0, cause, trade: { checkpoint: 1200, cursor: ID, kind: "trade_buy", ...trade } };
}

function card(overrides: Partial<SocialBuyAlert> = {}): SocialBuyAlert {
  return {
    activity_id: ID,
    occurred_at_ms: 1_000,
    actor: { type: "account", callsign: "maya", display_name: "Maya", avatar_url: null, x_handle: null, path: "/@maya", verified: false },
    wallet: MAYA,
    coin: { presale_id: null, coin_type: `0x${"d4".repeat(32)}::orbit::ORBIT`, symbol: "ORBIT", name: "Orbit", icon_url: null },
    usd: "120.00",
    market_cap_usd: "45000.00",
    ...overrides,
  };
}

test("a hint is kept only for a followed wallet's buy that is not the viewer's own", () => {
  const followed = new Set([MAYA, ME]);
  const own = new Set([ME]);
  assert.deepEqual(followedBuyOf(hint({ actor: MAYA }), followed, own), { activityId: ID, actor: MAYA });
  assert.equal(followedBuyOf(hint({ actor: KAI }), followed, own), null, "not followed");
  assert.equal(followedBuyOf(hint({ actor: ME }), followed, own), null, "the viewer's own wallet");
  assert.equal(followedBuyOf(hint({ actor: MAYA, kind: "trade_sell" }), followed, own), null, "a sell");
  assert.equal(followedBuyOf(hint({ actor: MAYA, kind: undefined }), followed, own), null, "no kind");
  assert.equal(followedBuyOf(hint({}), followed, own), null, "no actor");
  assert.equal(followedBuyOf(hint({ actor: MAYA }, "connect"), followed, own), null, "a reconnect is not a trade");
  assert.equal(followedBuyOf({ atMs: 0, cause: "hint" }, followed, own), null, "no trade");
});

function harness(options: { visible?: () => boolean; read?: (id: string) => Promise<SocialBuyAlert | null> } = {}) {
  const timers: { run: () => void; ms: number; cleared: boolean }[] = [];
  const shown: SocialBuyAlert[] = [];
  const reads: string[] = [];
  const buys = new FollowedBuys({
    setTimeout: (run, ms) => { const timer = { run, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout: (handle) => { (handle as { cleared: boolean }).cleared = true; },
    random: () => 0.5,
    visible: options.visible ?? (() => true),
    readCard: async (id) => { reads.push(id); return options.read ? options.read(id) : card(); },
    show: (alert) => shown.push(alert),
  });
  const fire = async () => {
    for (const timer of timers.splice(0)) if (!timer.cleared) timer.run();
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { buys, timers, shown, reads, fire };
}

test("a kept buy waits a share of the spread, reads its card once and shows it", async () => {
  const h = harness();
  h.buys.offer({ activityId: ID, actor: MAYA });
  h.buys.offer({ activityId: ID, actor: MAYA });
  assert.equal(h.timers.length, 1, "a repeat is dropped");
  assert.equal(h.timers[0]!.ms, ALERT_SPREAD_MS / 2);
  assert.equal(h.reads.length, 0, "nothing is read before the wait");
  await h.fire();
  assert.deepEqual(h.reads, [ID]);
  assert.equal(h.shown.length, 1);
});

test("a card that names another wallet or another trade, or a missing card, shows nothing", async () => {
  for (const answer of [card({ wallet: KAI }), card({ activity_id: "1:1:1:1" }), null]) {
    const h = harness({ read: async () => answer });
    h.buys.offer({ activityId: ID, actor: MAYA });
    await h.fire();
    assert.equal(h.shown.length, 0);
  }
  const failing = harness({ read: async () => { throw new Error("network"); } });
  failing.buys.offer({ activityId: ID, actor: MAYA });
  await failing.fire();
  assert.equal(failing.shown.length, 0);
});

test("a hidden tab neither queues, reads nor shows; close stops every wait", async () => {
  let visible = false;
  const h = harness({ visible: () => visible });
  h.buys.offer({ activityId: ID, actor: MAYA });
  assert.equal(h.timers.length, 0);

  visible = true;
  h.buys.offer({ activityId: "1200:3:2:0", actor: MAYA });
  visible = false;
  await h.fire();
  assert.equal(h.reads.length, 0, "hidden by the time the wait ends");

  visible = true;
  h.buys.offer({ activityId: "1200:3:3:0", actor: MAYA });
  h.buys.close();
  assert.equal(h.timers[0]!.cleared, true);
  await h.fire();
  assert.equal(h.shown.length, 0);
});

test("the card read: a card parses; no card, an error or a malformed answer is null", async () => {
  const urls: string[] = [];
  const answer = (status: number, body: unknown) => (async (url: string | URL | Request) => {
    urls.push(String(url));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  assert.deepEqual(await readBuyAlertCard(ID, answer(200, card())), card());
  assert.equal(urls[0], "/api/social/activity/1200%3A3%3A1%3A0/alert");
  assert.equal(await readBuyAlertCard(ID, answer(200, null)), null, "no card");
  assert.equal(await readBuyAlertCard(ID, answer(404, { code: "not_found" })), null, "no row or coin yet");
  assert.equal(await readBuyAlertCard(ID, answer(503, { code: "service_unavailable" })), null);
  assert.equal(await readBuyAlertCard(ID, answer(200, { ...card(), extra: 1 })), null);
});
