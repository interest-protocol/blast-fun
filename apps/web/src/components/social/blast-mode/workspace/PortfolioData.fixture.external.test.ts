import { testClient } from "../../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { portfolioAccountId, portfolioSaleId } from "../../../../../test/fixtures/workspace/portfolio/configuration.ts";
import { fixtureCoinType } from "../../../../../test/fixtures/social/trade/trade-fixtures.ts";

test("prepared Portfolio fixture reads current verified-wallet summary, pages and owner-only positions through real private routes", { skip: !process.env.T020_CONFIG_DIR }, async () => {
  const { pool, portfolioRoute, profiles, fixtureToken, meRoute, tradeCoins, home } = await import("../../../../../test/fixtures/workspace/portfolio/server.ts");
  const request = (path: string, actor?: number) => new Request(`http://127.0.0.1:42980${path}`, { headers: actor ? { authorization: `Bearer ${fixtureToken(actor)}` } : {} });
  try {
    const denied = await portfolioRoute.GET(request("/api/social/me/portfolio?view=summary"), testClient());
    assert.equal(denied.status, 401);
    const identity = await meRoute.GET(request("/api/social/me", 1), testClient());
    assert.equal(identity.status, 200);
    assert.equal((await identity.json()).account.account_id, portfolioAccountId(1));
    const a = await portfolioRoute.GET(request("/api/social/me/portfolio?view=summary", 1), testClient());
    assert.equal(a.status, 200);
    assert.match(a.headers.get("cache-control")!, /private.*no-store|no-store.*private/);
    const summary = await a.json();
    assert.equal(summary.balances.usdc.atoms, "123450000");
    assert.equal(summary.balances.sui.atoms, "4000000000");
    const holding = await portfolioRoute.COINS(request("/api/social/me/portfolio/coins?page=1&q=KSTL&hide_small=false", 1), testClient());
    assert.equal(holding.status, 200);
    const held = await holding.json();
    assert.equal(held.coins[0].coin_type, fixtureCoinType("KSTL"));
    assert.equal(held.coins[0].balance, "600000000000001");
    const first = await portfolioRoute.COINS(request("/api/social/me/portfolio/coins?page=1&hide_small=false", 1), testClient());
    const second = await portfolioRoute.COINS(request("/api/social/me/portfolio/coins?page=2&hide_small=false", 1), testClient());
    assert.equal((await first.json()).coins.length, 20);
    assert.ok((await second.json()).coins.length > 0);
    const positions = await profiles.mePresales.GET(request("/api/social/me/presales?view=positions", 1), testClient());
    const owned = await positions.json();
    assert.equal(owned.positions[0].presale.presale_id, portfolioSaleId);
    assert.equal(owned.positions[0].committed_atoms, "123450001");
    for (const symbol of ["KSTL", "LUMN"]) {
      const result = await tradeCoins(request(`/api/social/trades/coins?q=${encodeURIComponent(fixtureCoinType(symbol))}`), testClient());
      assert.equal(result.status, 200);
      const metadata = (await result.json()).coins[0];
      assert.equal(metadata.coin_type, fixtureCoinType(symbol));
      assert.notEqual(metadata.in_presale, true);
      if (symbol === "LUMN") assert.equal(metadata.usd_price, null, "stale USD does not remove real route capability");
    }
    const publicPosition = await home.COINS(request(`/api/social/home/coins?presale=${portfolioSaleId}&window=24h`), testClient());
    assert.equal(publicPosition.status, 200);
    assert.equal((await publicPosition.json()).coins[0].presale_id, portfolioSaleId);
    const b = await portfolioRoute.GET(request("/api/social/me/portfolio?view=summary", 2), testClient());
    assert.equal((await b.json()).balances.usdc.atoms, "73000000");
    const bPositions = await profiles.mePresales.GET(request("/api/social/me/presales?view=positions", 2), testClient());
    assert.equal((await bPositions.json()).positions.length, 0);
    const empty = await portfolioRoute.GET(request("/api/social/me/portfolio?view=summary", 3), testClient());
    assert.equal((await empty.json()).balances.usdc.atoms, "0");
  } finally { await pool.end(); }
});
