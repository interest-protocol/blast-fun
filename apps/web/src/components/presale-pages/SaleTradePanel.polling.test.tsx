import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { installTestDom, setInputValue, testEvent } from "../../../test/fixtures/social/test-dom.ts";
import { fixtureDetail } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { FIXTURE_COINS, FIXTURE_WALLET_ADDRESS, DEFAULT_SWAP_MODE } from "../../../test/fixtures/social/coins/coins-fixture-model.ts";
import { fixtureQuote } from "../../../test/fixtures/social/coins/swap-fixture.ts";
import type { SocialTradeQuoteRequest } from "@blast/core/modules/social/contracts/trades.ts";

const { document, window } = installTestDom();
Object.defineProperty(document, "oninput", { value: null, configurable: true });
window.reducedMotion = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ShellActionsProvider } = await import("#web/components/blast-ui/shell-actions.tsx");
const { SocialViewerProvider } = await import("../social/SignInGate.tsx");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { useTradeQuoteQuery } = await import("../social/trade/trade-quote-query.ts");
const { tradeQuoteReader } = await import("../social/trades/trades-client.ts");
const { requestTradeQuote } = await import("../social/trades/trades-client.ts");
const { SaleTradePanel } = await import("./SaleTradePanel.tsx");

async function mount(t: TestContext, withOverlayQuotes = false) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_791_000_000_000 });
  const originalFetch = globalThis.fetch;
  const originalMedia = window.matchMedia;
  const railQuery = "(min-width: 1220px)";
  const railEvents = new window.EventTarget();
  const railMedia = {
    ...originalMedia(railQuery),
    matches: true,
    addEventListener: railEvents.addEventListener.bind(railEvents),
    removeEventListener: railEvents.removeEventListener.bind(railEvents),
  };
  window.matchMedia = (query) => query === railQuery ? railMedia : originalMedia(query);
  const original = fixtureDetail("kstl");
  const detail = { ...original, presale: { ...original.presale, sale_token: FIXTURE_COINS[2]!.coinType } };
  const wallet = { address: FIXTURE_WALLET_ADDRESS, signer: "wallet", fee: "wallet", as_of_ms: Date.now(), coins: FIXTURE_COINS.slice(0, 2).map((coin) => ({ coin_type: coin.coinType, name: coin.name, symbol: coin.symbol, decimals: coin.decimals, atoms: coin.atoms.toString(), usd_price: String(coin.price), value_usd: "0.00", icon_url: coin.iconUrl, presale: null })) };
  let quotes = 0;
  let wallets = 0;
  let holdWallet = false;
  let holdQuote = false;
  let overlayAsset = FIXTURE_COINS[3]!.coinType;
  const asks: SocialTradeQuoteRequest[] = [];
  const pendingWallets: (() => void)[] = [];
  const pendingQuotes: (() => void)[] = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.startsWith("/api/social/me/wallet")) {
      wallets += 1;
      if (holdWallet) await new Promise<void>((resolve) => pendingWallets.push(resolve));
      return Response.json({ ...wallet, listing: { page: 1, page_size: 20, total: wallet.coins.length, value_usd: "1000.00", extra_coins: [] } });
    }
    if (path === `/api/social/presales/${detail.presale.presale_id}`) return Response.json(detail);
    if (path === "/api/social/trades/quote") {
      quotes += 1;
      const request = JSON.parse(String(init?.body)) as SocialTradeQuoteRequest;
      asks.push(request);
      const quote = fixtureQuote(request, FIXTURE_COINS, DEFAULT_SWAP_MODE, Date.now());
      if (holdQuote) await new Promise<void>((resolve) => pendingQuotes.push(resolve));
      return Response.json(quote);
    }
    return Response.json({}, { status: 404 });
  };
  const client = createTestQueryClient();
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const root = createRoot(container);
  let closed = false;
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) {
      await act(async () => { t.mock.timers.tick(1); await new Promise<void>((resolve) => setImmediate(resolve)); });
    }
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  };
  t.after(async () => {
    await close();
    globalThis.fetch = originalFetch;
    window.matchMedia = originalMedia;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });
  function OverlayQuote() {
    const snapshot = useTradeQuoteQuery({
      read: tradeQuoteReader((body, signal) => requestTradeQuote({ getAccessToken: async () => null, signal }, body)),
      request: { in_coin: FIXTURE_COINS[0]!.coinType, out_coin: overlayAsset, side: "sell", amount_in: "100000000" },
      scope: "visible-overlay", active: true,
    });
    return <output aria-label="Visible market quote">{snapshot.quote?.out_coin ?? "pending"}</output>;
  }
  const render = async () => {
    await act(async () => root.render(withQueryClient(client, <ShellActionsProvider><SocialViewerProvider signedIn callsign="pilot"><SaleTradePanel sale={detail.presale} />{withOverlayQuotes && !railMedia.matches ? <OverlayQuote /> : null}</SocialViewerProvider></ShellActionsProvider>)));
    await flush();
  };
  await render();
  await flush();
  const advance = async (ms: number) => {
    await act(async () => t.mock.timers.tick(ms));
    await flush();
  };
  const input = () => container.querySelector<HTMLInputElement>("[data-coin-focus]")!;
  return {
    container, input, close, flush, advance, asks,
    quotes: () => quotes,
    wallets: () => wallets,
    holdWallet: () => { holdWallet = true; },
    holdQuote: () => { holdQuote = true; },
    async answerWallet() { await act(async () => { pendingWallets.shift()!(); }); await flush(); },
    async answerQuote() { await act(async () => { pendingQuotes.shift()!(); }); await flush(); },
    async selectOverlayAsset(coin: string) { overlayAsset = coin; await render(); },
    submit: () => container.querySelector<HTMLButtonElement>("[data-trade]")!,
    async populate() {
      assert.ok(input(), "the real base trade panel loaded");
      await act(async () => { setInputValue(input(), "100"); input().dispatchEvent(testEvent("input")); });
      await advance(300);
      assert.equal(quotes, 1);
      assert.equal(this.submit().disabled, false, this.submit().textContent ?? "submit is eligible");
    },
    async desktop(desktop: boolean) {
      await act(async () => {
        railMedia.matches = desktop;
        railEvents.dispatchEvent(new window.Event("change"));
      });
      if (withOverlayQuotes) await render();
      else await flush();
    },
    async visible(visible: boolean) {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: visible ? "visible" : "hidden" });
      await act(async () => document.dispatchEvent(testEvent("visibilitychange")));
      await flush();
    },
  };
}

test("the retained base trade input stops polling when the desktop rail hides", async (t) => {
  const h = await mount(t);
  await h.populate();
  await h.desktop(false);
  for (let interval = 0; interval < 3; interval += 1) await h.advance(20_000);
  assert.equal(h.quotes(), 1, "hidden desktop trade requests stop");
  assert.equal(h.input().value, "100");
  await h.desktop(true);
  await h.advance(300);
  assert.equal(h.quotes(), 2, "return asks again for the retained input");
});

test("a quick return keeps the input but waits for current wallet facts and a new quote", async (t) => {
  const h = await mount(t);
  await h.populate();
  await h.desktop(false);
  h.holdWallet();
  await h.desktop(true);
  assert.equal(h.input().value, "100");
  assert.equal(h.submit().disabled, true, "a cached executable quote and wallet cannot authorize return");
  assert.equal(h.wallets(), 2, "return refreshes wallet facts even inside their cache freshness");
  await h.advance(300);
  assert.equal(h.submit().disabled, true, "a fresh quote alone cannot authorize stale wallet facts");
  assert.equal(h.quotes(), 2, "the same input gets a fresh quote even before its old quote expires");
  await h.answerWallet();
  assert.equal(h.submit().disabled, false);
});

test("tab suspension cancels a pending base quote and unmount removes its subscriptions", async (t) => {
  const h = await mount(t);
  await h.populate();
  await act(async () => { setInputValue(h.input(), "200"); h.input().dispatchEvent(testEvent("input")); });
  await h.visible(false);
  await h.advance(60_000);
  assert.equal(h.quotes(), 1, "a debounce waiting when the tab hides cannot send a hidden request");
  await h.visible(true);
  assert.equal(h.submit().disabled, true);
  await h.advance(300);
  assert.equal(h.quotes(), 2);
  const listeners = document.listeners.count();
  await h.close();
  assert.ok(document.listeners.count() < listeners, "quote and base visibility listeners leave on unmount");
  await h.visible(false);
  await h.visible(true);
  await h.advance(60_000);
  assert.equal(h.quotes(), 2, "unmounted timers and visibility changes cannot ask again");
});

test("wallet facts from an earlier visible session cannot authorize a later return", async (t) => {
  const h = await mount(t);
  await h.populate();
  h.holdWallet();
  await h.desktop(false);
  await h.desktop(true);
  assert.equal(h.wallets(), 2);
  await h.desktop(false);
  await h.desktop(true);
  await h.advance(300);
  await h.answerWallet();
  assert.equal(h.wallets(), 3, "after the older in-flight read settles, this return reads current facts");
  assert.equal(h.submit().disabled, true, "the earlier session's response cannot enable the returned form");
  await h.answerWallet();
  assert.equal(h.submit().disabled, false);
});

test("visible market quotes continue polling and switching assets while the base form is dormant", async (t) => {
  const h = await mount(t, true);
  await h.populate();
  await h.desktop(false);
  await h.advance(300);
  for (let interval = 0; interval < 3; interval += 1) await h.advance(20_000);
  assert.equal(h.asks.filter((ask) => ask.out_coin === FIXTURE_COINS[2]!.coinType).length, 1, "the hidden base asset stopped");
  assert.equal(h.asks.filter((ask) => ask.out_coin === FIXTURE_COINS[3]!.coinType).length, 4, "the visible market kept polling");
  await h.selectOverlayAsset(FIXTURE_COINS[1]!.coinType);
  await h.advance(300);
  await h.advance(20_000);
  assert.equal(h.asks.filter((ask) => ask.out_coin === FIXTURE_COINS[1]!.coinType).length, 2, "the newly visible asset is kept fresh");
  await h.desktop(true);
  await h.advance(300);
  assert.equal(h.input().value, "100");
  assert.equal(h.asks.filter((ask) => ask.out_coin === FIXTURE_COINS[2]!.coinType).length, 2);
});

test("a late quote for an old base amount cannot enable the current amount", async (t) => {
  const h = await mount(t);
  await h.populate();
  h.holdQuote();
  for (const amount of ["200", "300"]) {
    await act(async () => { setInputValue(h.input(), amount); h.input().dispatchEvent(testEvent("input")); });
    await h.advance(300);
  }
  await h.answerQuote();
  assert.equal(h.input().value, "300");
  assert.equal(h.submit().disabled, true, "the late answer for 200 is ignored");
  await h.answerQuote();
  assert.equal(h.submit().disabled, false);
});

test("a late visible-market response for an old asset cannot replace the selected asset", async (t) => {
  const h = await mount(t, true);
  await h.populate();
  h.holdQuote();
  await h.desktop(false);
  await h.advance(300);
  await h.selectOverlayAsset(FIXTURE_COINS[1]!.coinType);
  await h.advance(300);
  await h.answerQuote();
  assert.equal(h.container.querySelector('[aria-label="Visible market quote"]')!.textContent, "pending");
  await h.answerQuote();
  assert.equal(h.container.querySelector('[aria-label="Visible market quote"]')!.textContent, FIXTURE_COINS[1]!.coinType);
});

test("unmount while waiting for older wallet facts cannot start a follow-up read", async (t) => {
  const h = await mount(t);
  await h.populate();
  h.holdWallet();
  await h.desktop(false);
  await h.desktop(true);
  await h.desktop(false);
  await h.desktop(true);
  await h.close();
  await h.answerWallet();
  await h.advance(60_000);
  assert.equal(h.wallets(), 2);
  assert.equal(h.quotes(), 1);
});
