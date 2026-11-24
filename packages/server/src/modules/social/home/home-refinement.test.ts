import assert from "node:assert/strict";
import test from "node:test";
import { readSocialJson } from "@blast/server/modules/social/route-kit/route.ts";
import type { WalletHolding, WalletHoldings } from "@blast/server/modules/social/portfolio/wallet-holdings.ts";
import type { SocialPnl } from "@blast/core/modules/social/contracts/pnl.ts";
import type { HomeTrader } from "@blast/core/modules/social/contracts/home.ts";
import { readFollowingRequest } from "@blast/server/modules/social/home/following-request.ts";
import { rankTraders, traderHoldingsOf } from "@blast/server/modules/social/home/traders.ts";

const request = (body: unknown) => new Request("https://blast.test/api/social/me/home/following", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("Following pagination reaches mode validation, including page one and retry", async () => {
  const body = { mode: "coins", window: "24h", page: 1, limit: 10 };
  // The old envelope rejected the actual browser payload before the mode parser.
  await assert.rejects(readSocialJson(request(body), ["mode", "window"], ["cursor", "limit", "presale_ids", "presale_id"]), { code: "invalid_request" });
  for (const page of [1, 2, 1]) assert.deepEqual(await readFollowingRequest(request({ ...body, page })), { ...body, page, cursor: null });
  for (const invalid of [{ ...body, page: 0 }, { ...body, page: "1" }, { ...body, page: 2, cursor: "anything" }, { ...body, unknown: true }, { mode: "tape", window: "24h", page: 1 }]) {
    await assert.rejects(readFollowingRequest(request(invalid)), { code: "invalid_request" });
  }
});

const trader = (key: string, pnl: string | null, publicValue = true, extra: Partial<HomeTrader> = {}): HomeTrader => ({
  key, actor: { type: "account", callsign: key, display_name: key, avatar_url: null, x_handle: null, verified: false, path: `/crew/${key}` },
  followers: null, buys: null, sells: null, commits: null, claims: null, latest_ms: 1, latest_kind: "trade_buy", events_total: 1,
  portfolio: { public: publicValue, value_usd: null, pnl_usd: pnl }, coins: [], coins_total: 0, ...extra,
});

test("rank complete public P&L, keeping losses, privacy, ties and missing values distinct; $0 only while holding a coin", () => {
  const held = { holdings: [{ coin_type: "c", presale_id: "c", symbol: "C", icon_url: null, decimals: 2, balance: "1", value_usd: "1.00", share_bps: 10_000, pnl_usd: "0.00" }] };
  const result = rankTraders([trader("missing", null), trader("loss", "-10.00"), trader("zero", "0.00"), trader("zero-holder", "0.00", true, held), trader("private", "900.00", false), trader("winner", "10.00"), trader("tied", "10.00"), trader("hidden-performance", "999.00", true, { performance_public: false })]);
  assert.deepEqual(result.map((row) => [row.key, row.rank]), [["tied", 1], ["winner", 1], ["zero-holder", 3], ["loss", 4]]);
  assert.deepEqual(rankTraders([trader("a", "0.00"), trader("b", "0.00", true, { holdings: [] })]), []);
  assert.equal(rankTraders(Array.from({ length: 15 }, (_, i) => trader(String(i), `${i + 1}.00`))).length, 15);
});

test("holdings use the profile wallet read and P&L; incomplete valuations never create shares", () => {
  const now = 1_000_000;
  const row = (id: string, balance: string, price: string, age = 0): WalletHolding => ({ coin_type: id, name: id, presale_id: id, symbol: id.toUpperCase(), icon_url: null, decimals: 2, balance, price: { usd_price: price, as_of_ms: now - age }, priceUnavailable: false });
  const wallet: WalletHoldings = { holdings: [row("small", "100", "2"), row("large", "200", "10")], sync: { status: "ready", checkpoint: "1", as_of_ms: now } };
  const pnl: SocialPnl = { scope: "indexed_sale_coins", period: "since_launch", history_complete: true, wallet_sync: wallet.sync, totals: { realized_usd: "0.00", unrealized_usd: "5.00", total_usd: "5.00" }, assets: [{ presale_id: "large", coin_type: "large", symbol: "LARGE", icon_url: null, tracked_balance: "200", basis_usd: "15.00", realized_usd: "0.00", unrealized_usd: "5.00", total_usd: "5.00" }] };
  const held = traderHoldingsOf(wallet, pnl, now)!;
  assert.deepEqual(held.map((holding) => [holding.presale_id, holding.balance, holding.value_usd, holding.share_bps]), [["large", "200", "20.00", 9090], ["small", "100", "2.00", 909]]);
  assert.equal(held[0]?.pnl_usd, "5.00");
  assert.equal(held[1]?.pnl_usd, null);
  const stale = traderHoldingsOf({ ...wallet, holdings: [...wallet.holdings, row("stale", "200", "3", 120_001)] }, pnl, now)!;
  assert.equal(stale.at(-1)?.value_usd, null);
  assert.ok(stale.every((holding) => holding.share_bps === null));
  assert.deepEqual(traderHoldingsOf({ ...wallet, holdings: [] }, pnl, now), []);
  assert.equal(traderHoldingsOf({ ...wallet, sync: { ...wallet.sync, status: "syncing" } }, pnl, now), undefined);
  assert.equal(traderHoldingsOf({ ...wallet, holdings: [{ ...row("unknown", "100", "1"), decimals: null }] }, pnl, now), undefined);
});
