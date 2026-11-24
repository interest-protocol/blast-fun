import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { SocialViewerProvider } from "#web/components/social/SignInGate.tsx";
import { walletCoinViews } from "#web/components/social/coins/coin-model.ts";
import { ACCESS_TOKEN, walletReads } from "../../../../../../test/fixtures/social/commit/wallet-reads.ts";
import { fixtureCoinType, fixtureWallet } from "../../../../../../test/fixtures/social/trade/trade-fixtures.ts";
import { handClock } from "../../../../../../test/fixtures/workspace/live-clock";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { createWorkspaceStore } from "../model";
import { WorkspaceLiveProvider } from "../live-clock";
import { createPanelIdentities, PanelIdentitiesContext } from "../panel-identities";
import { CoinPanel, type CoinPanelProps } from "./CoinPanel";
import { ChartState } from "./ChartState";
import { CoinPriceWindow } from "./CoinChart";
import { FlowCard } from "./FlowCard";

/**
 * Blast mode experience audit, pass B (28 Oct 2026): the ticket's quote and action states, the
 * chart header's reserved slots, one Overlays control, honest chart empty states, a compact
 * sparse Flow, and a coin switch that never shows an older coin's answer.
 */

function mountDom() {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', { url: "https://blast.test", pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
  return dom;
}
const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
const text = (selector: string) => document.querySelector<HTMLElement>(selector)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
const coinRecord = (coinType: string, symbol: string, overrides: Record<string, unknown> = {}) => ({ coin_type: coinType, symbol, name: `${symbol} coin`, decimals: 9, price_usd: "0.0021", ...overrides });

test("a quote that never answers reads as unavailable beside the amount, with Retry, and the action names what it needs", async (t) => {
  const wallet = fixtureWallet();
  assert.ok(wallet.address);
  t.mock.method(globalThis, "fetch", walletReads(walletCoinViews(wallet), wallet.address).wrap(globalThis.fetch));
  const dom = mountDom();
  const client = createTestQueryClient();
  const time = handClock(1_800_000_000_000);
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", chain: "sui", network: "mainnet", coin_type: fixtureCoinType("KSTL"), presale_id: null });
  const panel = store.getSnapshot().panels.A!;
  store.patchPanel("A", { coin: { ...panel.coin, trade: { ...panel.coin.trade, buy: { typed: "100", mode: "typed" } } } });
  let asked = 0;
  const kit: NonNullable<CoinPanelProps["actions"]["trade"]> = {
    signedIn: true, signIn() {},
    wallet: async () => fixtureWallet(),
    quote: (_request, signal) => { asked++; return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true })); },
    send: async () => { throw new Error("no sends in this test"); },
  };
  const reads: CoinPanelProps["reads"] = { coin: async () => coinRecord(panel.coin_type, "KSTL"), chart: async () => null, holders: async () => null, activity: async () => null };
  function Subject() {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const current = snapshot.panels.A!;
    return <QueryProvider client={client}><SocialViewerProvider signedIn getAccessToken={ACCESS_TOKEN}><WorkspaceLiveProvider clock={time.clock}>
      <CoinPanel panel_id="A" asset={current} coin_setup={current.coin} onSetupChange={(coin) => store.patchPanel("A", { coin })} effective_visibility
        actions={{ trade: kit, authenticated: true, confirmation: { status: "ready", enabled: false }, actor_key: "account:A", signIn() {} }} reads={reads} />
    </WorkspaceLiveProvider></SocialViewerProvider></QueryProvider>;
  }
  const root = createRoot(document.getElementById("mount")!);
  const action = () => document.querySelector<HTMLButtonElement>("[data-coin-submit]")!;
  try {
    await act(async () => root.render(<Subject />));
    await settle();
    await act(async () => time.advance(1_000));
    await settle();
    assert.ok(asked >= 1, "the typed amount asks for a quote");
    assert.match(document.body.textContent!, /Getting a quote…/);
    assert.equal(action().textContent, "Getting a quote…");
    assert.equal(action().disabled, true);
    assert.equal(document.querySelector('[role="status"][aria-label="Getting a current quote"]'), null, "no spinner at the card's lower left");
    await act(async () => time.advance(8_000));
    await settle();
    assert.match(document.body.textContent!, /No answer yet/);
    assert.equal(action().textContent, "Quote unavailable");
    const before = asked;
    const retry = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Trade"] button')].find((button) => button.textContent === "Retry")!;
    await act(async () => retry.click());
    await settle();
    await act(async () => time.advance(1_000));
    await settle();
    assert.ok(asked > before, "Retry asks again");
    assert.match(document.body.textContent!, /Getting a quote…/);
    await act(async () => store.patchPanel("A", { coin: { ...store.getSnapshot().panels.A!.coin, trade: { ...store.getSnapshot().panels.A!.coin.trade, buy: { typed: "", mode: "typed" } } } }));
    await settle();
    assert.equal(action().textContent, "Enter an amount", "an empty ticket says what it needs");
    assert.doesNotMatch(document.body.textContent!, /Getting a quote|Quote unavailable/, "idle input shows no quote status");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    dom.window.close();
  }
});

test("a coin no source has a record of keeps its saved setup until the person picks Show SUI or Remove", async () => {
  const dom = mountDom();
  const client = createTestQueryClient();
  const reads: CoinPanelProps["reads"] = { coin: async () => null, chart: async () => null, holders: async () => null, activity: async () => null };
  const store = createWorkspaceStore();
  store.add({ panel_id: "B", chain: "sui", network: "mainnet", coin_type: fixtureCoinType("LIVE"), presale_id: null });
  store.add({ panel_id: "A", chain: "sui", network: "mainnet", coin_type: fixtureCoinType("PS1"), presale_id: null });
  const saved = store.getSnapshot();
  const slot = saved.desktop_slots!.indexOf("A");
  const panel = saved.panels.A!;
  const root = createRoot(document.getElementById("mount")!);
  const button = (label: string) => [...document.querySelectorAll("button")].find((each) => each.textContent === label);
  const render = (id: string, onRemove: () => void) => act(async () => root.render(<QueryProvider client={client}>
    <CoinPanel focus panel_id={id} asset={store.getSnapshot().panels[id]!} coin_setup={panel.coin} onSetupChange={() => {}} effective_visibility actions={{ trade: null, authenticated: false, actor_key: "guest", signIn() {} }} reads={reads} onShowSui={() => store.showSui(id)} onRemove={onRemove} />
  </QueryProvider>));
  try {
    await render("A", () => store.remove("A"));
    await settle();
    assert.match(document.body.textContent!, /No source has a record of this coin right now(?!\.)/);
    assert.equal(store.getSnapshot(), saved, "a miss alone never rewrites the saved workspace");
    await act(async () => button("Show SUI")!.click());
    assert.equal(store.getSnapshot().panels.A?.coin_type, SUI_COIN_TYPE);
    assert.equal(store.getSnapshot().desktop_slots!.indexOf("A"), slot, "the panel keeps its slot");
    assert.equal(store.getSnapshot().panels.B?.coin_type, fixtureCoinType("LIVE"), "other panels are untouched");
    store.add({ panel_id: "C", chain: "sui", network: "mainnet", coin_type: fixtureCoinType("PS2"), presale_id: null });
    await render("C", () => store.remove("C"));
    await settle();
    await act(async () => button("Remove")!.click());
    assert.equal(store.getSnapshot().panels.C, undefined, "Remove drops only that panel");
    assert.equal(store.getSnapshot().panels.A?.coin_type, SUI_COIN_TYPE);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    dom.window.close();
  }
});

test("the chart header keeps its identity, price and fact slots while loading and when figures are unknown, with one Overlays control", async () => {
  const dom = mountDom();
  const client = createTestQueryClient();
  const coinType = fixtureCoinType("WL20");
  const identities = createPanelIdentities();
  identities.report(coinType, { symbol: "WL20", icon: null, name: "Whitelist 20 Test" });
  let resolve: ((value: ReturnType<typeof coinRecord>) => void) | null = null;
  const reads: CoinPanelProps["reads"] = {
    coin: () => new Promise((done) => { resolve = done; }),
    chart: async () => null, holders: async () => null, activity: async () => null,
  };
  const asset = { chain: "sui", network: "mainnet", coin_type: coinType, presale_id: null } as const;
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", ...asset });
  const panel = store.getSnapshot().panels.A!;
  const root = createRoot(document.getElementById("mount")!);
  const facts = () => [...document.querySelectorAll('[aria-label="Selected market facts"] dt')].map((term) => term.textContent);
  try {
    await act(async () => root.render(<QueryProvider client={client}><PanelIdentitiesContext value={identities}>
      <CoinPanel focus panel_id="A" asset={panel} coin_setup={panel.coin} onSetupChange={() => {}} effective_visibility actions={{ trade: null, authenticated: false, actor_key: "guest", signIn() {} }} reads={reads} />
    </PanelIdentitiesContext></QueryProvider>));
    await settle();
    assert.match(text('[data-board-head]'), /WL20/, "the known identity shows at once");
    assert.match(text('[data-board-head]'), /Whitelist 20 Test/);
    assert.doesNotMatch(text('[data-board-head]'), /Checking/);
    assert.deepEqual(facts(), ["24h volume", "FDV", "Holders"], "the facts' slots are reserved while loading");
    await act(async () => resolve!(coinRecord(coinType, "WL20", { name: "Whitelist 20 Test", price_usd: null, fdv_usd: null, holders: null })));
    await settle();
    assert.deepEqual(facts(), ["24h volume", "FDV", "Holders"], "unknown figures keep their slots");
    assert.equal(document.querySelectorAll('[aria-label="Selected market facts"] dd').length, 3);
    assert.match(text('[aria-label="Market price"]'), /No USD price yet/, "the price slot stays, as a dash");
    assert.ok(document.querySelector('button[aria-label="Chart overlays"]'), "one Overlays control");
    assert.doesNotMatch(document.body.textContent!, /Show people|On chart/, "Show people and the On chart chips are gone");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    dom.window.close();
  }
});

test("chart empty states tell empty data from a failed read and offer one action; unavailable Candles and Volume explain themselves", async () => {
  const dom = mountDom();
  const root = createRoot(document.getElementById("mount")!);
  const buttons = () => [...document.querySelectorAll("button")].map((button) => button.textContent);
  try {
    await act(async () => root.render(<ChartState state="empty" onAll={() => {}} retry={() => {}} />));
    assert.deepEqual(buttons(), ["View all history"], "empty data offers a longer range, not a retry");
    assert.match(document.body.textContent!, /No recorded prices in this range/);
    await act(async () => root.render(<ChartState state="error" retry={() => {}} />));
    assert.deepEqual(buttons(), ["Retry"]);
    assert.ok(document.querySelector('[data-chart-empty="error"] [role="alert"]'));
    assert.match(document.body.textContent!, /Price history could not load/);
    await act(async () => root.render(<ChartState state="empty" />));
    assert.deepEqual(buttons(), [], "nothing to offer, nothing drawn");
    await act(async () => root.render(<CoinPriceWindow chart={{ renderer: "recharts", window: "24h", viewport: null }} history={null} onChart={() => {}} />));
    const candles = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Candles")!;
    assert.equal(candles.hasAttribute("data-unavailable"), true, "drawn as unavailable");
    assert.equal(candles.disabled, false, "it stays focusable and explains itself when pressed");
    assert.match(document.getElementById(candles.getAttribute("aria-describedby")!)?.textContent ?? "", /Candles need recorded swaps/);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("a coin with no trades in any window shows one compact Flow line", async () => {
  const dom = mountDom();
  const coinType = fixtureCoinType("WL20");
  const now = Date.now();
  const quietWindow = { from_ms: now - 3_600_000, to_ms: now, open_usd: null, open_as_of_ms: null, change_bps: null, change_usd: null, buys: 0, sells: 0, bought_atoms: "0", sold_atoms: "0", bought_usd: null, sold_usd: null, unpriced_buys: 0, unpriced_sells: 0, buyers: 0, sellers: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ coin_type: coinType, presale_id: null, decimals: 9, quote: { type: "0x2::sui::SUI", symbol: "SUI", decimals: 9 }, clock_ms: now, price_usd: null, price_as_of_ms: null, windows: { "5m": quietWindow, "1h": quietWindow, "4h": quietWindow, "24h": quietWindow }, supply: null, fdv_usd: null, market_cap_usd: null, pool: null, liquidity_usd: null, as_of: { checkpoint: 1, timestamp_ms: now, lag_ms: 0 } });
  const root = createRoot(document.getElementById("mount")!);
  try {
    await act(async () => root.render(<FlowCard asset={{ chain: "sui", network: "mainnet", coin_type: coinType, presale_id: null }} coin={null} visible />));
    await settle();
    await settle();
    assert.match(text('[aria-label="Flow"]'), /All venues · 1d[\s\S]*No trades in the last day/);
    assert.equal(document.querySelector('[aria-label="Flow"] [role="group"][aria-label="Window"]'), null, "no empty window tiles or bars");
    assert.match(text('[aria-label="Flow"] header'), /All venues · 1d/, "the heading names the period the empty line states (BM-07)");
  } finally {
    globalThis.fetch = original;
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("switching A → B → C never shows a late answer for A or B under C", async () => {
  const dom = mountDom();
  const client = createTestQueryClient();
  const late = new Map<string, (value: ReturnType<typeof coinRecord>) => void>();
  const reads: CoinPanelProps["reads"] = {
    coin: (asset) => asset.coin_type.endsWith("::CCC") ? Promise.resolve(coinRecord(asset.coin_type, "CCC")) : new Promise((done) => { late.set(asset.coin_type, done); }),
    chart: async () => null, holders: async () => null, activity: async () => null,
  };
  const root = createRoot(document.getElementById("mount")!);
  const render = (symbol: string) => {
    const asset = { chain: "sui", network: "mainnet", coin_type: fixtureCoinType(symbol), presale_id: null } as const;
    const store = createWorkspaceStore();
    store.add({ panel_id: "A", ...asset });
    const panel = store.getSnapshot().panels.A!;
    return <QueryProvider client={client}><CoinPanel focus panel_id="A" asset={panel} coin_setup={panel.coin} onSetupChange={() => {}} effective_visibility actions={{ trade: null, authenticated: false, actor_key: "guest", signIn() {} }} reads={reads} /></QueryProvider>;
  };
  try {
    await act(async () => root.render(render("AAA")));
    await act(async () => root.render(render("BBB")));
    await act(async () => root.render(render("CCC")));
    await settle();
    assert.match(text('[data-board-head]'), /CCC/);
    for (const [coinType, done] of late) await act(async () => done(coinRecord(coinType, coinType.endsWith("::AAA") ? "AAA" : "BBB", { price_usd: "9.99" })));
    await settle();
    assert.match(text('[data-board-head]'), /CCC/, "C keeps its own identity");
    assert.doesNotMatch(text('[data-board-head]'), /AAA|BBB|9\.99/, "no late answer for A or B lands under C");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    dom.window.close();
  }
});
