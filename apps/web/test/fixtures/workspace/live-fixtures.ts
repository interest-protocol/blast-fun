import { createWorkspaceStore } from "../../../src/components/social/blast-mode/workspace/model.ts";
import { NOTIFICATION_PREFERENCE_KEYS } from "@blast/core/modules/social/contracts/settings.ts";
import { coinRows, homeCoinRows, history, saleId } from "./coin-fixtures";
import { presaleDetail, presaleFacts, presaleViewer } from "./presale-fixtures";
import { fixtureTradeQuote, fixtureWallet } from "../social/trade/trade-fixtures.ts";
import type { SocialTradeQuoteRequest } from "@blast/core/modules/social/contracts/trades.ts";

export const liveSales = ["4", "8"].map((digit) => `0x${digit.repeat(64)}`);
export const liveCoins = ["5", "9"].map((digit) => `0x${digit.repeat(64)}::kestrel::KSTL`);
export function liveDetail(id: string) {
  const detail = presaleDetail();
  const index = liveSales.indexOf(id);
  return { ...detail, presale: { ...detail.presale, presale_id: id, sale_token: liveCoins[index]!, symbol: index ? "STEL" : "KSTL", name: index ? "Stellar" : "Kestrel" } };
}
export function liveStore() {
  const store = createWorkspaceStore();
  store.setCapacity(4);
  store.setDataCollapsed(true);
  for (let i = 0; i < 31; i++) store.add({ panel_id: `R${i}`, chain: "sui", network: "mainnet", coin_type: `0x2::retained::R${i}`, presale_id: null });
  for (const i of [1, 0]) {
    const id = `P${i + 1}`;
    store.add({ panel_id: id, chain: "sui", network: "mainnet", coin_type: liveCoins[i]!, presale_id: liveSales[i]! });
    const panel = store.getSnapshot().panels[id]!;
    store.patchPanel(id, { active_namespace: "presale", presale: { ...panel.presale, commitment: { ...panel.presale.commitment, amount: "25" } } });
  }
  for (const i of [1, 0]) {
    const id = `C${i + 1}`;
    store.add({ panel_id: id, chain: "sui", network: "mainnet", coin_type: coinRows[i]!.coin_type, presale_id: coinRows[i]!.presale_id });
    const panel = store.getSnapshot().panels[id]!;
    store.patchPanel(id, { active_namespace: "coin", coin: { ...panel.coin, trade: { ...panel.coin.trade, buy: { typed: "50", mode: "typed" } } } });
  }
  return store;
}

/** Only this test app's HTTP route calls this controlled provider. */
export function liveResponse(path: string, body: Record<string, unknown> = {}) {
  const url = new URL(path, "https://fixture.test");
  const clock_ms = Date.now();
  const as_of = { checkpoint: 1, timestamp_ms: clock_ms, lag_ms: 0 };
  const window = url.searchParams.get("window") === "1h" ? "1h" : "24h";
  const totals = { scope: "pool", window, from_ms: clock_ms - (window === "1h" ? 3_600_000 : 86_400_000), to_ms: clock_ms, participants: 0, events: 0, buyers: 0, sellers: 0, backers: 0, claimers: 0, bought: [], sold: [], committed: [], latest_ms: null };
  if (url.pathname === "/api/social/me/settings") return Response.json({
    privacy: "private", sharing_since_ms: null, commit_too_coin_type: null, public_portfolio: false,
    explorer: "suiscan", sound: false, blast_mode_confirm_actions: false,
    notifications: Object.fromEntries(NOTIFICATION_PREFERENCE_KEYS.map((key) => [key, false])),
  });
  if (url.pathname === "/kit/wallet") return Response.json(fixtureWallet());
  if (url.pathname === "/kit/trade-quote") return Response.json({ status: "ok", quote: fixtureTradeQuote(body as unknown as SocialTradeQuoteRequest, { signedIn: true, fee: "blast", nowMs: Date.now(), wallet: fixtureWallet() }) });
  if (url.pathname === "/kit/commit-facts") return Response.json(presaleFacts(liveDetail(url.searchParams.get("presale")!)));
  const id = url.pathname.split("/").at(-1)!;
  if (liveSales.includes(id)) return Response.json(liveDetail(id));
  if (url.pathname.endsWith("/presales/viewer")) return Response.json({ presales: Object.fromEntries(liveSales.map((sale) => [sale, presaleViewer])), rows: null });
  if (url.pathname.endsWith("/trades/coins")) return Response.json({ coins: liveTradeCoins(url.searchParams.get("q")), next_cursor: null });
  if (url.pathname.endsWith("/prices")) return Response.json({ prices: livePrices(url.searchParams), as_of });
  if (url.pathname.endsWith("/home/activity")) return Response.json({ presale_id: url.searchParams.get("presale"), participants: [], totals, as_of, next_cursor: null, window, clock_ms });
  if (url.pathname.endsWith("/activity/hints")) return new Response(null, { status: 204 });
  if (url.pathname === "/api/social/home" || url.pathname.endsWith("/home/coins")) {
    const coins = liveHomeCoins(url.pathname.endsWith("/coins"));
    return Response.json({ coins, missing: [], as_of, window, clock_ms, next_cursor: null, page: 1, pages: 1, total: coins.length });
  }
  return Response.json({}, { status: 404 });
}

function liveTradeCoins(coin: string | null) {
  return coinRows.filter((row) => row.coin_type === coin)
    .map(({ coin_type, symbol, name, decimals, icon_url, presale_id, usd_price, in_presale }) => ({
      coin_type, symbol, name, decimals, icon_url, presale_id, usd_price, in_presale,
    }));
}

function liveHomeCoins(byPresale: boolean) {
  return byPresale
    ? homeCoinRows.filter((row) => row.presale_id === saleId).map((row) => ({ ...row, lifecycle: "migrated" }))
    : [];
}

function livePrices(params: URLSearchParams) {
  const coin = params.get("coin");
  const presale = params.get("presale");
  return coinRows.filter((row) => row.coin_type === coin || (presale && row.presale_id === presale))
    .map((row) => history(row.coin_type));
}
