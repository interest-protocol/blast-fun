import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom, recordAnimations, setInputValue, testEvent } from "../../../../../test/fixtures/social/test-dom.ts";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@blast/core/modules/social/contracts/settings.ts";
import { FeedOverlaysProvider } from "../../feed-ui/shell-bridge.tsx";
import type { TradeKit, TradeSendInput } from "../../trade/trade-kit.ts";
import { invalidateAfter } from "#web/lib/query/invalidate.ts";
import { notifyShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { fixtureMarket } from "../../../../../test/fixtures/presale-pages/market-fixtures.ts";
import { fixtureTradeQuote, fixtureWallet } from "../../../../../test/fixtures/social/trade/trade-fixtures.ts";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { SocialViewerProvider } from "#web/components/social/SignInGate.tsx";
import { walletCoinViews } from "#web/components/social/coins/coin-model.ts";
import { walletReads } from "../../../../../test/fixtures/social/commit/wallet-reads.ts";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import { createWorkspaceStore } from "./model";
import { BlastActionProvider, type ActionAccountSession } from "./BlastActionProvider";

const { document, window } = installTestDom();
const motion=recordAnimations();
window.scrollTo = () => {};
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { WorkspaceHost } = await import("./WorkspaceHost");
const { useWorkspace } = await import("./workspace-context");
const { PortfolioData } = await import("./PortfolioData");
const { WorkspaceCoinPanel } = await import("./panels/WorkspaceCoinPanel");
const guest: ActionAccountSession = { status: "ready", account: null, sessionStatus: "signed_out", sessionIdentity: "" };

async function mounted(identity: ActionAccountSession = guest, reply: typeof fetch = async () => Response.json({}), mobile = false, kit?: TradeKit) {
  document.body.innerHTML = '<div data-blast-ui><main id="main"></main><div id="mount"></div></div>';
  window.history.replaceState(null, "", "/portfolio?tab=rewards#untouched");
  window.matchMedia = query => ({ matches: query.includes("prefers-reduced-motion") || (mobile && query.includes("1099")), media: query, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
  const store = createWorkspaceStore();
  store.selectDataView("Portfolio");
  store.setDataCollapsed(false);
  let dispatch: ReturnType<typeof useWorkspace>["dispatch"];
  function Controls() { dispatch = useWorkspace().dispatch; return null; }
  const client = createTestQueryClient();
  const root = createRoot(document.getElementById("mount")!);
  const before = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input, init) => { requests.push(String(input)); return reply(input, init); };
  let current = identity;
  const getAccessToken = async () => current.account?.account_id ?? null;
  const render = () => {
    const workspace = (
      <FeedOverlaysProvider value={{ tradeKit: kit }}><BlastActionProvider accountState={current} getAccessToken={getAccessToken}><WorkspaceHost ownerKey="retained-layout" resolveOwner={async () => ({ kind: "account", account_id: "layout", store })} entryGeneration={1} onExit={() => {}} slots={{ controls: <Controls />, data: { Portfolio: PortfolioData }, panel: kit ? WorkspaceCoinPanel : ({ panel }) => <p>{panel.coin_type}</p> }} /></BlastActionProvider></FeedOverlaysProvider>
    );
    root.render(<QueryProvider client={client}>
      {kit ? <SocialViewerProvider signedIn={current.sessionStatus === "authenticated"} sessionIdentity={current.sessionIdentity} getAccessToken={getAccessToken}>
        {workspace}
      </SocialViewerProvider> : workspace}
    </QueryProvider>);
  };
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
  await act(async () => render()); await settle();
  await act(async () => dispatch!.setDataCollapsed(false)); await settle();
  return { store, client, requests, settle,
    async openDataPortfolio() { await act(async () => dispatch!.setDataCollapsed(false)); await settle(); },
    async openPortfolio() { await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Portfolio"]')!.click()); await settle(); await settle(); },
    async identity(value: ActionAccountSession) { current = value; await act(async () => render()); await settle(); },
    async click(label: string) {
      if (label === "Sell KSTL" && !document.querySelector('[aria-label="Sell KSTL"]')) {
        await act(async () => dispatch!.setDataCollapsed(false)); await settle();
      }
      const section = /^Portfolio (\w+) section$/.exec(label)?.[1];
      const tab=section ? [...document.querySelectorAll<HTMLButtonElement>('[role="tablist"][aria-label="Portfolio sections"] [role="tab"]')].find(tab => tab.textContent!.toLowerCase() === section) ?? null
        : ["Coins","Presales","Traders","Activity","Feed","Portfolio"].includes(label) ? document.querySelector<HTMLButtonElement>(`[role="tablist"][aria-label="What to discover"] #workspace-data-tab-${label}[role="tab"]`) : null;
      if(section) assert.ok(tab, label);
      if(tab) {
        await act(async()=>tab.click());
        await settle();return;
      }
 const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(button => button.getAttribute("aria-label") === label || button.textContent === label); assert.ok(button, label); await act(async () => button.click()); await act(async()=>motion.finishAll()); await settle(); },
    async dispose() { await act(async () => root.unmount()); client.clear(); globalThis.fetch = before; },
  };
}

test("Portfolio distinguishes guest, pending identity, read error and account setup without private reads", async () => {
  const page = await mounted();
  try {
    assert.match(document.body.textContent!, /Sign in to see your portfolio/);
    assert.equal(page.requests.length, 0);
    await page.identity({ ...guest, status: "loading", sessionStatus: "pending" });
    assert.ok(document.querySelector('[aria-label="Checking portfolio account"]'));
    await page.identity({ ...guest, status: "error", sessionStatus: "refused" });
    assert.match(document.body.textContent!, /Your account could not be checked/);
    await page.identity({ ...guest, sessionStatus: "authenticated" });
    assert.match(document.body.textContent!, /Finish setting up your account/);
    assert.equal(page.requests.length, 0);
    assert.equal(window.location.pathname + window.location.search + window.location.hash, "/portfolio?tab=rewards#untouched");
  } finally { await page.dispose(); }
});

function actor(name: string): ActionAccountSession {
  return { status: "ready", sessionStatus: "authenticated", sessionIdentity: `principal:${name}`, account: { account_id: name, callsign: name, kind: "new", display_name: name, avatar_url: null, x_handle: null, verified: false, onboarding: { shown: true, completed: true }, privacy: "private", sharing_since_ms: null, wallets: [] } };
}
function summary(cash = "100.00") {
  return { balances: { sui: { atoms: "0", usd: "0.00" }, usdc: { atoms: "100000000", usd: cash } }, coin_summary: { value_usd: "0.00", known_value_usd: "0.00", today: null }, positions: [], commitments: { committed_usd: "0.00", claimable_usd: "0.00" }, coins: [], vesting: { has_schedule: false, href: null }, totals: { people: 0, volume_usd: "0.00" }, trend: null, prices_as_of_ms: null, unavailable: ["trend"], wallet_sync: { status: "ready", checkpoint: "1", as_of_ms: 1 } };
}

test("Portfolio reads the live actor over retained layout and discards a delayed former actor answer", async () => {
  let finishA: ((response: Response) => void) | undefined;
  const page = await mounted(guest, async (input, init) => {
    if (String(input).endsWith("/settings")) return Response.json({});
    const token = new Headers(init?.headers).get("authorization");
    if (token === "Bearer A") return new Promise(resolve => { finishA = resolve; });
    return Response.json({ ...summary(), balances: { sui: { atoms: "0", usd: "0.00" }, usdc: { atoms: "73000000", usd: "73.00" } } });
  });
  try {
    await page.identity(actor("A"));
    assert.ok(finishA, "A starts its private summary without replacing retained layout");
    assert.ok(document.querySelector('[aria-label="Loading portfolio summary"]'));
    await page.identity(actor("B"));
    assert.match(document.querySelector('[aria-label="Portfolio summary"]')!.textContent!, /\$73/);
    await act(async () => finishA!(Response.json(summary())));
    await page.settle();
    assert.doesNotMatch(document.querySelector('[aria-label="Portfolio summary"]')!.textContent!, /\$100/);
    assert.equal(page.store.getSnapshot().data.selected_view, "Portfolio");
    assert.doesNotMatch(JSON.stringify(page.store.getSnapshot()), /73000000|known_value_usd|wallet_sync/);
    await page.identity(guest);
    assert.match(document.body.textContent!, /Sign in to see your portfolio/);
    assert.doesNotMatch(document.body.textContent!, /\$73/);
  } finally { await page.dispose(); }
});

const coinType = (symbol: string) => `0x${"7a3f".padEnd(60, "0")}c91e::${symbol.toLowerCase()}::${symbol}`;
const holdings = [
  { coin_type: coinType("KSTL"), symbol: "KSTL", name: "Kestrel", decimals: 9, balance: "600000000000001", value_usd: null, presale_id: null },
  { coin_type: coinType("ZERO"), symbol: "ZERO", name: "Preferred zero", decimals: 9, balance: "0", value_usd: "0.00", presale_id: null },
  { coin_type: coinType("ODD"), symbol: "ODD", name: "Unknown metadata", decimals: null, balance: "1", value_usd: null, presale_id: null },
];
function tradeCoin(holding: (typeof holdings)[number], usdPrice: string | null = null) {
  return {
    coin_type: holding.coin_type,
    symbol: holding.symbol,
    name: holding.name,
    decimals: holding.decimals,
    icon_url: null,
    usd_price: usdPrice,
    presale_id: holding.presale_id,
  };
}
function portfolioReply(input: RequestInfo | URL) {
  const url = new URL(String(input), "https://blast.test");
  if (url.pathname.endsWith("/settings")) return Response.json({});
  if (url.pathname === "/api/social/trades/coins") return Response.json({ coins: url.searchParams.get("q") === coinType("KSTL") ? [tradeCoin(holdings[0]!)] : [], next_cursor: null });
  if (url.pathname.endsWith("/portfolio/coins")) {
    const coins = holdings.filter(row => row.symbol.includes(url.searchParams.get("q") ?? ""));
    return Response.json({ coins, page: 1, page_size: 20, total: coins.length });
  }
  return Response.json(summary());
}

test("held-coin Sell reuses absent, visible and retained panels without inventing amounts or sending", async () => {
  const page = await mounted(actor("A"), async (input) => portfolioReply(input));
  try {
    await page.click("Portfolio coins section");
    assert.ok(document.querySelector('[aria-label="Inspect full KSTL balance: 600,000.000000001 KSTL"]'));
    assert.doesNotMatch(document.body.textContent!, /600,000\.000000001 KSTL/);
    assert.match(document.body.textContent!, /1\u00a0base units/);
    assert.doesNotMatch(document.body.textContent!, /No fresh price/);
    assert.equal(document.querySelector('[data-workspace-portfolio="'+coinType("KSTL")+'"] [class*="figTop"]')?.textContent, "No price");
    assert.ok(!document.querySelector('[aria-label="Sell ZERO"]'));
    assert.ok(!document.querySelector('[aria-label="Sell ODD"]'));
    await page.click("Sell KSTL");
    const id = page.store.getSnapshot().visible_order[0]!;
    let panel = page.store.getSnapshot().panels[id]!;
    assert.equal(panel.coin.trade.side, "sell");
    assert.equal(panel.coin.trade.sell.typed, "");
    await act(async () => page.store.patchPanel(id, { coin: { ...panel.coin, trade: { ...panel.coin.trade, buy: { mode: "typed", typed: "100" }, sell: { mode: "typed", typed: "1.000000001" } }, tabs: { ...panel.coin.tabs, selected: "activity" } } }));
    await page.click("Sell KSTL");
    await act(async () => { page.store.setCapacity(1); page.store.add({ panel_id: "other", chain: "sui", network: "mainnet", coin_type: coinType("OTHER"), presale_id: null }); });
    assert.ok(page.store.getSnapshot().retained_order.includes(id));
    await page.click("Sell KSTL");
    assert.ok(page.store.getSnapshot().retained_order.includes("other"), "Focus preserves the displaced panel");
    assert.equal(document.querySelector('[aria-label="Replace which chart?"]') === null, true);
    panel = page.store.getSnapshot().panels[id]!;
    assert.equal(page.store.getSnapshot().visible_order[0], id);
    assert.equal(Object.values(page.store.getSnapshot().panels).filter(row => row.coin_type === panel.coin_type).length, 1);
    assert.equal(panel.coin.trade.buy.typed, "100");
    assert.equal(panel.coin.trade.sell.typed, "1.000000001");
    assert.equal(panel.coin.tabs.selected, "activity");
    assert.equal(document.activeElement?.getAttribute("data-panel-id"), id);
    assert.ok(page.requests.every(path => !path.includes("/quote") && !path.includes("/swap")));
  } finally { await page.dispose(); }
});

test("Portfolio presale controls and canonical Add restore without changing page preferences", async () => {
  const sale = `0x${"4".repeat(64)}`;
  const position = { presale: { presale_id: sale, symbol: "SALE", name: "Sale position", icon_url: "", status: "open", venue: "cetus", start_ms: 1, end_ms: Date.now() + 86400000, fill_pct: 10, quote_symbol: "USDC", quote_decimals: 6, launched_ms: null, first_unlock_ms: null }, status: "open", committed_usd: "123.45", committed_atoms: "123450001", claimed_tokens: null, refunded_usd: null, refunded_atoms: null, value_usd: null, multiple: null, basis_usd: null, basis_complete: true, pnl_usd: null, pnl_multiple: null };
  const page = await mounted(actor("A"), async (input) => {
    const path = String(input);
    if (path.includes("/me/presales")) return Response.json({ positions: [position], created: [], watchlist: [], coins: [], vestings: [] });
    if (path.includes("/home/coins")) return Response.json({
      coins: [{ ...fixtureMarket(0), presale_id: sale, coin_type: coinType("SALE"), symbol: "SALE", lifecycle: "open" }],
      missing: [], window: "24h", clock_ms: 1, as_of: { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 },
    });
    return portfolioReply(input);
  });
  try {
    await page.click("Portfolio presales section");
    assert.match(document.body.textContent!, /\$123 committed/);
    assert.ok(document.querySelector('[aria-label="Inspect full SALE exact commitment: 123.450001 USDC"]'));
    await page.click("Open SALE in Focus");
    const id = page.store.getSnapshot().visible_order[0]!;
    assert.equal(page.store.getSnapshot().panels[id]?.active_namespace, "presale");
    assert.equal(page.store.getSnapshot().panels[id]?.presale_id, sale);
    assert.ok(page.requests.some(path => path === "/api/social/me/presales?view=positions"));
    assert.equal(page.store.getSnapshot().data.controls.Portfolio.tab, "presales");
    assert.equal(window.location.search, "?tab=rewards");
  } finally { await page.dispose(); }
});

test("Portfolio saves a row anchor and mobile Sell uncovers its composer", async () => {
  const page = await mounted(actor("A"), async input => portfolioReply(input), true);
  try {
    await page.click("Portfolio coins section");
    const body = document.getElementById("workspace-data-panel")!;
    const row = document.querySelector<HTMLElement>("[data-workspace-portfolio]")!;
    row.getBoundingClientRect = () => ({ top: -8, bottom: 32, left: 0, right: 300, width: 300, height: 40, x: 0, y: -8, toJSON() {} });
    await act(async () => { body.scrollTop = 120; body.dispatchEvent(testEvent("scroll")); });
    assert.equal(page.store.getSnapshot().data.controls.Portfolio.navigation.anchor?.row_id, holdings[0]!.coin_type);
    assert.equal(page.store.getSnapshot().data.controls.Portfolio.navigation.scroll_top, 120);
    await page.click("Sell KSTL");
    assert.equal(page.store.getSnapshot().data.collapsed, true);
    assert.equal(page.store.getSnapshot().mobile_panel_id, page.store.getSnapshot().visible_order[0]);
    assert.ok(document.querySelector("[data-panel-id]"));
  } finally { await page.dispose(); }
});

test("Portfolio search, amount hiding and later refresh failure preserve honest loaded rows and setup-only persistence", async () => {
  const { setShellPref } = await import("#web/components/blast-ui/use-shell-prefs.ts");
  let fail = false;
  const page = await mounted(actor("A"), async input => fail && String(input).includes("/portfolio/coins") ? new Response(null, { status: 503 }) : portfolioReply(input));
  try {
    await page.click("Portfolio coins section");
    const input = document.querySelector<HTMLInputElement>('[aria-label="Search portfolio coins"]')!;
    await act(async () => { setInputValue(input, "KSTL"); input.dispatchEvent(testEvent("input")); }); await page.settle();
    assert.equal(page.store.getSnapshot().data.controls.Portfolio.coins.search, "KSTL");
    assert.equal(document.querySelectorAll("[data-workspace-portfolio]").length, 1);
    await act(async () => setShellPref("amountsHidden", true)); await page.settle();
    assert.doesNotMatch(document.body.textContent!, /600,000/);
    assert.ok(!document.querySelector('[aria-label*="600,000"]'));
    await act(async () => setShellPref("amountsHidden", false)); await page.settle();
    fail = true;
    await page.click("Refresh coins");
    assert.match(document.body.textContent!, /Showing the previous result/);
    assert.ok(document.querySelector('[aria-label="Inspect full KSTL balance: 600,000.000000001 KSTL"]'));
    const bytes = JSON.stringify(page.store.getSnapshot());
    assert.match(bytes, /KSTL/);
    assert.doesNotMatch(bytes, /600000000000001|value_usd|amountsHidden/);
    assert.equal(window.location.search, "?tab=rewards");
  } finally { setShellPref("amountsHidden", false); await page.dispose(); }
});

test("closing Data or hiding the document cancels Portfolio-owned reads and presentation refreshes", async () => {
  let reads = 0;
  const signals: (AbortSignal | null | undefined)[] = [];
  const page = await mounted(actor("A"), async (input, init) => {
    if (!String(input).includes("/portfolio")) return Response.json({});
    reads++; signals.push(init?.signal);
    return reads === 1 ? new Promise(() => {}) : Response.json(summary());
  });
  try {
    assert.equal(reads, 1);
    await act(async () => page.store.setDataCollapsed(true));
    assert.equal(signals[0]?.aborted, true);
    await act(async () => page.store.setDataCollapsed(false)); await page.settle();
    assert.equal(reads, 2);
    await act(async () => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" }); document.dispatchEvent(new window.Event("visibilitychange")); });
    await page.settle();
    assert.equal(reads, 2);
    await act(async () => { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); document.dispatchEvent(new window.Event("visibilitychange")); });
    await page.settle(); assert.equal(reads, 3);
  } finally { Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" }); await page.dispose(); }
});


test("Portfolio Sell reaches the existing renderer and a valid explicit final sale sends once and refreshes current private holdings", async () => {
  const sends: TradeSendInput[] = [];
  const wallet = {...fixtureWallet(),as_of_ms:Date.now()};
  const kit: TradeKit = {
    signedIn: true, signIn() {}, wallet: async () => wallet,
    quote: async request => ({ status: "ok", quote: fixtureTradeQuote(request, { signedIn: true, fee: "blast", nowMs: Date.now(), wallet }) }),
    send: async input => { sends.push(input); await refreshPortfolio!(); return { status: "traded", title: "Controlled sale settled. No chain transaction." }; },
  };
  assert.ok(wallet.address);
  const reply = walletReads(walletCoinViews(wallet), wallet.address).wrap(async input => {
    if (String(input).endsWith("/settings")) return Response.json({ privacy: "private", sharing_since_ms: null, commit_too_coin_type: null, blast_mode_confirm_actions: false, public_portfolio: false, explorer: "suiscan", sound: true, notifications: DEFAULT_NOTIFICATION_PREFERENCES });
    return portfolioReply(input);
  });
  const page = await mounted(actor("A"), reply, false, kit);
  const refreshPortfolio = () => invalidateAfter(page.client, { kind: "trade" });
  try {
    await page.click("Portfolio coins section");
    await page.click("Sell KSTL");
    assert.equal(sends.length, 0);
    const id = page.store.getSnapshot().visible_order[0]!;
    const panel = page.store.getSnapshot().panels[id]!;
    assert.equal(panel.coin.trade.sell.typed, "");
    await act(async () => page.store.patchPanel(id, { coin: { ...panel.coin, trade: { ...panel.coin.trade, sell: { mode: "typed", typed: "1.000000001" } } } }));
    await act(async () => new Promise(resolve => setTimeout(resolve, 450)));
    const submit = document.querySelector<HTMLButtonElement>("[data-coin-submit]")!;
    assert.ok(submit, "actual existing CoinPanel renderer is mounted");
    assert.equal(submit.disabled, false);
    const before = page.requests.filter(path => path.includes("/portfolio/coins")).length;
    await act(async () => { submit.click(); submit.click(); }); await page.settle();
    assert.equal(sends.length, 1);
    assert.equal(sends[0]!.quote.side, "sell");
    assert.equal(sends[0]!.quote.amount_in, "476190476666", "existing USD-denominated Sell model owns exact token conversion");
    assert.equal(sends[0]!.coins.in.symbol, "KSTL");
    assert.match(document.body.textContent!, /Controlled sale settled/);
    assert.ok(page.requests.filter(path => path.includes("/portfolio/coins")).length > before, "the visible lower portfolio refreshes after a completed trade");
    await page.openDataPortfolio();
    assert.ok(page.requests.filter(path => path.includes("/portfolio/coins")).length > before, "reopening invalidated holdings fetches a fresh balance");
    assert.equal(page.store.getSnapshot().panels[id]!.coin.trade.sell.typed, "", "a finished sale leaves an empty sell box (#1012)");
  } finally { await page.dispose(); }
});

test("Portfolio summary separates retryable read failure, confirmed zero, unknown value, syncing and stale balances", async () => {
  let state = "failed";
  const page = await mounted(actor("A"), async input => {
    if (!String(input).includes("/portfolio")) return Response.json({});
    if (state === "failed") return new Response(null, { status: 503 });
    const answer = { ...summary("0.00"), balances: { sui: { atoms: "0", usd: "0.00" }, usdc: { atoms: "0", usd: "0.00" } } };
    if (state === "unknown") return Response.json({ ...answer, balances: null, unavailable: ["balances"], wallet_sync: { status: "syncing", checkpoint: null, as_of_ms: null } });
    if (state === "stale") return Response.json({ ...answer, wallet_sync: { status: "stale", checkpoint: "1", as_of_ms: 1 } });
    return Response.json(answer);
  });
  try {
    assert.match(document.body.textContent!, /Your portfolio could not load/);
    assert.doesNotMatch(document.body.textContent!, /Portfolio value/);
    state = "zero"; await page.click("Retry portfolio");
    assert.match(document.querySelector('[aria-label="Portfolio summary"]')!.textContent!, /Portfolio value\s*\$0\.00/);
    state = "unknown"; await page.click("Refresh portfolio");
    assert.doesNotMatch(document.body.textContent!, /Value unavailable|Priced subtotal/);
    assert.doesNotMatch(document.body.textContent!, /Some portfolio data is unavailable/);
    assert.match(document.body.textContent!, /Wallet balances are syncing/);
    state = "stale"; await page.click("Refresh portfolio");
    assert.match(document.body.textContent!, /Wallet balances are delayed/);
  } finally { await page.dispose(); }
});

test("Portfolio navigation controls and row anchor round-trip without private holdings", async () => {
  const { encodeWorkspace, decodeWorkspace } = await import("@blast/core/modules/social/blast-workspace/codec.ts");
  const store = createWorkspaceStore();
  const controls = store.getSnapshot().data.controls.Portfolio;
  store.patchDataControls("Portfolio", { ...controls, tab: "presales", coins: { search: "KSTL", page: 2, hide_small: true }, presales: { search: "SALE", page: 3 }, navigation: { ...controls.navigation, scroll_top: 167, anchor: { row_id: "sale-position", index: 20, offset: -7 } } });
  const encoded = encodeWorkspace(store.getSnapshot());
  assert.equal(encoded.ok, true);
  if (!encoded.ok) return;
  const decoded = decodeWorkspace(encoded.bytes);
  assert.equal(decoded.ok, true);
  if (!decoded.ok) return;
  assert.deepEqual(decoded.workspace.data.controls.Portfolio, store.getSnapshot().data.controls.Portfolio);
  assert.doesNotMatch(encoded.bytes, /balance|value_usd|committed_atoms/);
});


test("quick Portfolio opens independently of data tabs and Buy switches an existing Sell draft", async () => {
  const page = await mounted(actor("A"), async input => portfolioReply(input));
  try {
    await act(async () => {
      page.store.setDataCollapsed(true);
      page.store.setDataViewEnabled("Portfolio", false);
      page.store.add({ panel_id: "held", chain: "sui", network: "mainnet", coin_type: coinType("KSTL"), presale_id: null });
      const panel = page.store.getSnapshot().panels.held!;
      page.store.patchPanel("held", { coin: { ...panel.coin, trade: { ...panel.coin.trade, side: "sell", buy: { mode: "typed", typed: "123.45" }, sell: { mode: "typed", typed: "1.000000001" } } } });
    });
    await page.openPortfolio();
    assert.ok(document.querySelector('[data-workspace-portfolio-drawer]'));
    assert.doesNotMatch(document.querySelector('[data-workspace-portfolio-drawer]')!.textContent!, /PnL|Unavailable/);
    await page.click("Buy KSTL");
    const current = page.store.getSnapshot();
    assert.equal(current.panels.held!.coin.trade.side, "buy");
    assert.equal(current.panels.held!.coin.trade.buy.typed, "123.45");
    assert.equal(current.panels.held!.coin.trade.sell.typed, "1.000000001");
    assert.equal(Object.values(current.panels).filter(p => p.coin_type === coinType("KSTL")).length, 1);
    assert.ok(!document.querySelector('[data-workspace-portfolio-drawer]'));
    assert.ok(page.requests.every(path => !path.includes("/quote") && !path.includes("/swap")));
  } finally { await page.dispose(); }
});

test("quick Portfolio shows compact signed PnL with exact inspectors and removes private values when hidden", async () => {
  const coin = { ...holdings[0]!, value_usd: "9007199254741993.01", basis_usd: "1000.00", basis_complete: true, pnl_usd: "9007199254740993.01", pnl_multiple: "90071992547410.9301" };
  const page = await mounted(actor("A"), async input => {
    const url = new URL(String(input), "https://blast.test");
    if (url.pathname.endsWith("/portfolio/coins")) return Response.json({ coins: [{ ...holdings[0]!, value_usd: coin.value_usd }], page: 1, page_size: 20, total: 1 });
    if (url.pathname.endsWith("/portfolio")) return Response.json({ ...summary(), coins: [coin] });
    return portfolioReply(input);
  });
  try {
    await page.openPortfolio();
    const drawer = document.querySelector('[data-workspace-portfolio-drawer]')!;
    const amount = drawer.querySelector<HTMLButtonElement>('[aria-label="Inspect full unrealized PnL amount: +$9,007,199,254,740,993.01"]');
    const percent = drawer.querySelector<HTMLButtonElement>('[aria-label="Inspect full unrealized PnL return: +9,007,199,254,740,993.01%"]');
    assert.equal(amount?.textContent, "+$9007.2T");
    assert.equal(percent?.textContent, "+9007.2T%");
    assert.equal(amount?.parentElement?.tagName, "SPAN");
    assert.equal(amount?.parentElement?.parentElement, percent?.parentElement?.parentElement, "inspectors stay inside the direct PnL grid spans");
    await act(async () => { document.querySelector('[data-blast-ui]')!.setAttribute("data-amounts", "hidden"); notifyShellPrefs(); });
    assert.equal(drawer.querySelector('[aria-label*="Inspect full unrealized PnL"]'), null);
    assert.doesNotMatch(drawer.textContent!, /9007\.2|9,007,199/);
    await act(async () => { document.querySelector('[data-blast-ui]')!.setAttribute("data-amounts", "shown"); notifyShellPrefs(); });
    assert.ok(drawer.querySelector('[aria-label="Inspect full unrealized PnL amount: +$9,007,199,254,740,993.01"]'));
  } finally { await page.dispose(); }
});

test("open quick Portfolio removes a former actor's private rows on sign-out", async () => {
  const page = await mounted(actor("A"), async input => portfolioReply(input));
  try {
    await page.openPortfolio();
    assert.match(document.querySelector('[data-workspace-portfolio-drawer]')!.textContent!, /600,000/);
    await page.identity(guest);
    assert.match(document.querySelector('[data-workspace-portfolio-drawer]')!.textContent!, /Sign in to see your portfolio/);
    assert.doesNotMatch(document.querySelector('[data-workspace-portfolio-drawer]')!.textContent!, /600,000|Buy/);
  } finally { await page.dispose(); }
});

test("single-page holdings show only a count while multiple pages retain functional navigation", async () => {
  let total = 3;
  const page = await mounted(actor("A"), async input => {
    const url = new URL(String(input), "https://blast.test");
    if (!url.pathname.endsWith("/portfolio/coins")) return portfolioReply(input);
    const current = Number(url.searchParams.get("page") ?? "1");
    const rows = total === 3 ? holdings : Array.from({ length: total }, (_, index) => ({ ...holdings[0]!, coin_type: coinType(`TEST${index}`), symbol: `TEST${index}` }));
    return Response.json({ coins: rows.slice((current - 1) * 20, current * 20), page: current, page_size: 20, total });
  });
  try {
    await page.openPortfolio();
    const drawer = document.querySelector('[data-workspace-portfolio-drawer]')!;
    assert.match(drawer.textContent!, /3 holdings/);
    assert.equal(drawer.querySelector('[aria-label="Previous coin page"]'), null);
    assert.equal(drawer.querySelector('[aria-label="Next coin page"]'), null);
    total = 21;
    await page.click("Refresh coins");
    assert.match(drawer.textContent!, /Page 1 of 2 · 21 coins/);
    assert.equal(drawer.querySelector<HTMLButtonElement>('[aria-label="Previous coin page"]')!.disabled, true);
    await page.click("Next coin page");
    assert.match(drawer.textContent!, /Page 2 of 2 · 21 coins/);
    assert.equal(drawer.querySelector<HTMLButtonElement>('[aria-label="Next coin page"]')!.disabled, true);
    await page.click("Previous coin page");
    assert.match(drawer.textContent!, /Page 1 of 2 · 21 coins/);
  } finally { await page.dispose(); }
});


test("portfolio separates sub-cent, zero and missing USD marks with exact inspectors", async () => {
  const page = await mounted(actor("A"), async input => {
    if (String(input).includes("/portfolio/coins")) return Response.json({
      coins: [
        { ...holdings[0], value_usd: "0.00", value_usd_exact: "0.00000000000000000001" },
        holdings[1], holdings[2],
      ], page: 1, page_size: 20, total: 3,
    });
    return portfolioReply(input);
  });
  try {
    await page.click("Portfolio coins section");
    const rows = [...document.querySelectorAll("[data-workspace-portfolio]")];
    assert.match(rows[0]!.textContent!, /<\$0\.01/);
    assert.ok(rows[0]!.querySelector('[aria-label="Inspect full KSTL USD value: $0.00000000000000000001"]'));
    assert.match(rows[1]!.textContent!, /\$0\.00/);
    assert.doesNotMatch(rows[2]!.textContent!, /No fresh price|Unavailable/);
    assert.equal(rows[2]!.querySelector('[aria-label*="USD value"]'), null);
  } finally { await page.dispose(); }
});

test("Blast Portfolio separates an unpriced total from the priced subtotal", async () => {
  const page = await mounted(actor("A"), async () => Response.json({ ...summary(), coin_summary: { value_usd: null, known_value_usd: "0.00", today: null } }));
  try {
    const card = document.querySelector('[aria-label="Portfolio summary"]')!;
    assert.doesNotMatch(card.textContent!, /Value unavailable|Priced subtotal/);
    assert.match(card.textContent!, /Portfolio value\$100\.00/);
    assert.match(card.textContent!, /Some assets have no price/);
  } finally { await page.dispose(); }
});

test("Blast Portfolio includes known commitment and refund components in an incomplete summary", async () => {
  const data = summary();
  const page = await mounted(actor("A"), async () => Response.json({ ...data,
    balances: { sui: { atoms: "0", usd: "0.00" }, usdc: { atoms: "0", usd: "0.00" } },
    commitments: { committed_usd: null, claimable_usd: null, known_committed_usd: "100.00", known_claimable_usd: "5.00" },
  }));
  try {
    const card = document.querySelector('[aria-label="Portfolio summary"]')!;
    assert.doesNotMatch(card.textContent!, /Value unavailable|Priced subtotal/);
    assert.match(card.textContent!, /Portfolio value\$105\.00/);
    assert.match(card.textContent!, /Some assets have no price/);
    // F35: the tiles write cents as the top bar's balance does, and the marker is whole on its own line.
    const tiles = [...card.querySelectorAll("dl > div")].map((tile) => [tile.querySelector("dt")!.textContent, tile.querySelector("dd")!.textContent]);
    assert.deepEqual(tiles.find(([label]) => label === "In presales"), ["In presales", "$100.00"]);
    assert.ok(tiles.every(([, value]) => !/\+$/.test(value!)), "no stray plus");
  } finally { await page.dispose(); }
});


test("Portfolio distinguishes unsupported, pending and failed eligibility; retry never flashes unsupported", async () => {
  let state = "failed";
  let finish: ((response: Response) => void) | undefined;
  const page = await mounted(actor("A"), async input => {
    if (String(input).includes("/trades/coins") && new URL(String(input), "https://blast.test").searchParams.get("q") === coinType("KSTL")) {
      if (state === "failed") return new Response(null, { status: 503 });
      if (state === "pending") return new Promise(resolve => { finish = resolve; });
    }
    return portfolioReply(input);
  });
  try {
    await page.openPortfolio();
    const row = () => document.querySelector(`[data-workspace-portfolio="${coinType("KSTL")}"]`)!;
    assert.match(row().textContent!, /Couldn't check trading/);
    assert.doesNotMatch(row().textContent!, /Not available on Blast|route or metadata/);
    assert.ok(!row().querySelector('[aria-label="Sell KSTL"]'));
    const odd = document.querySelector(`[data-workspace-portfolio="${coinType("ODD")}"]`)!;
    assert.match(odd.textContent!, /Not available on Blast/);
    state = "pending";
    await page.click("Retry KSTL availability");
    assert.ok(row().querySelector('[aria-label="Checking KSTL trading availability"]'));
    assert.doesNotMatch(row().textContent!, /Not available on Blast|Couldn't check trading/);
    await act(async () => finish!(portfolioReply(`/api/social/trades/coins?q=${encodeURIComponent(coinType("KSTL"))}`)));
    await page.settle();
    assert.ok(row().querySelector('[aria-label="Buy KSTL"]'));
    assert.ok(row().querySelector('[aria-label="Sell KSTL"]'));
    state = "failed";
    await page.click("Refresh coins");
    assert.match(row().textContent!, /Couldn't check trading/);
    assert.ok(!row().querySelector('[aria-label="Sell KSTL"]'), "a failed refresh cannot reuse stale eligibility");
  } finally { await page.dispose(); }
});

test("zero supported holdings offer Buy and disabled Sell without redundant Not held copy", async () => {
  const page = await mounted(actor("A"), async input => {
    const url = new URL(String(input), "https://blast.test");
    if (url.pathname.endsWith("/trades/coins") && url.searchParams.get("q") === coinType("ZERO"))
      return Response.json({ coins: [tradeCoin(holdings[1]!, "1")], next_cursor: null });
    return portfolioReply(input);
  });
  try {
    await page.openPortfolio();
    const row = document.querySelector(`[data-workspace-portfolio="${coinType("ZERO")}"]`)!;
    assert.equal(row.querySelector('[aria-label="Buy ZERO"]')?.textContent, "Buy");
    const sell = row.querySelector<HTMLButtonElement>('[aria-label="Sell ZERO"]');
    assert.ok(sell);
    assert.equal(sell.disabled, true);
    const before = page.store.getSnapshot();
    await act(async () => sell.click());
    assert.equal(page.store.getSnapshot(), before, "disabled Sell cannot open a trade");
    assert.doesNotMatch(row.textContent!, /Not held|Not available on Blast|route or metadata/);
  } finally { await page.dispose(); }
});
