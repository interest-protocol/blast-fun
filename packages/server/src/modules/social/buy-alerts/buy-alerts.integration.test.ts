import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { socialBuyAlertPath, SOCIAL_FOLLOWING_WALLETS_PATH } from "@blast/core/modules/social/contracts/buy-alerts.ts";

import { accountId, activityAssets, activityOrigin, activityRow, activityWallets, createActivityStreamFixture, hex } from "../../../../test/fixtures/workspace/activity-stream-fixture.ts";

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;

test("followed buy alerts: a named buy of a shown coin has a card; everything else is a cached null; followed wallets stay private", { skip: !databaseUrl }, async () => {
  const fixture = await createActivityStreamFixture(databaseUrl!, Date.now());
  try {
    const { admin, now } = fixture;
    const maya = activityWallets.public;
    const extra = [
      { ...activityRow(now, 0, { checkpoint: 300, kind: "trade_buy", actor: maya, presale_id: activityAssets.sale, coin_type: activityAssets.coin, usd_value: "120.5" }), market_cap_usd: "45000" },
      activityRow(now, 0, { checkpoint: 301, kind: "trade_buy", actor: maya, presale_id: hex(13), coin_type: `${hex(13)}::coin::HIDDEN` }),
      activityRow(now, 0, { checkpoint: 302, kind: "trade_sell", actor: maya }),
    ];
    await admin.query(
      "INSERT INTO blast_infra_fixture.activity SELECT * FROM jsonb_populate_recordset(NULL::blast_infra_fixture.activity, $1::jsonb)",
      [JSON.stringify(extra)],
    );

    const card = (id: string, trading = true) =>
      fixture.buyAlerts(trading).alert.GET(new Request(activityOrigin + socialBuyAlertPath(id), { headers: { "x-forwarded-for": "203.0.113.7" } }), testClient("203.0.113.7"));

    // A sale buy: every field, cached at the edge for 10 s.
    const sale = await card("300:0:0:0");
    assert.equal(sale.status, 200);
    assert.equal(sale.headers.get("cache-control"), "public, s-maxage=10");
    assert.deepEqual(await sale.json(), {
      activity_id: "300:0:0:0",
      occurred_at_ms: now - 120_000,
      actor: { type: "account", callsign: "maya", display_name: "maya", avatar_url: null, x_handle: "maya", path: "/@maya", verified: true },
      wallet: maya,
      coin: { presale_id: activityAssets.sale, coin_type: activityAssets.coin, symbol: "ORBIT", name: "Orbit", icon_url: null },
      usd: "120.50",
      market_cap_usd: "45000.00",
    });

    // A launch's curve coin: no sale, its coin type is the page; no price, no cap.
    const curve = await card("150:2:3:1");
    assert.equal(curve.status, 200);
    const curveBody = await curve.json();
    assert.deepEqual(curveBody.coin, { presale_id: null, coin_type: activityAssets.standalone, symbol: "SOLO", name: "Solo", icon_url: null });
    assert.equal(curveBody.usd, null);
    assert.equal(curveBody.market_cap_usd, null);

    // A private account's buy, a hidden sale, a sell, and any id while trades are hidden: no card,
    // as a null the edge shares too, so every follower's read of it coalesces.
    const misses = [...["150:2:3:0", "301:0:0:0", "302:0:0:0"].map((id) => card(id)), card("300:0:0:0", false)];
    for (const missing of await Promise.all(misses)) {
      assert.equal(missing.status, 200);
      assert.equal(missing.headers.get("cache-control"), "public, s-maxage=10");
      assert.equal(await missing.json(), null);
    }
    // An id with no row yet (the replica behind the hint) is a 404 the edge never caches.
    const unknown = await card("999:0:0:0");
    assert.equal(unknown.status, 404);
    assert.match(unknown.headers.get("cache-control") ?? "", /no-store/);
    // A malformed id, or a checkpoint past a bigint, is a bad request and never reaches the database.
    for (const id of ["not-an-id", "9999999999999999999:0:0:0"]) {
      const bad = await card(id);
      assert.equal(bad.status, 400, id);
      assert.match(bad.headers.get("cache-control") ?? "", /no-store/, id);
    }

    // Followed wallets: signed-in only, private, and only wallets the naming rule names now.
    const wallets = (token?: string) =>
      fixture.buyAlerts().wallets.GET(new Request(activityOrigin + SOCIAL_FOLLOWING_WALLETS_PATH, { headers: token ? { authorization: token } : {} }), testClient());
    assert.equal((await wallets()).status, 401);
    await admin.query(
      "INSERT INTO social_follows (follower_account_id,target_kind,target_id,source) VALUES ($1,'account',$2,'user')",
      [accountId(1), accountId(2)],
    );
    const followed = await wallets(fixture.bearer("maya"));
    assert.equal(followed.status, 200);
    assert.equal(followed.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await followed.json(), { wallets: [activityWallets.late] }, "the private account's wallet is never listed");
    assert.deepEqual(await (await wallets(fixture.bearer("solo"))).json(), { wallets: [] });
  } finally {
    await fixture.close();
  }
});
