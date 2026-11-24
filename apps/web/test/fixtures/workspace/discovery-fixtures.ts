import { auditPresaleId } from "./audit-fixtures";
import { proofHomeCoins, proofCoinTypes, proofPresaleIds, proofTraders } from "./redesign-fixtures";
import { fixtureCoinType } from "../social/trade/trade-fixtures";
import type { HomeCoin } from "@blast/core/modules/social/contracts/home.ts";

type DiscoveryScenario = "ready" | "loading" | "error" | "empty" | "stale" | "unknown" | "duplicates";
declare global { interface Window { discoveryFixture?: { state: DiscoveryScenario; requests: string[]; pnlState?: DiscoveryScenario } } }

function discoveryPresaleId(coin: HomeCoin) {
  if (coin.symbol === "LUMN") return null;
  const linked: Readonly<Record<string, string>> = { KSTL: auditPresaleId, NOVA: proofPresaleIds.NOVA, ORBT: proofPresaleIds.ORBT };
  return linked[coin.symbol] ?? coin.presale_id;
}

export function discoveryCoins(now: number): readonly HomeCoin[] {
  return proofHomeCoins.map((coin, index) => ({
    ...coin,
    coin_type: coin.symbol === "NOVA" ? proofCoinTypes.NOVA : coin.symbol === "ORBT" && coin.sale ? proofCoinTypes.ORBT : fixtureCoinType(coin.symbol),
    presale_id: discoveryPresaleId(coin),
    discussion: { posts: coin.symbol === "KSTL" ? 7 : index === 1 ? 0 : 3 + index },
    holders_as_of_ms: now,
    holders: coin.symbol === "KSTL" ? 284 : coin.holders,
    activity: { ...coin.activity, bought: [{ quote_type: "0x2::usdc::USDC", quote_symbol: "USDC", quote_decimals: 6, atoms: String((14800 + index * 9400) * 1e6), usd: String(14800 + index * 9400), usd_complete: true }] },
    price_as_of_ms: now, launched_ms: now - (index + 1) * 3_600_000,
    sale: coin.sale ? { ...coin.sale, start_ms: now - 86_400_000, end_ms: now + (index === 6 ? 4 : 54) * 3_600_000 } : null,
  }));
}

/** Public discovery contracts only; all rows and all wallet actions remain simulated. */
export function discoveryResponse(url: URL, signal?: AbortSignal | null): Promise<Response> | null {
  if (url.pathname === "/api/social/trades/coins") {
    const term = (url.searchParams.get("q") ?? "").toLowerCase();
    const coins = discoveryCoins(Date.now()).filter(coin => `${coin.symbol} ${coin.name} ${coin.coin_type}`.toLowerCase().includes(term));
    return Promise.resolve(Response.json({ coins: coins.map(coin => ({ coin_type: coin.coin_type, symbol: coin.symbol, name: coin.name, decimals: 9, icon_url: coin.icon_url, usd_price: coin.price_usd, in_presale: !!coin.sale, presale_id: coin.presale_id })), next_cursor: null }));
  }
  if (!["/api/social/home", "/api/social/home/coins", "/api/social/happening", "/api/social/home/traders"].includes(url.pathname)) return null;
  const fixture = window.discoveryFixture ??= { state: "ready", requests: [] };
  fixture.requests.push(url.pathname + url.search);
  if (url.pathname === "/api/social/home/traders") return tradersResponse(fixture.pnlState ?? "ready", signal);
  if (fixture.state === "loading") return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("Fixture aborted")), { once: true }));
  if (fixture.state === "error") return Promise.resolve(new Response("{}", { status: 503 }));
  const now = Date.now();
  const meta = { window: "24h", clock_ms: now, as_of: { status: "current", indexed_at_ms: now, lag_ms: fixture.state === "stale" ? 180_000 : 0 } };
  let coins = fixture.state === "empty" ? [] : [...discoveryCoins(now)];
  // Three markets of one symbol and image, as the audit saw RHRSL: two on the same venue, one elsewhere.
  if (fixture.state === "duplicates" && coins[0]) coins.push({ ...coins[0], coin_type: "0xdeadbeef::kestrel::KSTL" }, { ...coins[0], coin_type: "0xbeefcafe::kestrel::KSTL", venue: "bluefin" });
  if (fixture.state === "stale") coins = coins.map(coin => ({ ...coin, price_as_of_ms: now - 180_000 }));
  if (fixture.state === "unknown") coins = coins.map(coin => ({ ...coin, price_usd: null, fdv_usd: null, change_24h_bps: null, holders: null, holders_as_of_ms: null }));
  const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
  if (url.pathname === "/api/social/happening") return json({ ...meta, today: [], opening_soon: [], fastest: coins.filter(coin => coin.sale).map(coin => ({ presale: { presale_id: coin.presale_id, lifecycle: coin.lifecycle, end_ms: coin.sale!.end_ms } })), last_hour: {}, tape: [] });
  if (url.pathname === "/api/social/home/coins") coins = coins.filter(coin => url.searchParams.getAll("presale").includes(coin.presale_id ?? ""));
  if (url.searchParams.get("tradable") === "1") coins = coins.filter(coin => coin.tradable);
  if (url.searchParams.get("sort") === "trending") coins.reverse();
  return json({ ...meta, missing: [], coins, page: 1, pages: 1, total: coins.length, next_cursor: null, pool_volumes: {} });
}

function tradersResponse(state: DiscoveryScenario, signal?: AbortSignal | null): Promise<Response> {
  if (state === "loading") return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("Fixture aborted")), { once: true }));
  if (state === "error") return Promise.resolve(new Response("{}", { status: 503 }));
  const now = Date.now();
  return Promise.resolve(Response.json({ ...proofTraders, traders: state === "empty" ? [] : proofTraders.traders, limit: 10, clock_ms: now, as_of: { lag_ms: state === "stale" ? 180_000 : 0, timestamp_ms: now } }));
}
