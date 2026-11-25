import { shiftDecimal } from "#web/components/launchpad/coin/coin-format.ts";
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { readFileSync } from "node:fs";
import { browserMarketDependencies } from "#web/components/launchpad/blast-infra-browser.ts";
import { nativeCoinChartReader } from "./coin-reads";
import { JSDOM } from "jsdom";
import { act, useSyncExternalStore, type ComponentProps } from "react";
import { createRoot } from "react-dom/client";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import type { CoinSummary } from "@blast/core/modules/launchpad-contract/coin.ts";
import { notifyShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { SocialViewerProvider } from "#web/components/social/SignInGate.tsx";
import { walletCoinViews } from "#web/components/social/coins/coin-model.ts";
import { ACCESS_TOKEN, walletReads } from "../../../../../../test/fixtures/social/commit/wallet-reads.ts";
import type { TradeSendInput } from "#web/components/social/trade/trade-kit.ts";
import {
  fixtureCoinType,
  fixtureTradeQuote,
  fixtureWallet,
} from "../../../../../../test/fixtures/social/trade/trade-fixtures.ts";

import { createWorkspaceStore } from "../model";
import { CoinPanel, type CoinPanelProps } from "./CoinPanel";
import { closeRequests } from "./trade-model";
import { WorkspaceLiveProvider } from "../live-clock";
import { handClock } from "../../../../../../test/fixtures/workspace/live-clock";

const asset = {
  chain: "sui",
  network: "mainnet",
  coin_type: "0x2::coin::A",
  presale_id: null,
} as const;

function mockTradeWallet(t: TestContext) {
  const wallet = fixtureWallet();
  assert.ok(wallet.address);
  const reads = walletReads(walletCoinViews(wallet), wallet.address);
  t.mock.method(globalThis, "fetch", reads.wrap(globalThis.fetch));
  return reads.state;
}

function TradeTestQueries({ children, signedIn = true, ...props }: ComponentProps<typeof QueryProvider> & { signedIn?: boolean }) {
  return (
    <QueryProvider {...props}>
      <SocialViewerProvider signedIn={signedIn} getAccessToken={ACCESS_TOKEN}>
        {children}
      </SocialViewerProvider>
    </QueryProvider>
  );
}

test("one explicit valid coin action starts the shell send immediately once and never calls it for a guest", async (t) => {
  mockTradeWallet(t);
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', {
    url: "https://blast.test",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const client = createTestQueryClient();
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", ...asset, coin_type: fixtureCoinType("KSTL") });
  const panel = store.getSnapshot().panels.A!;
  store.patchPanel("A", {
    coin: {
      ...panel.coin,
      trade: { ...panel.coin.trade, buy: { typed: "100", mode: "typed" } },
    },
  });
  let signIns = 0;
  const sends: TradeSendInput[] = [];
  let finish: (() => void) | null = null;
  const kit: NonNullable<CoinPanelProps["actions"]["trade"]> = {
    signedIn: true,
    signIn: () => {
      signIns++;
    },
    wallet: async () => fixtureWallet(),
    quote: async (request) => ({
      status: "ok",
      quote: fixtureTradeQuote(request, {
        signedIn: true,
        fee: "blast",
        nowMs: Date.now(),
        wallet: fixtureWallet(),
      }),
    }),
    send: (input) => {
      sends.push(input);
      return new Promise((resolve) => {
        finish = () =>
          resolve({
            status: "pending",
            title: "Sandbox observer: trade sent, awaiting confirmation",
          });
      });
    },
  };
  const reads: CoinPanelProps["reads"] = {
    coin: async () => ({
      coin_type: panel.coin_type,
      symbol: "KSTL",
      name: "Kestrel",
      decimals: 9,
      price_usd: "0.0021",
    }),
    chart: async () => null,
    holders: async () => null,
    activity: async () => null,
  };
  function Subject({ authenticated }: Readonly<{ authenticated: boolean }>) {
    const snapshot = useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getSnapshot,
    );
    const current = snapshot.panels.A!;
    return (
      <TradeTestQueries client={client} signedIn={authenticated}>
        <CoinPanel
          panel_id="A"
          asset={current}
          coin_setup={current.coin}
          onSetupChange={(coin) => store.patchPanel("A", { coin })}
          effective_visibility
          actions={{
            trade: kit,
            authenticated,
            confirmation: { status: "ready", enabled: false },
            actor_key: authenticated ? "account:A" : "guest",
            signIn: kit.signIn,
          }}
          reads={reads}
        />
      </TradeTestQueries>
    );
  }
  const root = createRoot(document.getElementById("mount")!);
  const submit = () =>
    document.querySelector<HTMLButtonElement>("[data-coin-submit]")!;
  try {
    await act(async () => root.render(<Subject authenticated />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
    assert.equal(submit().disabled, false);
    const facts = document.querySelector('[aria-label="Trade facts"]')!;
    assert.ok(facts, "financial facts accompany the populated draft");
    const details = document.querySelector<HTMLButtonElement>('button[aria-label="Trade details"]');
    assert.ok(details, "secondary financial facts have one meaningful disclosure");
    assert.equal(details.getAttribute("aria-expanded"), "false");
    assert.ok(facts.closest('[inert]'), "closed details cannot receive keyboard focus");
    const balance = document.querySelector('[aria-label="Available trade balance"]')!;
    assert.ok(balance, "available balance stays in the primary form");
    assert.equal(balance.textContent, "Available860 USDC");
    assert.equal(balance.querySelector("button"), null, "a fully displayed balance needs no inspector");
    await act(async () => details.click());
    assert.equal(details.getAttribute("aria-expanded"), "true");
    assert.equal(facts.closest('[inert]'), null);
    // Audit 21: Details reads the slippage limit; only Trade settings edits it.
    assert.equal(document.querySelector('select[aria-label="Slippage"]'), null);
    assert.match(document.body.textContent!, /Max slippage 0\.5% · change it in Trade settings/);
    const inside = facts.querySelector<HTMLElement>('[aria-label="Inspect full available balance: 860 USDC"]')!;
    inside.focus();
    await act(async () => inside.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(details.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement === details, true, "closing from a detail control returns focus");
    assert.equal(store.getSnapshot().panels.A!.coin.trade.buy.typed, "100", "disclosure preserves the amount draft");
    await act(async () => details.click());

    assert.match(facts.textContent!, /Available balance/);
    assert.ok(
      facts.querySelector(
        '[aria-label="Inspect full available balance: 860 USDC"]',
      ),
    );
    assert.match(facts.textContent!, /Estimated receive/);
    assert.match(facts.textContent!, /Minimum receive/);
    assert.match(facts.textContent!, /Price impact.*0.11%/);
    assert.match(facts.textContent!, /Venue fee.*1 USDC/);
    assert.match(facts.textContent!, /Blast fee.*0 KSTL/);
    assert.match(facts.textContent!, /Network.*Paid by Blast.*0.0021 SUI/);
    await act(async () => {
      document
        .querySelector("[data-blast-ui]")!
        .setAttribute("data-amounts", "hidden");
      notifyShellPrefs();
    });
    assert.match(facts.textContent!, /Estimated receive••••/);
    assert.equal(
      facts.querySelector('[aria-label^="Inspect full estimated receive"]'),
      null,
    );
    await act(async () => {
      document
        .querySelector("[data-blast-ui]")!
        .setAttribute("data-amounts", "shown");
      notifyShellPrefs();
    });
    await act(async () => details.click());
    assert.equal(details.getAttribute("aria-expanded"), "false");
    await act(async () => {
      submit().click();
      submit().click();
    });
    assert.equal(sends.length, 1, "a press seals the quote and sends it, exactly once");
    assert.equal(sends[0]!.quote.amount_in, "100000000");
    assert.notEqual(sends[0]!.quote.quote_id, null, "what is sent is the sealed quote, never the estimate");
    await act(async () => finish!());
    assert.match(document.body.textContent!, /awaiting confirmation/);
    assert.deepEqual(store.getSnapshot().panels.A!.coin.trade.buy, { typed: "", mode: "typed" }, "a finished trade leaves an empty typed box: never one to type into, never Max refilling the balance (#1012)");
    const coin = store.getSnapshot().panels.A!.coin;
    await act(async () => store.patchPanel("A", { coin: { ...coin, trade: { ...coin.trade, buy: { typed: "100", mode: "typed" } } } }));
    await act(async () => root.render(<Subject authenticated={false} />));
    await act(async () => submit().click());
    assert.equal(signIns, 1);
    assert.equal(sends.length, 1);
    const missing = document.querySelector('[aria-label="Trade facts"]')!;
    assert.match(missing.textContent!, /Available balanceUnavailable/);
    assert.match(missing.textContent!, /Price impactUnavailable/);
    assert.match(missing.textContent!, /Network feeUnavailable/);
    assert.doesNotMatch(missing.textContent!, /Available balance0/);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    dom.window.close();
  }
});

test("chart read errors keep setup, retry, and distinguish a quote-only observation from zero USD", async () => {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', {
    url: "https://blast.test",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", ...asset });
  const panel = store.getSnapshot().panels.A!;
  let fail = true;
  const reads: CoinPanelProps["reads"] = {
    coin: async () => ({
      coin_type: panel.coin_type,
      symbol: "A",
      name: "Coin A",
      decimals: null,
      price_usd: null,
    }),
    chart: async () => {
      if (fail) throw new Error("offline");
      return {
        coin_type: panel.coin_type,
        presale_id: null,
        tier: "5m",
        from_ms: 1,
        points: [],
        price_usd: null,
        price_24h_usd: null,
        change_24h_bps: null,
        day_open_usd: null,
        day_open_ms: null,
        quote: {
          coin_type: "0x2::sui::SUI",
          symbol: "SUI",
          price: "0.00000000000000000012345",
          as_of_ms: 1000,
          points: [[1000, "0.00000000000000000012345"]],
          change_24h_bps: null,
        },
      };
    },
    holders: async () => null,
    activity: async () => null,
  };
  const root = createRoot(document.getElementById("mount")!);
  try {
    await act(async () =>
      root.render(
        <CoinPanel
          panel_id="A"
          asset={panel}
          coin_setup={panel.coin}
          onSetupChange={() =>
            assert.fail("Read failure must not rewrite setup")
          }
          effective_visibility
          actions={{
            trade: null,
            authenticated: false,
            confirmation: { status: "ready", enabled: false },
            actor_key: "guest",
            signIn() {},
          }}
          reads={reads}
        />,
      ),
    );
    assert.match(document.body.textContent!, /Price history could not load/);
    fail = false;
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Retry price history"]')!
        .click(),
    );
    assert.equal(document.querySelector('[class*="hero"] [class*="priceUnavailable"]'), null, "the optional headline price is omitted");
    assert.match(document.body.textContent!, /Last price [\d.,₀-₉]+ SUI/, "price label identifies native units");
    assert.match(document.body.textContent!, /Not enough price history/);
    assert.ok(
      document.querySelector('[aria-label*="0.00000000000000000012345"]'),
    );
    assert.doesNotMatch(document.body.textContent!, /\$0(?:\.00)?\b/);
    assert.doesNotMatch(document.body.textContent!, /buyers? |bought in/, "who's buying is omitted without the row's activity");
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("coin tabs preserve separate side drafts and another panel through remount", async () => {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', {
    url: "https://blast.test",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", ...asset });
  store.add({ panel_id: "B", ...asset, coin_type: "0x2::coin::B" });
  const b = store.getSnapshot().panels.B;
  const actions: CoinPanelProps["actions"] = {
    trade: null,
    authenticated: false,
    actor_key: "guest",
    signIn() {},
  };
  const reads: CoinPanelProps["reads"] = {
    coin: async () => ({
      coin_type: store.getSnapshot().panels.A!.coin_type,
      symbol: "A",
      name: "Coin A",
      decimals: 9,
      price_usd: "0.0021",
    }),
    chart: async () => null,
    holders: async () => null,
    activity: async () => null,
  };
  function Subject() {
    const snapshot = useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getSnapshot,
    );
    const panel = snapshot.panels.A!;
    return (
      <CoinPanel
        panel_id="A"
        asset={panel}
        coin_setup={panel.coin}
        onSetupChange={(coin) => store.patchPanel("A", { coin })}
        effective_visibility
        actions={actions}
        reads={reads}
      />
    );
  }
  const root = createRoot(document.getElementById("mount")!);
  const button = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === text,
    )!;
  const type = async (text: string) =>
    act(async () => {
      const input = document.querySelector<HTMLInputElement>(
        '[data-panel-amount]',
      )!;
      input.value = text;
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  try {
    await act(async () => root.render(<Subject />));
    await type("00042.");
    await act(async () => button("Sell").click());
    await type("17.250000");
    assert.ok(document.querySelector('[aria-label="Amount of A to sell"]'));
    assert.equal(store.getSnapshot().panels.A!.coin.trade.sell.unit, "token");
    for (const tab of ["Trades", "Chart"]) {
      await act(async () => button(tab).click());
      assert.ok(document.querySelector('[data-panel-amount]'));
    }
    await act(async () => root.render(null));
    await act(async () => root.render(<Subject />));
    assert.equal(
      document.querySelector<HTMLInputElement>(
        '[data-panel-amount]',
      )!.value,
      "17.250000",
    );
    await act(async () => button("Buy").click());
    assert.equal(
      document.querySelector<HTMLInputElement>(
        '[data-panel-amount]',
      )!.value,
      "00042.",
    );
    const amountInput = () => document.querySelector<HTMLInputElement>('[data-panel-amount]')!;
    assert.equal(amountInput().dataset.length, "short");
    for (const [typed, length] of [["1234567.891", "medium"], ["1234567890.123", "long"], ["42", "short"]] as const) {
      await type(typed);
      assert.equal(amountInput().value, typed, "the whole typed amount stays in the field");
      assert.equal(amountInput().dataset.length, length, `${typed} steps its type down rather than running under the chips`);
    }
    assert.deepEqual(store.getSnapshot().panels.B, b);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("two inline cards keep independent side drafts and their own busy send", async (t) => {
  mockTradeWallet(t);
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', {
    url: "https://blast.test",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const client = createTestQueryClient();
  const store = createWorkspaceStore();
  for (const [id, symbol, typed] of [["A", "KSTL", "25"], ["B", "LUMN", "80"]] as const) {
    store.add({ panel_id: id, ...asset, coin_type: fixtureCoinType(symbol) });
    const panel = store.getSnapshot().panels[id]!;
    store.patchPanel(id, {
      coin: {
        ...panel.coin,
        trade: {
          ...panel.coin.trade,
          buy: { mode: "typed", typed },
          sell: { mode: "typed", typed: "9" },
        },
      },
    });
  }
  let sends = 0;
  let finish: (() => void) | null = null;
  const kit: NonNullable<CoinPanelProps["actions"]["trade"]> = {
    signedIn: true,
    signIn() {},
    wallet: async () => fixtureWallet(),
    quote: async (request) => ({
      status: "ok",
      quote: fixtureTradeQuote(request, {
        signedIn: true,
        fee: "blast",
        nowMs: Date.now(),
        wallet: fixtureWallet(),
      }),
    }),
    send: () => {
      sends++;
      return new Promise((resolve) => {
        finish = () => resolve({ status: "pending", title: "Pending" });
      });
    },
  };
  function Subject() {
    const snapshot = useSyncExternalStore(
      store.subscribe,
      store.getSnapshot,
      store.getSnapshot,
    );
    return (
      <TradeTestQueries client={client}>
        {(["A", "B"] as const).map((id) => {
          const panel = snapshot.panels[id]!;
          return (
            <CoinPanel
              key={id}
              panel_id={id}
              asset={panel}
              coin_setup={panel.coin}
              onSetupChange={(coin) => store.patchPanel(id, { coin })}
              effective_visibility
              actions={{
                trade: kit,
                authenticated: true,
                confirmation: { status: "ready", enabled: false },
                actor_key: "account:A",
                signIn() {},
              }}
              reads={{
                coin: async () => ({
                  coin_type: panel.coin_type,
                  symbol: id === "A" ? "KSTL" : "LUMN",
                  name: id,
                  decimals: 9,
                  price_usd: "0.0021",
                }),
                chart: async () => null,
                holders: async () => null,
                activity: async () => null,
              }}
            />
          );
        })}
      </TradeTestQueries>
    );
  }
  const root = createRoot(document.getElementById("mount")!);
  const card = (id: string) =>
    document.querySelector<HTMLElement>(`[data-coin-panel="${id}"]`)!;
  const amount = (id: string) =>
    card(id).querySelector<HTMLInputElement>("[data-panel-amount]")!;
  const button = (id: string, text: string) =>
    [...card(id).querySelectorAll<HTMLButtonElement>("button")].find(
      (node) => node.textContent === text,
    )!;
  const settle = () =>
    act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  try {
    await act(async () => root.render(<Subject />));
    await settle();
    await act(async () => button("A", "Sell").click());
    assert.equal(amount("A").value, "9");
    await act(async () => {
      amount("A").value = "17";
      amount("A").dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    await act(async () => button("A", "Trades").click());
    await act(async () => button("B", "Trades").click());
    assert.equal(amount("B").value, "80", "B keeps its own buy draft");
    await act(async () => button("A", "Buy").click());
    assert.equal(amount("A").value, "25");
    await act(async () => button("A", "Sell").click());
    assert.equal(amount("A").value, "17");
    assert.equal(sends, 0);
    assert.equal(
      document.querySelector('[role="dialog"],dialog'),
      null,
      "view and side selection open no dialog",
    );
    await act(async () => button("A", "Buy").click());
    await settle();
    await act(async () =>
      card("A").querySelector<HTMLButtonElement>("[data-coin-submit]")!.click(),
    );
    assert.equal(sends, 1);
    assert.equal(button("A", "Sell").disabled, true, "A stays busy under its own send");
    assert.equal(
      card("B").querySelector<HTMLButtonElement>("[data-coin-submit]")!.disabled,
      false,
      "B keeps its own actionable controller",
    );
    await act(async () => finish!());
  } finally {
    await act(async () => root.unmount());
    client.clear();
    dom.window.close();
  }
});

test("native pool candles keep exact prices in token units through the existing reader", async () => {
  const curve = JSON.parse(
    readFileSync(
      new URL(
        "../../../../../../../../packages/core/test/fixtures/modules/launchpad-contract/fixtures/v1-pool-candles-curve.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const venue = JSON.parse(
    readFileSync(
      new URL(
        "../../../../../../../../packages/core/test/fixtures/modules/launchpad-contract/fixtures/v1-pool-candles-cetus.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const at = curve.provenance.timestamp_ms + 400;
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const path = String(input);
    requests.push(path);
    const body = path.includes("/cetus/") ? venue : curve;
    return Response.json(
      path.endsWith("/status")
        ? { provenance: { ...curve.provenance, observed_ms: at, lag_ms: 400 } }
        : {
            ...body,
            provenance: { ...body.provenance, observed_ms: at, lag_ms: 400 },
          },
    );
  };
  const store = createWorkspaceStore();
  store.add({ panel_id: "native", ...asset, network: "localnet" });
  const panel = store.getSnapshot().panels.native!;
  const chart = nativeCoinChartReader({
    asset: panel,
    source: {
      expected: null,
      curvePoolKey: curve.migration.curve_pool_key,
      venuePoolKey: curve.migration.venue_pool_key,
      migration: null,
      symbol: "C",
      quoteSymbol: "SUI",
      memeDecimals: 6,
      quoteDecimals: 9,
    },
    dependencies: browserMarketDependencies(null, fetcher, () => at),
    now: () => at,
  });
  const reads: CoinPanelProps["reads"] = {
    coin: async () => null,
    chart,
    holders: async () => null,
    activity: async () => null,
  };
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', {
    url: "https://blast.test",
  });
  Object.defineProperty(dom.window, "matchMedia", { value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
  const previousMatchMedia = globalThis.matchMedia;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    matchMedia: dom.window.matchMedia.bind(dom.window),
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    requestAnimationFrame() { return 0; },
    cancelAnimationFrame() {},
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("mount")!);
  try {
    await act(async () =>
      root.render(
        <CoinPanel
          panel_id="native"
          asset={panel}
          coin_setup={panel.coin}
          onSetupChange={() => {}}
          effective_visibility
          actions={{
            trade: null,
            authenticated: false,
            confirmation: { status: "ready", enabled: false },
            actor_key: "guest",
            signIn() {},
          }}
          reads={reads}
        />,
      ),
    );
    assert.ok(document.body.textContent!.includes(shiftDecimal(curve.candles[0].open, -3)));
    assert.ok(document.querySelector('[data-tradingview-plot]'));
    const plot = document.querySelector('[data-tradingview-plot]');
    const chartDetails = document.querySelector<HTMLButtonElement>('button[aria-label="View chart values"]')!;
    assert.equal(chartDetails.getAttribute("aria-expanded"), "false");
    const candleHistory = document.querySelector('ol')!;
    assert.ok(candleHistory.closest('[inert]'), "long exact history is closed without discarding its values");
    assert.doesNotMatch(document.body.textContent!, /blast_curve:|Checkpoint/);
    assert.match(document.body.textContent!, /Graduation/);
    const chartReads = requests.length;
    await act(async () => chartDetails.click());
    assert.equal(candleHistory.closest('[inert]'), null);
    const candleValue = candleHistory.querySelector<HTMLButtonElement>('button')!;
    candleValue.focus();
    await act(async () => candleValue.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    assert.equal(chartDetails.getAttribute("aria-expanded"), "false");
    assert.equal(document.activeElement === chartDetails, true);
    assert.equal(document.querySelector('[data-tradingview-plot]') === plot, true, "disclosure keeps the active plot mounted");
    assert.equal(requests.length, chartReads, "opening chart details does not reread the market");

    assert.ok(requests.some((path) => path.includes("/pools/blast_curve/")));
    assert.ok(requests.some((path) => path.includes("/pools/cetus/")));
    const before = requests.length;
    assert.equal(
      await chart(
        { ...panel, network: "mainnet" },
        "24h",
        new AbortController().signal,
      ),
      null,
    );
    assert.equal(requests.length, before);
  } finally {
    await act(async () => root.unmount());
    globalThis.matchMedia = previousMatchMedia;
    dom.window.close();
  }
});

test("fee payment requires explicit consent and hidden panels stop reads and submits", async (t) => {
  mockTradeWallet(t);
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', {
    url: "https://blast.test",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const client = createTestQueryClient();
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", ...asset, coin_type: fixtureCoinType("KSTL") });
  const base = store.getSnapshot().panels.A!;
  let panel: typeof base = {
    ...base,
    coin: {
      ...base.coin,
      trade: {
        ...base.coin.trade,
        buy: { typed: "100", mode: "typed" as const },
      },
    },
  };
  const sends: TradeSendInput[] = [];
  let quoteReads = 0;
  let contentReads = 0;
  const kit: NonNullable<CoinPanelProps["actions"]["trade"]> = {
    signedIn: true,
    signIn() {},
    wallet: async () => fixtureWallet(),
    quote: async (request) => {
      quoteReads++;
      return {
        status: "ok",
        quote: {
          ...fixtureTradeQuote(request, {
            signedIn: true,
            fee: "blast",
            nowMs: Date.now(),
            wallet: fixtureWallet(),
          }),
          quote_id: `fee-quote-${quoteReads}`,
        },
      };
    },
    send: async (input) => {
      sends.push(input);
      return !input.acceptFee
        ? {
            status: "fee_required",
            feeMist: "1234567",
            requiredMist: "2000000",
            payable: true,
          }
        : { status: "pending", title: "Observer only: awaiting confirmation" };
    },
  };
  const reads: CoinPanelProps["reads"] = {
    coin: async () => {
      contentReads++;
      return null;
    },
    chart: async () => {
      contentReads++;
      return null;
    },
    holders: async () => null,
    activity: async () => null,
  };
  const root = createRoot(document.getElementById("mount")!);
  const render = (visible: boolean) => (
    <TradeTestQueries client={client}>
      <CoinPanel
        panel_id="A"
        asset={panel}
        coin_setup={panel.coin}
        onSetupChange={(coin) => {
          panel = { ...panel, coin };
          root.render(render(true));
        }}
        effective_visibility={visible}
        actions={{
          trade: kit,
          authenticated: true,
          confirmation: { status: "ready", enabled: false },
          actor_key: "fee-account",
          signIn() {},
        }}
        reads={reads}
      />
    </TradeTestQueries>
  );
  const submit = () =>
    document.querySelector<HTMLButtonElement>("[data-coin-submit]")!;
  try {
    await act(async () => root.render(render(false)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    assert.equal(quoteReads, 0);
    assert.equal(contentReads, 0);
    assert.equal(submit().disabled, true);
    await act(async () => root.render(render(true)));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
    assert.equal(
      submit().disabled,
      false,
      "verified wallet metadata supports a standalone coin even when discovery cannot resolve it",
    );
    assert.match(
      document.querySelector('[aria-label="Trade facts"]')!.textContent!,
      /Network feePaid by Blast.*0.0021 SUI/,
    );
    await act(async () => submit().click());
    assert.equal(sends.length, 1);
    assert.equal(sends[0]!.acceptFee, undefined);
    assert.equal(submit().disabled, true);
    assert.match(document.body.textContent!, /0.001234567 SUI/);
    const facts = document.querySelector('[aria-label="Trade facts"]')!;
    assert.match(
      facts.textContent!,
      /Network feePaid from your SUI.*0.001234567 SUI/,
    );
    assert.doesNotMatch(facts.textContent!, /Paid by Blast|0.0021 SUI/);
    await act(async () =>
      document
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .click(),
    );
    assert.equal(submit().disabled, false);
    assert.match(
      facts.textContent!,
      /Network feePaid from your SUI.*0.001234567 SUI/,
    );
    assert.ok(
      facts.querySelector(
        '[aria-label="Inspect full network fee: 0.001234567 SUI"]',
      ),
      "exact inspection receives the active offer without rounding",
    );
    await act(async () => {
      document
        .querySelector("[data-blast-ui]")!
        .setAttribute("data-amounts", "hidden");
      notifyShellPrefs();
    });
    assert.match(facts.textContent!, /Network feePaid from your SUI.*••••/);
    assert.doesNotMatch(document.body.textContent!, /0.001234567|0.0021/);
    assert.equal(
      facts.querySelector('[aria-label^="Inspect full network fee"]'),
      null,
    );
    await act(async () => {
      document
        .querySelector("[data-blast-ui]")!
        .setAttribute("data-amounts", "shown");
      notifyShellPrefs();
    });
    await act(async () => {
      await client.refetchQueries({ type: "active" });
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    assert.match(facts.textContent!, /Network feePaid by Blast.*0.0021 SUI/);
    assert.doesNotMatch(document.body.textContent!, /0.001234567/);
    assert.equal(document.querySelector('input[type="checkbox"]'), null);
    await act(async () => submit().click());
    assert.equal(
      sends[1]!.acceptFee,
      undefined,
      "replaced quote has no prior fee authority",
    );
    assert.equal(submit().disabled, true);
    assert.match(
      facts.textContent!,
      /Network feePaid from your SUI.*0.001234567 SUI/,
    );
    await act(async () => {
      const input = document.querySelector<HTMLInputElement>(
        '[aria-label="Trade amount in USD"]',
      )!;
      input.value = "101";
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
    assert.doesNotMatch(document.body.textContent!, /0.001234567/);
    assert.equal(document.querySelector('input[type="checkbox"]'), null);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
    assert.match(facts.textContent!, /Network feePaid by Blast.*0.0021 SUI/);
    await act(async () => submit().click());
    assert.equal(
      sends[2]!.acceptFee,
      undefined,
      "changed draft has no prior fee authority",
    );
    assert.equal(submit().disabled, true);
    await act(async () =>
      document
        .querySelector<HTMLInputElement>('input[type="checkbox"]')!
        .click(),
    );
    await act(async () => submit().click());
    assert.equal(sends.length, 4);
    assert.equal(sends[3]!.acceptFee, true);
    assert.match(document.body.textContent!, /awaiting confirmation/);
    await act(async () => root.render(render(false)));
    const before = quoteReads;
    await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
    assert.equal(quoteReads, before);
    assert.equal(submit().disabled, true);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    dom.window.close();
  }
});

test("wallet, balance, route, freshness and canonical quote refusals cannot execute", async (t) => {
  const exactWallet = mockTradeWallet(t);
  for (const scenario of [
    "wallet",
    "balance",
    "sell-balance",
    "server-balance",
    "server-gas",
    "route",
    "expired",
    "different-coin",
    "testnet",
    "unpayable",
  ] as const) {
    exactWallet.fail = scenario === "wallet";
    const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', {
      url: "https://blast.test",
    });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const client = createTestQueryClient();
    const store = createWorkspaceStore();
    store.add({
      panel_id: "A",
      ...asset,
      network: scenario === "testnet" ? "testnet" : "mainnet",
      coin_type: fixtureCoinType("KSTL"),
    });
    const base = store.getSnapshot().panels.A!;
    const panel = {
      ...base,
      coin: {
        ...base.coin,
        trade: {
          ...base.coin.trade,
          side:
            scenario === "sell-balance" ? ("sell" as const) : ("buy" as const),
          sell: { typed: "999999", mode: "typed" as const },
          buy: {
            typed: scenario === "balance" ? "999999" : "100",
            mode: "typed" as const,
          },
        },
      },
    };
    let sends = 0;
    const kit: NonNullable<CoinPanelProps["actions"]["trade"]> = {
      signedIn: true,
      signIn() {},
      wallet: async () => (scenario === "wallet" ? null : {...fixtureWallet(),as_of_ms:Date.now()}),
      quote: async (request) => {
        const quote = fixtureTradeQuote(request, {
          signedIn: true,
          fee: "blast",
          nowMs: scenario === "expired" ? Date.now() - 60_000 : Date.now(),
          wallet: fixtureWallet(),
        });
        return {
          status: "ok",
          quote: {
            ...quote,
            ...(scenario.startsWith("server-")
              ? {
                  offer_refused: "insufficient_balance" as const,
                  balance_failure: {
                    reason:
                      scenario === "server-gas"
                        ? ("gas" as const)
                        : ("input" as const),
                    coin_type: request.in_coin,
                    required_atoms: "100000000",
                    available_atoms: "0",
                  },
                }
              : {}),
            ...(scenario === "route"
              ? {
                  quote_id: null,
                  unavailable_reason: "pool_unavailable" as const,
                }
              : {}),
            ...(scenario === "different-coin"
              ? { out_coin: fixtureCoinType("LUMN") }
              : {}),
          },
        };
      },
      send: async () => {
        sends++;
        return { status: "fee_required", feeMist: "1234567", payable: false };
      },
    };
    const reads: CoinPanelProps["reads"] = {
      coin: async () => null,
      chart: async () => null,
      holders: async () => null,
      activity: async () => null,
    };
    const root = createRoot(document.getElementById("mount")!);
    try {
      await act(async () =>
        root.render(
          <TradeTestQueries client={client}>
            <CoinPanel
              panel_id="A"
              asset={panel}
              coin_setup={panel.coin}
              onSetupChange={() => {}}
              effective_visibility
              actions={{
                trade: kit,
                authenticated: true,
                confirmation: { status: "ready", enabled: false },
                actor_key: scenario,
                signIn() {},
              }}
              reads={reads}
            />
          </TradeTestQueries>,
        ),
      );
      await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
      const submit =
        document.querySelector<HTMLButtonElement>("[data-coin-submit]")!;
      if (scenario === "unpayable") {
        await act(async () => submit.click());
        assert.equal(sends, 1);
        assert.equal(
          document.querySelector<HTMLInputElement>('input[type="checkbox"]')!
            .disabled,
          true,
        );
      }
      const labels: Readonly<Record<string, string>> = {
        balance: "Not enough USDC",
        "server-balance": "Not enough USDC",
        "sell-balance": "Not enough KSTL",
        "server-gas": "Add SUI to trade",
      };
      const expectedLabel = labels[scenario];
      if (expectedLabel)
        assert.ok(document.querySelector("[data-trade-feedback]")!.textContent!.includes(expectedLabel));
      // An estimate has no expiry: the press seals it, finds the sealed quote expired, and sends nothing.
      assert.equal(submit.disabled, scenario !== "expired", scenario);
      await act(async () => submit.click());
      assert.equal(sends, scenario === "unpayable" ? 1 : 0, scenario);
      if (scenario === "expired") assert.match(document.body.textContent!, /Review a fresh quote\. Nothing was sent\./);
    } finally {
      await act(async () => root.unmount());
      client.clear();
      dom.window.close();
    }
  }
});

test("saved navigation waits for delayed rows and never overwrites a newer user scroll", async () => {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', {
    url: "https://blast.test",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const positions = new WeakMap<Element, number>();
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollTop", {
    configurable: true,
    get() {
      return positions.get(this) ?? 0;
    },
    set(value: number) {
      positions.set(this, this.querySelector("li") ? value : 0);
    },
  });
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", ...asset });
  const panel = store.getSnapshot().panels.A!;
  const setup = {
    ...panel.coin,
    tabs: { ...panel.coin.tabs, selected: "activity" as const },
    navigation: { ...panel.coin.navigation, scroll_top: 72 },
  };
  let finish:
    | ((value: Awaited<ReturnType<CoinPanelProps["reads"]["activity"]>>) => void)
    | undefined;
  const reads: CoinPanelProps["reads"] = {
    coin: async () => null,
    chart: async () => null,
    holders: async () => null,
    activity: () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  };
  const wallet = { type: "address" as const, address: `0x${"1".repeat(64)}`, short: "0x1111…1111" };
  const rows = {
    presale_id: "0xsale", next_cursor: null, window: "24h", clock_ms: 1790337660000,
    as_of: { checkpoint: 1, timestamp_ms: 1790337600000, lag_ms: 400 },
    participants: [{
      key: `w:${wallet.address}`, actor: wallet, followers: null, buys: null, sells: null, commits: null, claims: null,
      latest_ms: 1790337600000, latest_kind: "trade_buy", events_total: 1,
      events: [{ activity_id: "1", entry_id: "a:1", kind: "trade_buy", occurred_at_ms: 1790337600000, digest: null, refund: null, has_why: false, tokens: null, quote: null }],
    }],
  } as unknown as Awaited<ReturnType<CoinPanelProps["reads"]["activity"]>>;
  const writes: number[] = [];
  const client = createTestQueryClient();
  const root = createRoot(document.getElementById("mount")!);
  const render = (source: CoinPanelProps["reads"], key = "default") => (
    <QueryProvider client={client}>
      <CoinPanel
        key={key}
        panel_id="A"
        asset={panel}
        coin_setup={setup}
        onSetupChange={(next) => writes.push(next.navigation.scroll_top)}
        effective_visibility
        actions={{
          trade: null,
          authenticated: false,
          actor_key: "guest",
          signIn() {},
        }}
        reads={source}
      />
    </QueryProvider>
  );
  try {
    await act(async () => root.render(render(reads)));
    const content = document.querySelector<HTMLElement>("[role=tabpanel]")!;
    assert.equal(
      content.scrollTop,
      0,
      "the browser clamps while there are no rows",
    );
    await act(async () => finish!(rows));
    assert.equal(content.scrollTop, 72, "restore once when rows arrive");
    await act(async () =>
      content.dispatchEvent(new dom.window.Event("scroll", { bubbles: true })),
    );
    assert.deepEqual(
      writes,
      [],
      "programmatic restoration must not erase the saved anchor",
    );
    await act(async () => {
      content.dispatchEvent(
        new dom.window.WheelEvent("wheel", { bubbles: true, deltaY: 12 }),
      );
      content.scrollTop = 12;
      content.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
    });
    assert.deepEqual(writes, [12]);
    await act(async () =>
      root.render(render({ ...reads, activity: async () => rows })),
    );
    assert.equal(
      content.scrollTop,
      12,
      "a later response cannot jump over the user's newer position",
    );
    await act(async () =>
      root.render(render({ ...reads, activity: async () => null })),
    );
    await act(async () => {
      content.scrollTop = 0;
      content.dispatchEvent(new dom.window.Event("scroll", { bubbles: true }));
    });
    assert.deepEqual(
      writes,
      [12],
      "a later shorter response cannot replace the user's saved anchor with its clamp",
    );
    await act(async () =>
      root.render(render({ ...reads, activity: async () => null }, "short")),
    );
    const shorter = document.querySelector<HTMLElement>("[role=tabpanel]")!;
    assert.equal(shorter.scrollTop, 0);
    await act(async () =>
      shorter.dispatchEvent(new dom.window.Event("scroll", { bubbles: true })),
    );
    assert.deepEqual(
      writes,
      [12],
      "a shorter response must preserve the raw saved anchor",
    );
    await act(async () => root.render(render(reads, "early-user")));
    const early = document.querySelector<HTMLElement>("[role=tabpanel]")!;
    await act(async () =>
      early.dispatchEvent(
        new dom.window.KeyboardEvent("keydown", {
          key: "PageDown",
          bubbles: true,
        }),
      ),
    );
    await act(async () => finish!(rows));
    assert.equal(
      early.scrollTop,
      0,
      "user navigation during loading cancels the late restoration",
    );
  } finally {
    await act(async () => root.unmount());
    client.clear();
    dom.window.close();
  }
});

test("activity describes current, delayed and unavailable freshness without changing empty coverage", async () => {
  for (const lag of [null, 400, 180_000]) {
    const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', {
      url: "https://blast.test",
    });
    Object.assign(globalThis, {
      window: dom.window,
      document: dom.window.document,
      HTMLElement: dom.window.HTMLElement,
      Element: dom.window.Element,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    const store = createWorkspaceStore();
    store.add({ panel_id: "A", ...asset });
    const panel = store.getSnapshot().panels.A!;
    const page = {
      presale_id: "0xsale",
      coin_type: null,
      participants: [],
      next_cursor: null,
      window: "24h" as const,
      clock_ms: 1790337660000,
      as_of:
        lag === null
          ? undefined
          : { checkpoint: 100, timestamp_ms: 1790337480000, lag_ms: lag },
      totals: {
        scope: "pool" as const,
        window: "24h" as const,
        from_ms: 0,
        to_ms: 1790337660000,
        participants: 0,
        events: 0,
        buyers: 0,
        sellers: 0,
        backers: 0,
        claimers: 0,
        bought: [],
        sold: [],
        committed: [],
        latest_ms: null,
      },
    };
    const reads: CoinPanelProps["reads"] = {
      coin: async () => null,
      chart: async () => null,
      holders: async () => null,
      // The missing-as_of case deliberately exercises an incomplete response at the rendered boundary.
      activity: async () =>
        page as Awaited<ReturnType<CoinPanelProps["reads"]["activity"]>>,
    };
    const root = createRoot(document.getElementById("mount")!);
    try {
      await act(async () =>
        root.render(
          <CoinPanel
            panel_id="A"
            asset={panel}
            coin_setup={{
              ...panel.coin,
              tabs: { ...panel.coin.tabs, selected: "activity" },
            }}
            onSetupChange={() =>
              assert.fail("Freshness must not rewrite setup")
            }
            effective_visibility
            actions={{
              trade: null,
              authenticated: false,
              confirmation: { status: "ready", enabled: false },
            actor_key: "guest",
              signIn() {},
            }}
            reads={reads}
          />,
        ),
      );
      const content = document.querySelector('[role="tabpanel"]')!;
      const description = content.querySelector('[data-list-note]');
      assert.ok(description, "coverage and freshness stay available as the list's description");
      const note = description.textContent!;
      const visible = content.textContent!.replace(note, "");
      assert.match(note, /Trades on every venue\./);
      assert.match(
        visible,
        /No recorded trades in this period/,
      );
      if (lag === null) {
        assert.match(visible, /Activity freshness unavailable/);
        assert.doesNotMatch(
          content.textContent!,
          /Activity is current|Activity is delayed/,
        );
      } else if (lag > 60_000) {
        assert.match(visible, /Activity is delayed.*3 min behind/, "a delay stays visible");
        assert.match(note, /Activity is delayed.*Indexed 2026-09-25T11:58:00.000Z/);
      } else {
        assert.doesNotMatch(visible, /Activity is current|Activity is delayed/, "current freshness is not visible helper copy");
        assert.match(note, /Activity is current within 1 min\. Indexed 2026-09-25T11:58:00.000Z/);
      }
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  }
});

test("Holders and Posts are not shown in Blast mode; a saved selection falls back to Chart without reading holders or posts or rewriting setup", async () => {
  for (const saved of ["people", "posts"] as const) {
    const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', { url: "https://blast.test" });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
    const store = createWorkspaceStore();
    store.add({ panel_id: "A", ...asset, presale_id: "0xsale" });
    const panel = store.getSnapshot().panels.A!;
    const setup = { ...panel.coin, tabs: { ...panel.coin.tabs, enabled: ["overview", "people", "activity", "posts"] as typeof panel.coin.tabs.enabled, selected: saved } };
    const calls = { chart: 0, holders: 0, posts: 0, activity: 0 };
    const reads: CoinPanelProps["reads"] = {
      coin: async () => null,
      chart: async () => { calls.chart++; return null; },
      holders: async () => { calls.holders++; return null; },
      activity: async () => { calls.activity++; return null; },
      posts: async () => { calls.posts++; return null; },
    };
    const root = createRoot(document.getElementById("mount")!);
    try {
      await act(async () => root.render(<CoinPanel panel_id="A" asset={panel} coin_setup={setup} onSetupChange={() => assert.fail("Opening the card must not rewrite setup")} effective_visibility reads={reads} actions={{ trade: null, authenticated: false, actor_key: "guest", confirmation: { status: "ready", enabled: false }, signIn() {} }} />));
      const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
      assert.deepEqual(tabs.map((tab) => tab.getAttribute("aria-label")), ["Chart", "Trades"], saved);
      assert.equal(tabs[0]!.getAttribute("aria-selected"), "true", "Chart is the selected view");
      assert.deepEqual(tabs.map((tab) => tab.tabIndex), [0, -1], "exactly one tab is focusable");
      assert.equal(document.querySelector('[role="tabpanel"]')!.getAttribute("aria-labelledby"), tabs[0]!.id);
      assert.equal(calls.holders, 0, `${saved}: no holders read`);
      assert.equal(calls.posts, 0, `${saved}: no posts read`);
      assert.ok(calls.chart > 0, "the Chart view reads its history");
      assert.match(document.body.textContent!, /Price history unavailable/);
    } finally {
      await act(async () => root.unmount());
      dom.window.close();
    }
  }
});


test("linked sale tokens retain disabled trade geometry until authoritative lifecycle is migrated", async () => {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', { url: "https://blast.test" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", ...asset, presale_id: null });
  const panel = store.getSnapshot().panels.A!;
  const root = createRoot(document.getElementById("mount")!);
  let saleRedirects = 0;
  try {
    for (const lifecycle of [undefined, "presale", "migrated"]) {
      const client = createTestQueryClient();
      const reads: CoinPanelProps["reads"] = { coin: async () => ({ coin_type: panel.coin_type, symbol: "A", name: "A", decimals: 9, price_usd: null, presale_id: "sale-A", lifecycle }), chart: async () => null, holders: async () => null, activity: async () => null };
      await act(async () => root.render(<QueryProvider key={String(lifecycle)} client={client}><CoinPanel panel_id="A" asset={panel} coin_setup={panel.coin} onSetupChange={() => {}} effective_visibility reads={reads} onPresaleAvailable={id => { assert.equal(id, "sale-A"); saleRedirects++; }} actions={{ trade: null, authenticated: false, actor_key: "guest", confirmation: { status: "ready", enabled: false }, signIn() {} }} /></QueryProvider>));
      assert.equal(document.querySelector<HTMLElement>('[aria-label="Trade"]')!.dataset.unavailable, String(lifecycle !== "migrated"));
      if (lifecycle !== "migrated") assert.equal(document.querySelector<HTMLButtonElement>("[data-coin-submit]")!.disabled, true);
      client.clear();
    }
    assert.ok(saleRedirects > 0);
  } finally { await act(async () => root.unmount()); dom.window.close(); }
});

test("the redesigned panel names the venue, keeps exact figures inspectable, and gives every trade and holder a real identity", async () => {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', { url: "https://blast.test" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, self: dom.window, IS_REACT_ACT_ENVIRONMENT: true });
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", ...asset, presale_id: "0xsale" });
  const panel = store.getSnapshot().panels.A!;
  const wallet = { type: "address" as const, address: `0x${"ab".repeat(32)}`, short: "0xabab…abab" };
  const account = { type: "account" as const, callsign: "mara", display_name: "Mara Lin", avatar_url: null, x_handle: null, verified: true, path: "/@mara" };
  const usdc = { quote_type: "0x2::usdc::USDC", quote_symbol: "USDC", quote_decimals: 6 };
  const event = (kind: "trade_buy" | "trade_sell", id: string, usd: string | null) => ({
    activity_id: id, entry_id: `a:${id}`, kind, occurred_at_ms: 1790337600000, digest: null, refund: null, has_why: false,
    tokens: "56123000000000", quote: { ...usdc, atoms: "120000000", usd, usd_complete: usd !== null },
  });
  const participant = (actor: typeof wallet | typeof account, events: ReturnType<typeof event>[]) => ({
    key: actor.type === "account" ? `c:${actor.callsign}` : `w:${actor.address}`, actor, followers: null,
    buys: null, sells: null, commits: null, claims: null, latest_ms: 1790337600000, latest_kind: events[0]!.kind, events_total: events.length, events,
  });
  const reads: CoinPanelProps["reads"] = {
    coin: async () => ({
      coin_type: panel.coin_type, symbol: "KSTL", name: "Kestrel", decimals: 9, price_usd: "0.0021", price_as_of_ms: Date.now(),
      presale_id: "0xsale", lifecycle: "migrated", venue: "cetus", change_24h_bps: 1234, fdv_usd: "2100000", holders: 512,
      top_holders: { share_bps: 4000, holders: [{ actor: wallet, balance: "1", share_bps: 1 }] },
      activity: {
        scope: "pool", window: "24h", from_ms: 1790251260000, to_ms: 1790337660000, participants: 49, events: 60, buyers: 48, sellers: 1, backers: 0, claimers: 0,
        bought: [], sold: [], committed: [], latest_ms: 1790337600000,
        preview: [
          { ...participant(wallet, [event("trade_buy", "3", null)]), buys: { count: 1, amounts: [], tokens: null, latest_ms: 1790337600000 } },
          { ...participant(account, [event("trade_buy", "4", null)]), buys: { count: 1, amounts: [], tokens: null, latest_ms: 1790337600000 } },
        ],
      },
    }),
    chart: async () => null,
    holders: async () => ({ share_bps: 4000, holders: [{ actor: wallet, balance: "1234500000000000", share_bps: 1234 }, { actor: account, balance: "1", share_bps: null }] }),
    activity: async () => ({
      presale_id: "0xsale", next_cursor: null, window: "24h", clock_ms: 1790337660000,
      as_of: { checkpoint: 1, timestamp_ms: 1790337600000, lag_ms: 400 },
      participants: [participant(wallet, [{ ...event("trade_sell", "2", null), occurred_at_ms: 1790337540000 }]), participant(account, [event("trade_buy", "1", "120.00")])],
    }) as unknown as Awaited<ReturnType<CoinPanelProps["reads"]["activity"]>>,
  };
  function Subject() {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const current = snapshot.panels.A!;
    return <CoinPanel panel_id="A" asset={current} coin_setup={current.coin} onSetupChange={(coin) => store.patchPanel("A", { coin })} effective_visibility actions={{ trade: null, authenticated: false, actor_key: "guest", confirmation: { status: "ready", enabled: false }, signIn() {} }} reads={reads} />;
  }
  const root = createRoot(document.getElementById("mount")!);
  const tab = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent === name)!;
  try {
    await act(async () => root.render(<Subject />));
    assert.match(document.querySelector("header")!.textContent!, /KSTL.*Kestrel.*Trading on Cetus/);
    assert.deepEqual([...document.querySelectorAll('[role="tab"]')].map((button) => button.getAttribute("aria-label")), ["Chart", "Trades"]);
    assert.ok(document.querySelector('[aria-label^="Inspect full observed USD price"][aria-label$=": 0.0021"]'), "the headline price keeps its exact observation");
    assert.match(document.body.textContent!, /\+12\.34% 24h/, "the move shows its window beside the percentage");
    assert.match(document.body.textContent!, /FDV \$2\.1M/);
    assert.doesNotMatch(document.body.textContent!, /Holders512/, "holders live in their own tab, not the hero");
    assert.doesNotMatch(document.querySelector("[data-chart-frame]")!.textContent!, /bought in 24h/, "participation does not consume the chart frame");
    assert.equal(document.querySelector('button[aria-label^="Remove"]'), null, "removal lives in the card's options menu");

    await act(async () => tab("Trades").click());
    const trades = [...document.querySelectorAll('[role="tabpanel"] li')];
    assert.equal(trades.length, 2);
    assert.match(trades[0]!.textContent!, /Mara Lin.*Buy.*\$120.*1m/);
    assert.doesNotMatch(trades[0]!.textContent!, /56,123 KSTL/, "the quantity is inspectable, not a second line");
    assert.ok(trades[0]!.querySelector('[aria-label="Inspect full activity amount: 120 USDC · $120.00 · 56,123 KSTL"]'));
    assert.match(trades[1]!.textContent!, /0xabab…abab.*Sell.*120 USDC/);
    assert.ok(trades[1]!.querySelector(`[aria-label="Inspect full wallet address: ${wallet.address}"]`));
    assert.ok(trades[1]!.querySelector('[aria-label="Inspect full activity amount: 120 USDC · USD unavailable · 56,123 KSTL"]'));
    assert.ok(trades[0]!.querySelector('time[datetime="2026-09-25T12:00:00.000Z"]'));

  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("with trades under $1 hidden, a burst of dust cannot empty Trades: the read leaves dust out, and turning the filter off reads every trade once", async () => {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', { url: "https://blast.test" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, self: dom.window, IS_REACT_ACT_ENVIRONMENT: true });
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", ...asset, presale_id: "0xsale" });
  const sui = { quote_type: "0x2::sui::SUI", quote_symbol: "SUI", quote_decimals: 9 };
  const trade = (id: string, usd: string, at: number) => {
    const actor = { type: "address" as const, address: `0x${id.padStart(64, "0")}`, short: `0x${id}` };
    const event = { activity_id: id, entry_id: `a:${id}`, kind: "trade_buy" as const, occurred_at_ms: at, digest: null, refund: null, has_why: false, tokens: "1000000000", quote: { ...sui, atoms: "1000000", usd, usd_complete: true } };
    return { key: `w:${actor.address}`, actor, followers: null, buys: null, sells: null, commits: null, claims: null, latest_ms: at, latest_kind: event.kind, events_total: 1, events: [event] };
  };
  // A bot's 20 dust wallets trade after the one real buy: unfloored, they fill the whole page.
  const dust = Array.from({ length: 20 }, (_, n) => trade(`d${n + 10}`, "0.01", 1790337600000 + n));
  const real = trade("1234", "250.00", 1790337500000);
  let realInWindow = true;
  const floors: (number | null)[] = [];
  let answerAll: (() => void) | null = null;
  const reads: CoinPanelProps["reads"] = {
    coin: async () => ({ coin_type: asset.coin_type, symbol: "KSTL", name: "Kestrel", decimals: 9, price_usd: null, presale_id: "0xsale", lifecycle: "migrated" }),
    chart: async () => null,
    holders: async () => null,
    activity: async (_asset, _signal, minTradeUsd) => {
      floors.push(minTradeUsd);
      if (minTradeUsd === null) await new Promise<void>((resolve) => (answerAll = resolve));
      const all = [...dust, ...(realInWindow ? [real] : [])];
      return {
        presale_id: "0xsale", coin_type: null, next_cursor: null, window: "24h", clock_ms: 1790337660000,
        as_of: { checkpoint: 1, timestamp_ms: 1790337600000, lag_ms: 0 },
        participants: minTradeUsd === 1 ? all.filter((row) => !dust.includes(row)) : all.slice(0, 20),
        // The totals are never floored: they still count the dust.
        totals: { scope: "pool", window: "24h", from_ms: 0, to_ms: 1790337660000, participants: all.length, events: all.length, buyers: all.length, sellers: 0, backers: 0, claimers: 0, bought: [], sold: [], committed: [], latest_ms: 1790337600019 },
      } as unknown as Awaited<ReturnType<CoinPanelProps["reads"]["activity"]>>;
    },
  };
  function Subject() {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const current = snapshot.panels.A!;
    return <CoinPanel panel_id="A" asset={current} coin_setup={current.coin} onSetupChange={(coin) => store.patchPanel("A", { coin })} effective_visibility actions={{ trade: null, authenticated: false, actor_key: "guest", confirmation: { status: "ready", enabled: false }, signIn() {} }} reads={reads} />;
  }
  let root = createRoot(document.getElementById("mount")!);
  const tab = (name: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) => button.textContent === name)!;
  const rows = () => [...document.querySelectorAll('[role="tabpanel"] li')];
  const filter = () => document.querySelector<HTMLButtonElement>('[role="tabpanel"] button[role="switch"]');
  try {
    await act(async () => root.render(<Subject />));
    await act(async () => tab("Trades").click());
    assert.deepEqual(rows().map((row) => row.textContent?.includes("$250")), [true], "the real buy stays on the list");
    assert.ok(floors.length > 0 && floors.every((floor) => floor === 1), "with the filter on every read leaves dust out");

    const before = floors.length;
    await act(async () => filter()!.click());
    assert.deepEqual(floors.slice(before), [null], "turning the filter off reads every trade, once");
    assert.equal(rows().length, 1, "the shown list stays until that read answers");
    await act(async () => answerAll!());
    assert.equal(rows().length, 12, "the dust shows");

    // A window of only dust still offers the switch: there are trades, just none over $1.
    realInWindow = false;
    await act(async () => root.unmount());
    root = createRoot(document.getElementById("mount")!);
    await act(async () => root.render(<Subject />));
    assert.equal(rows().length, 0);
    assert.match(document.querySelector('[role="tabpanel"]')!.textContent!, /No trades match this filter/);
    assert.doesNotMatch(document.querySelector('[role="tabpanel"]')!.textContent!, /No recorded trades/);
    assert.ok(filter());
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});

test("missing holder counts retain a retry and count-change time does not imply a fresh observation", async () => {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', { url: "https://blast.test", pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
  const previousFrames = { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
  Object.assign(globalThis, { requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", ...asset });
  const panel = store.getSnapshot().panels.A!;
  let reads = 0, chartReads = 0;
  // No count anywhere: the coin summary says the coin is no Blast launch (kept until the panel observes it).
  const client = createTestQueryClient({ queries: { gcTime: Infinity } });
  client.setQueryData(queryKeys.workspace.coinSummary(panel.network, panel.coin_type), null);
  const source: CoinPanelProps["reads"] = {
    coin: async current => ({ coin_type: current.coin_type, symbol: "A", name: "A", decimals: 9, price_usd: null, holders: ++reads === 1 ? null : 284, holders_as_of_ms: reads === 1 ? null : Date.now() - 3 * 86_400_000 }),
    chart: async () => { chartReads++; return null; },
    holders: async () => null,
    activity: async () => null,
  };
  const root = createRoot(document.getElementById("mount")!);
  try {
    await act(async () => root.render(<QueryProvider client={client}><CoinPanel focus panel_id="A" asset={panel} coin_setup={panel.coin} onSetupChange={() => {}} effective_visibility reads={source} actions={{ trade: null, authenticated: false, actor_key: "guest", signIn() {} }} /></QueryProvider>));
    assert.equal(document.querySelector('[aria-label="Inspect full holder count unavailable: No holder-count observation is available for this coin."]'), null);
    // Audit 12: an unknown holder count keeps its slot, as a dash, beside its refresh.
    assert.match(document.querySelector('[aria-label="Selected market facts"]')!.textContent!, /FDV—unavailableHolders—unavailable/);
    assert.doesNotMatch(document.querySelector('[aria-label="Selected market facts"]')!.textContent!, /Time unknown/);
    const before = chartReads;
    const refresh = document.querySelector<HTMLButtonElement>('[aria-label="Refresh holder count"]')!;
    refresh.focus();
    await act(async () => refresh.click());
    const facts = document.querySelector('[aria-label="Selected market facts"]')!;
    assert.match(facts.textContent!, /284/);
    // #488: the refresh a keyboard user pressed is the same node after the read, so it keeps focus.
    assert.equal(document.activeElement, refresh);
    assert.equal(refresh.getAttribute("aria-label"), "Refresh holder count, changed 3d ago");
    // Freshness belongs to the refresh control's name, not a visible narration line.
    assert.doesNotMatch(facts.textContent!, /Changed|Updated/);
    assert.ok(facts.querySelector('[aria-label="Refresh holder count, changed 3d ago"]'));
    assert.ok(facts.querySelector('[aria-label*="Last count change:"]'));
    assert.equal(chartReads, before, "holder refresh does not reload chart history");
    assert.equal(reads, 2);
  } finally { await act(async () => root.unmount()); client.clear(); Object.assign(globalThis, previousFrames); dom.window.close(); }
});


test("#488: with amounts hidden the holder refresh keeps focus when the count arrives", async () => {
  const dom = new JSDOM('<div data-blast-ui data-amounts="hidden"><div id="mount"></div></div>', { url: "https://blast.test", pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
  const previousFrames = { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame };
  Object.assign(globalThis, { requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window) });
  notifyShellPrefs();
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", ...asset });
  const panel = store.getSnapshot().panels.A!;
  let reads = 0;
  const source: CoinPanelProps["reads"] = {
    coin: async current => ({ coin_type: current.coin_type, symbol: "A", name: "A", decimals: 9, price_usd: null, holders: ++reads === 1 ? null : 284, holders_as_of_ms: reads === 1 ? null : Date.now() - 3 * 86_400_000 }),
    chart: async () => null,
    holders: async () => null,
    activity: async () => null,
  };
  const root = createRoot(document.getElementById("mount")!);
  try {
    await act(async () => root.render(<CoinPanel focus panel_id="A" asset={panel} coin_setup={panel.coin} onSetupChange={() => {}} effective_visibility reads={source} actions={{ trade: null, authenticated: false, actor_key: "guest", signIn() {} }} />));
    const refresh = document.querySelector<HTMLButtonElement>('[aria-label="Refresh holder count"]')!;
    refresh.focus();
    await act(async () => refresh.click());
    const facts = document.querySelector('[aria-label="Selected market facts"]')!;
    // The count is known now and hidden; the refresh beside it is the node the keyboard user pressed.
    assert.match(facts.textContent!, /Holders••••/);
    assert.doesNotMatch(facts.textContent!, /284/);
    assert.equal(document.activeElement, refresh);
    assert.equal(reads, 2);
  } finally { await act(async () => root.unmount()); Object.assign(globalThis, previousFrames); dom.window.close(); notifyShellPrefs(); }
});

test("price and holder inspection distinguishes old observations from successful checks", async () => {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', { url: "https://blast.test", pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true });
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", ...asset });
  const panel = store.getSnapshot().panels.A!;
  const time = handClock(1_800_000_000_000);
  let observation: number | null = 1_790_000_000_000;
  const reads: CoinPanelProps["reads"] = {
    coin: async () => ({ coin_type: panel.coin_type, symbol: "A", name: "A", decimals: 9, price_usd: "0.0021", price_as_of_ms: observation, holders: 512, holders_as_of_ms: observation }),
    chart: async () => null, holders: async () => null, activity: async () => null,
  };
  const root = createRoot(document.getElementById("mount")!);
  const client = createTestQueryClient();
  const inspector = (label: string) => document.querySelector(`[aria-label^="Inspect full ${label}"]`)!.getAttribute("aria-label")!;
  try {
    await act(async () => root.render(<QueryProvider client={client}><WorkspaceLiveProvider clock={time.clock}><CoinPanel focus panel_id="A" asset={panel} coin_setup={panel.coin} onSetupChange={() => {}} effective_visibility actions={{ trade: null, authenticated: false, actor_key: "guest", signIn() {} }} reads={reads} /></WorkspaceLiveProvider></QueryProvider>));
    for (const label of ["observed USD price", "holder count observation"]) {
      assert.match(inspector(label), /2026-09-21T14:13:20.000Z/);
      assert.match(inspector(label), /Last checked 2027-01-15T08:00:00.000Z/);
    }
    await act(async () => time.advance(15_000));
    assert.match(inspector("observed USD price"), /2026-09-21T14:13:20.000Z/);
    assert.match(inspector("observed USD price"), /Last checked 2027-01-15T08:00:15.000Z/);
    observation = null;
    await act(async () => time.advance(15_000));
    assert.doesNotMatch(inspector("observed USD price"), /Observation time unavailable/);
    assert.doesNotMatch(inspector("holder count observation"), /Observation time unavailable/);
    assert.match(inspector("observed USD price"), /Last checked 2027-01-15T08:00:30.000Z/);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    assert.equal(time.timers.size, 0);
    dom.window.close();
  }

});

test("the composer prices typing and its presets from the browser's route; only a press asks the server", async (t) => {
  mockTradeWallet(t);
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', { url: "https://blast.test" });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const client = createTestQueryClient();
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", ...asset, coin_type: fixtureCoinType("KSTL") });
  const panel = store.getSnapshot().panels.A!;
  store.patchPanel("A", { coin: { ...panel.coin, trade: { ...panel.coin.trade, buy: { typed: "100", mode: "typed" } } } });
  const routed: bigint[] = [];
  let served = 0;
  const sends: TradeSendInput[] = [];
  const kit: NonNullable<CoinPanelProps["actions"]["trade"]> = {
    signedIn: true,
    signIn() {},
    wallet: async () => fixtureWallet(),
    route: async (request) => {
      routed.push(request.amount);
      const amountOut = request.amount * 476_000n;
      const path = { poolId: "0x1", provider: "CETUS", direction: true, from: request.from, target: request.target, feeRate: "0.0025", amountIn: request.amount, amountOut, publishedAt: "0x2" };
      return { status: "route", route: { requestId: "r", amountIn: request.amount, amountOut, blastFee: amountOut / 199n, deviationRatio: "0", aggregatorPackage: "0x3", paths: [path] } };
    },
    quote: async (request) => {
      served++;
      const sealed = fixtureTradeQuote(request, { signedIn: true, fee: "blast", nowMs: Date.now(), wallet: fixtureWallet() });
      // Sealed at the estimate's price: a lower one is shown first and needs its own press (ActionConfirmation's test).
      return { status: "ok", quote: { ...sealed, amount_out: (BigInt(sealed.amount_in!) * 476_000n).toString() } };
    },
    send: async (input) => {
      sends.push(input);
      return { status: "pending", title: "Pending" };
    },
  };
  function Subject() {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const current = snapshot.panels.A!;
    return (
      <TradeTestQueries client={client}>
        <CoinPanel
          panel_id="A"
          asset={current}
          coin_setup={current.coin}
          onSetupChange={(coin) => store.patchPanel("A", { coin })}
          effective_visibility
          actions={{ trade: kit, authenticated: true, confirmation: { status: "ready", enabled: false }, actor_key: "account:A", signIn() {} }}
          reads={{
            coin: async () => ({ coin_type: panel.coin_type, symbol: "KSTL", name: "Kestrel", decimals: 9, price_usd: "0.0021" }),
            chart: async () => null,
            holders: async () => null,
            activity: async () => null,
          }}
        />
      </TradeTestQueries>
    );
  }
  const root = createRoot(document.getElementById("mount")!);
  const submit = () => document.querySelector<HTMLButtonElement>("[data-coin-submit]")!;
  try {
    await act(async () => root.render(<Subject />));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
    assert.deepEqual([...routed].sort((a, b) => (a < b ? -1 : 1)), [50_000_000n, 100_000_000n, 500_000_000n, 860_000_000n], "the $50, $100, $500 and Max presets are each read ahead once; the typed $100 is one of them");
    assert.equal(served, 0, "no server call while typing or for the presets");
    assert.equal(submit().disabled, false, "the estimate turns the button on");
    await act(async () => submit().click());
    assert.equal(served, 1, "the press seals the quote on the server, once");
    assert.equal(sends.length, 1);
    assert.notEqual(sends[0]!.quote.quote_id, null, "what is sent is the sealed quote");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    dom.window.close();
  }
});

test("buy presets are read ahead again only once the counter's price moves an amount 1% or more", () => {
  const ask = (amount_in: string) => ({ in_coin: "0x2::sui::SUI", out_coin: "0x5::kstl::KSTL", side: "buy" as const, amount_in, slippage_bps: 50 });
  const kept = [ask("1000000000"), ask("2000000000")];
  assert.equal(closeRequests(kept, [ask("1009000000"), ask("1991000000")]), true, "a 0.9% tick keeps the read-ahead");
  assert.equal(closeRequests(kept, [ask("1010000000"), ask("2000000000")]), false, "1% asks again");
  assert.equal(closeRequests(kept, [{ ...ask("1000000000"), slippage_bps: 100 }, ask("2000000000")]), false, "any other change asks again");
  assert.equal(closeRequests(kept, [ask("1000000000")]), false);
});

/** A Blast launch's coin summary as the market relay gives it (BGBCAT's figures on 2026-11-20). */
function launchSummary(over: Partial<CoinSummary> = {}): CoinSummary {
  const day = { volumeQuote: 0n, volumeUsd: "821.40", buys: 30, sells: 12, trades: 42 };
  return {
    coinType: "0x2::coin::A", decimals: 9, quoteDecimals: 9, creator: null, creatorSource: null,
    currentPool: "bluefin:0x5fbc460d5a677cbbfa7e1b7f2872fb4fa5377d7764f84305ce374f0e325a4115", pools: [], supply: 1_000_000_000n, marketCap: 1n,
    stats: { day, all: day, holders: 8 },
    market: { market_cap_usd: "6.52", fdv_usd: "9.43", change_24h_bps: null, interval_end_ms: 1, baseline_timestamp_ms: null, baseline_pool: null, current_pool: "bluefin:0x5fbc460d5a677cbbfa7e1b7f2872fb4fa5377d7764f84305ce374f0e325a4115", basis: "usd_price", baseline_resolution_ms: 300_000 },
    ...over,
  } as CoinSummary;
}

async function renderFacts(record: Record<string, unknown>, summary: CoinSummary | null | undefined, panelAsset: typeof asset | (Omit<typeof asset, "presale_id"> & { presale_id: string }) = asset) {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', { url: "https://blast.test", pretendToBeVisual: true });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true });
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", ...panelAsset });
  const panel = store.getSnapshot().panels.A!;
  const client = createTestQueryClient({ queries: { gcTime: Infinity } });
  const key = queryKeys.workspace.coinSummary(panel.network, panel.coin_type);
  if (summary !== undefined) client.setQueryData(key, summary);
  const reads: CoinPanelProps["reads"] = {
    coin: async () => ({ coin_type: panel.coin_type, symbol: "A", name: "A", decimals: 9, price_usd: "0.0000000065", ...record }),
    chart: async () => null, holders: async () => null, activity: async () => null,
  };
  const root = createRoot(document.getElementById("mount")!);
  await act(async () => root.render(<QueryProvider client={client}><CoinPanel focus panel_id="A" asset={panel} coin_setup={panel.coin} onSetupChange={() => {}} effective_visibility actions={{ trade: null, authenticated: false, actor_key: "guest", signIn() {} }} reads={reads} /></QueryProvider>));
  const facts = document.querySelector('[aria-label="Selected market facts"]')!.textContent!;
  await act(async () => root.unmount());
  client.clear();
  dom.window.close();
  return { facts };
}

test("a Blast launch with no presale shows its coin summary's FDV, holders and 24h volume, as its coin page does", async () => {
  const { facts } = await renderFacts({ fdv_usd: null, holders: null }, launchSummary());
  assert.equal(facts, "24h volume$821FDV$9.4Holders8");
});

test("the summary's 24h volume holds when no Discover list carries the coin, and a summary without FDV keeps the dash", async () => {
  const { facts } = await renderFacts({ fdv_usd: null, holders: null, activity: undefined }, launchSummary({ market: null }));
  assert.match(facts, /^24h volume\$821FDV—unavailableHolders8$/);
});

test("the feed's FDV and holders win over the summary, and a presale coin never takes the summary's figures", async () => {
  const known = await renderFacts({ fdv_usd: "12500", holders: 40 }, launchSummary());
  assert.match(known.facts, /FDV\$12\.5KHolders40$/);
  const presale = await renderFacts({ fdv_usd: null, holders: null }, launchSummary(), { ...asset, presale_id: "0x" + "ab".repeat(32) });
  assert.match(presale.facts, /^24h volume—unavailableFDV—unavailableHolders—unavailable$/);
});

test("a day of trades with no USD price is no $0 volume, and the summary still provides FDV", async () => {
  const day = { volumeQuote: 5n, volumeUsd: "0", buys: 3, sells: 0, trades: 3 };
  const unpriced = await renderFacts({ fdv_usd: null, holders: null }, launchSummary({ stats: { day, all: day, holders: 8 } }));
  assert.match(unpriced.facts, /^24h volume—unavailableFDV\$9\.4Holders8$/);
  const notLaunch = await renderFacts({ fdv_usd: null, holders: null }, null);
  assert.match(notLaunch.facts, /^24h volume—unavailableFDV—unavailableHolders—unavailable$/);
});
