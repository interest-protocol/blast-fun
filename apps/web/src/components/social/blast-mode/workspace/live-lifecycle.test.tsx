import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import { createCommitQuotes } from "#web/components/social/commit/commit-quote.ts";
import { fixtureWallet } from "../../../../../test/fixtures/social/trade/trade-fixtures.ts";
import { liveStore, liveResponse } from "../../../../../test/fixtures/workspace/live-fixtures.ts";
import { HOLDERS } from "../../../../../test/fixtures/workspace/parity-fixtures.ts";
import { proofMarket } from "../../../../../test/fixtures/workspace/redesign-fixtures.ts";
import { handClock } from "../../../../../test/fixtures/workspace/live-clock.ts";
import { WorkspaceLiveProvider } from "./live-clock";
import { createCoinReads } from "./panels/coin-reads";
import { createPresaleReads } from "./panels/presale-reads";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import type { CommitFacts } from "#web/components/social/commit/commit-kit.ts";

test("one active client among four tracked and 31 retained records obeys desktop, mobile, Data, document and mode lifetimes", async () => {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', { url: "https://blast.test", pretendToBeVisual: true });
  Object.assign(globalThis, {
    window: dom.window,
    // Next's Link (the presale sale page link) schedules prefetch work on `self`.
    self: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle,
    CSS: { escape: (value: string) => value },
    MutationObserver: dom.window.MutationObserver,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    AbortController: dom.window.AbortController,
    AbortSignal: dom.window.AbortSignal,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(dom.window, "innerWidth", { configurable: true, value: 1414 });
  Object.defineProperty(dom.window, "innerHeight", { configurable: true, value: 1120 });
  let mobile = false;
  const mediaListeners = new Set<() => void>();
  dom.window.matchMedia = () => ({ get matches() { return mobile; }, addEventListener: (_: string, listener: () => void) => mediaListeners.add(listener), removeEventListener: (_: string, listener: () => void) => mediaListeners.delete(listener) }) as unknown as MediaQueryList;
  dom.window.scrollTo = () => {};
  dom.window.HTMLElement.prototype.scrollTo = () => {};
  dom.window.HTMLElement.prototype.getAnimations = () => [];
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  dom.window.HTMLElement.prototype.animate = () => {
    const animation = { cancel() {}, onfinish: null as null | (() => void) };
    queueMicrotask(() => animation.onfinish?.());
    return animation as unknown as Animation;
  };
  // Base UI portals choose their browser environment when imported.
  const { WorkspaceHost } = await import("./WorkspaceHost");
  const { useWorkspace } = await import("./workspace-context");
  const { CoinsData } = await import("./CoinsData");
  const { CoinPanel } = await import("./panels/CoinPanel");
  const { PresalePanel } = await import("./panels/PresalePanel");
  const intervals = new Set<number>();
  let intervalId = 0;
  dom.window.setInterval = (() => { const id = ++intervalId; intervals.add(id); return id; }) as unknown as typeof window.setInterval;
  dom.window.clearInterval = (id) => { if (id !== undefined) intervals.delete(id); };
  const time = handClock();
  const store = liveStore();
  for (const id of ["C1", "C2"]) { const panel = store.getSnapshot().panels[id]!; store.patchPanel(id, { coin: { ...panel.coin, trade: { ...panel.coin.trade, buy: { typed: "", mode: "typed" } } } }); }
  const requests: string[] = [];
  let hold = "";
  let fail = "";
  const releases: (() => void)[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    requests.push(path);
    const url = new URL(path, "https://blast.test");
    const coinType = url.searchParams.get("coin");
    if (coinType && url.pathname === "/api/social/home/market") return Response.json(proofMarket(coinType));
    if (coinType && url.pathname === "/api/social/home/holders") return Response.json({ ...HOLDERS, coin_type: coinType });
    const response = liveResponse(path, init?.body ? JSON.parse(String(init.body)) : {});
    if (hold && path.includes(hold)) await new Promise<void>((resolve) => releases.push(resolve));
    return fail && path.includes(fail) ? new Response(null, { status: 503 }) : response;
  };
  const client = createTestQueryClient();
  const quotes = createCommitQuotes<CommitFacts>({ client, read: async (id) => (await fetch(`/kit/commit-facts?presale=${id}`)).json() });
  const commit = { signedIn: true, signIn() {}, deposit() {}, quotes, quotePayment: async () => ({ status: "error" as const }), send: async () => { throw new Error("No implicit submit"); } };
  const trade = { signedIn: true, signIn() {}, wallet: async () => { requests.push("/kit/wallet"); return fixtureWallet(); }, quote: async () => ({ status: "error" as const }), send: async () => { throw new Error("No implicit submit"); } };
  const coinReads = createCoinReads();
  const presaleReads = createPresaleReads(async () => "fixture");
  const actions = { authenticated: true, actor_key: "account:fixture", confirmation: { status: "ready" as const, enabled: false }, signIn() {} };
  function Panel({ panel }: Readonly<{ panel: PanelSetup }>) {
    const { dispatch, presentation } = useWorkspace();
    const visible = presentation.visible_panel_ids.includes(panel.panel_id) && presentation.document_visible;
    return panel.active_namespace === "presale" ? <PresalePanel panel_id={panel.panel_id} asset={panel} presale_setup={panel.presale} onSetupChange={(presale) => dispatch.patchPanel(panel.panel_id, { presale })} effective_visibility={visible} actions={{ ...actions, commit }} reads={presaleReads} /> : <CoinPanel panel_id={panel.panel_id} asset={panel} coin_setup={panel.coin} onSetupChange={(coin) => dispatch.patchPanel(panel.panel_id, { coin })} effective_visibility={visible} actions={{ ...actions, trade }} reads={coinReads} />;
  }
  const router = { bfcacheId: "test", push() {}, replace() {}, prefetch() {}, back() {}, forward() {}, refresh() {}, hmrRefresh() {} };
  const root = createRoot(document.getElementById("mount")!);
  const owner = async () => ({ kind: "account" as const, account_id: "fixture", store });
  const render = async (open: boolean) => act(async () => root.render(<AppRouterContext value={router}><QueryProvider client={client}><WorkspaceLiveProvider clock={time.clock}>{open && <WorkspaceHost resolveOwner={owner} ownerKey="fixture" entryGeneration={1} onExit={() => {}} slots={{ panel: Panel, data: { Coins: CoinsData } }} />}</WorkspaceLiveProvider></QueryProvider></AppRouterContext>));
  const settle = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
  const advance = async () => { await act(async () => time.advance(15_000)); await settle(); };
  const visibility = async (shown: boolean) => { await act(async () => { Object.defineProperty(document, "visibilityState", { configurable: true, value: shown ? "visible" : "hidden" }); document.dispatchEvent(new dom.window.Event("visibilitychange")); }); await settle(); };
  try {
    await render(true); await settle();
    assert.equal(store.getSnapshot().retained_order.length, 31);
    assert.equal(document.querySelectorAll("[data-coin-panel], [data-presale-panel]").length, 4);
    requests.length = 0;
    await advance();
    assert.equal(requests.length, 7, "only the selected coin owns identity, execution candles, market candles/status, fallback prices, its Flow market and its holders");
    assert.equal(requests.filter((path) => path === "/kit/wallet").length, 0, "the wallet waits its minute");
    assert.equal(requests.filter((path) => path.startsWith("/api/social/home/market?")).length, 1, "the Flow card reads the selected coin's market");
    assert.equal(requests.filter((path) => path.startsWith("/api/social/home/holders?")).length, 1, "the default Holders view reads the selected coin's holders");
    assert.equal(requests.filter((path) => path.includes("format=ohlcv")).length, 1);
    assert.equal(requests.filter((path) => path.startsWith("/api/launchpad/market/coins/") && path.includes("/candles?")).length, 1);
    assert.equal(requests.filter((path) => path === "/api/launchpad/market/status").length, 1);
    assert.ok(requests.every((path) => !path.includes("retained")));
    assert.equal(requests.filter((path) => path.includes("prices")).length, 2);
    assert.ok(requests.every((path) => !path.includes("holder_limit") && !path.includes("home/activity")), "inactive content reads are absent");
    await act(async () => {
      Object.defineProperty(dom.window, "innerHeight", { configurable: true, value: 600 });
      dom.window.dispatchEvent(new dom.window.Event("resize"));
    }); await settle();
    requests.length = 0; await advance();
    assert.equal(requests.length, 7, "height changes preserve the single live owner");
    assert.equal(document.querySelectorAll("[data-coin-panel], [data-presale-panel]").length, 4, "one-coin presentation preserves every mounted controller");
    await act(async () => store.focus("P1")); await settle();
    requests.length = 0; await advance();
    assert.equal(requests.length, 3, "changing the selected coin transfers reads without duplicating them");
    assert.ok(requests.every(path => !path.includes("/prices") && path !== "/kit/wallet"), "hidden coins own no financial reads");
    await act(async () => {
      Object.defineProperty(dom.window, "innerHeight", { configurable: true, value: 1120 });
      dom.window.dispatchEvent(new dom.window.Event("resize"));
    }); await settle();
    await act(async () => { store.focus("C2"); const panel = store.getSnapshot().panels.C2!; store.patchPanel("C2", { coin: { ...panel.coin, tabs: { ...panel.coin.tabs, selected: "activity" } } }); }); await settle();
    requests.length = 0; await advance();
    assert.equal(requests.filter((path) => path.includes("prices")).length, 2);
    assert.equal(requests.filter((path) => path.includes("home/activity")).length, 1, "the selected coin reads its chart and activity together");
    assert.ok(requests.every((path) => !path.includes("holder_limit")), "Blast mode never reads holders");
    await act(async () => { mobile = true; for (const listener of mediaListeners) listener(); }); await settle();
    requests.length = 0; await advance();
    assert.equal(requests.length, 8, "only the selected mobile coin owns execution candles, market candles/status, fallback prices, activity, identity, Flow market and Theses count reads; the wallet waits its minute");
    assert.ok(requests.every((path) => !path.includes("presales/") && !path.includes("commit-facts")));
    await act(async () => store.selectMobile("P1")); await settle();
    requests.length = 0; await advance();
    assert.equal(requests.length, 3, "mobile selection transfers the complete live owner");
    assert.equal(requests.filter((path) => path === "/kit/wallet").length, 0);
    const discover = document.querySelector<HTMLButtonElement>('button[aria-label="Search coins and presales"]');
    assert.ok(discover);
    await act(async () => discover.click()); await settle();
    assert.equal(intervals.size, 1, "only shown Coins Data owns its discovery subscription");
    requests.length = 0; await advance();
    assert.equal(requests.length, 0, "Data covers every panel on mobile");
    assert.equal(time.timers.size, 0);
    await visibility(false);
    assert.equal(intervals.size, 0);
    requests.length = 0; await advance(); assert.equal(requests.length, 0);
    await visibility(true);
    assert.equal(intervals.size, 1);
    await act(async () => store.setDataCollapsed(true)); await settle();
    assert.equal(intervals.size, 0);
    // A transport that answers after unmount cannot reactivate the old owner.
    hold = "/presales/";
    await advance();
    await visibility(false);
    hold = "";
    await act(async () => { for (const release of releases.splice(0)) release(); });
    assert.equal(time.timers.size, 0);
    await visibility(true);
    for (let i = 0; i < 3; i++) {
      await render(false); await settle();
      assert.equal(time.timers.size, 0);
      assert.equal(intervals.size, 0);
      requests.length = 0; await advance(); assert.equal(requests.length, 0);
      await render(true); await settle();
      assert.equal(time.timers.size, 3, "re-entry has exactly one timer per active presale read");
    }
    await act(async () => store.selectMobile("C1")); await settle();
    fail = "/prices";
    await advance();
    assert.match(document.body.textContent!, /Price history could not load|Chart unavailable|Chart could not load/i);
    assert.equal(Object.keys(store.getSnapshot().panels).length, 35);
    assert.equal(store.getSnapshot().panels.C1!.coin.trade.buy.typed, "");
  } finally {
    for (const release of releases.splice(0)) release();
    await render(false);
    await act(async () => root.unmount());
    assert.equal(time.timers.size, 0);
    assert.equal(intervals.size, 0);
    quotes.dispose(); client.clear(); dom.window.close(); globalThis.fetch = originalFetch;
  }
});
