import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { TradeRoute } from "@blast/core/modules/social/trades/cetus-route.ts";
import { SOCIAL_PRICES_PATH } from "@blast/core/modules/social/contracts/prices.ts";

import { installTestDom, setInputValue, waitFor } from "../../../../test/fixtures/social/test-dom.ts";
import { DEFAULT_SWAP_MODE, FIXTURE_COINS } from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";
import { fixtureQuote } from "../../../../test/fixtures/social/coins/swap-fixture.ts";
import type { TradeRouteFinder } from "../trade/trade-estimate.ts";
import type { CoinSheetTrading } from "./SwapForm.tsx";
import { PUBLIC_BASE_COINS, type WalletCoinView } from "./coin-model.ts";

const dom = installTestDom();
Object.assign(dom.document, { oninput: null });
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, settleQueries, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { invalidateAfter } = await import("#web/lib/query/invalidate.ts");
const { SocialViewerProvider } = await import("../SignInGate");
const { SwapForm } = await import("./SwapForm");
const { typedAmount } = await import("../trade/trade-ticket.ts");

const ADDRESS = `0x${"c".repeat(64)}`;
// The two coins as Swap has them when Trade is opened directly: no holdings, and no dollar price for any coin but USDC.
const USDC = PUBLIC_BASE_COINS[0]!;
const SUI = PUBLIC_BASE_COINS[1]!;
const PIP: WalletCoinView = { ...SUI, key: "pip-sale", coinType: `0x${"ab".repeat(32)}::pip::PIP`, symbol: "PIP", name: "Pip", presale: { presaleId: `0x${"1".repeat(64)}`, venue: "cetus", trading: true, multiple: null } };

/** Cetus's answer from the browser: `amountOut` of what is asked for. */
function routes(amountOut: (from: string) => bigint): TradeRouteFinder {
  return async ({ from, target, amount }) => {
    const out = amountOut(from);
    const route: TradeRoute = {
      requestId: "r", amountIn: amount, amountOut: out, aggregatorPackage: "0x3", deviationRatio: "0.003", blastFee: 0n,
      paths: [{ poolId: "0x1", provider: "CETUS", direction: true, from, target, feeRate: "0.0025", amountIn: amount, amountOut: out, publishedAt: "0x2" }],
    };
    return { status: "route", route };
  };
}

/** The wallet read (`balance_coin`) and the public price read, as the browser asks them. */
function server(t: TestContext, options: Readonly<{ balances: Record<string, string>; prices: Record<string, string>; priceAgeMs?: number }>) {
  const balanceReads: string[] = [];
  const priceReads: string[] = [];
  const state = { balances: options.balances, held: null as null | (() => void)[], failing: new Set<string>() };
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://blast.test");
    if (url.pathname === SOCIAL_PRICES_PATH) {
      const asked = url.searchParams.getAll("coin");
      priceReads.push(asked.join(","));
      const now = Date.now();
      return Response.json({
        window: "1h", clock_ms: now, as_of: { checkpoint: 1, timestamp_ms: now, lag_ms: 0 },
        prices: asked.filter((coin) => options.prices[coin] !== undefined).map((coin) => ({
          presale_id: null, coin_type: coin, tier: "5m", from_ms: 0, points: [], price_usd: options.prices[coin],
          price_as_of_ms: now - (options.priceAgeMs ?? 0), price_24h_usd: null, change_24h_bps: null, day_open_usd: null, day_open_ms: null,
        })),
      });
    }
    assert.equal(url.pathname, "/api/social/me/wallet");
    const coin = url.searchParams.get("balance_coin")!;
    balanceReads.push(coin);
    if (state.held) await new Promise<void>((resolve) => state.held!.push(resolve));
    if (state.failing.has(coin)) return new Response(null, { status: 503 });
    return Response.json({ address: ADDRESS, coin_type: coin, atoms: state.balances[coin] ?? "0", as_of_ms: Date.now() });
  });
  return { balanceReads, priceReads, state };
}

/** What the host says about the viewer and the screen. */
type Viewer = Readonly<{ signedIn: boolean; sessionPending: boolean; active: boolean }>;
const READY: Viewer = { signedIn: true, sessionPending: false, active: true };

async function openSwap(t: TestContext, pair: readonly [WalletCoinView, WalletCoinView], findRoute: TradeRouteFinder, first: Viewer = READY,
  money: Partial<Pick<CoinSheetTrading, "requestQuote" | "trade">> = {}) {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  const client = createTestQueryClient();
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  const host: { list?: (next: readonly [WalletCoinView, WalletCoinView]) => void; viewer?: (next: Viewer) => void } = {};
  function Screen() {
    const [coins, setCoins] = useState(pair);
    host.list = setCoins;
    const [viewer, setViewer] = useState(first);
    host.viewer = setViewer;
    const [field, setField] = useState(() => typedAmount("", pair[0].decimals));
    return <SwapForm active={viewer.active} inCoin={coins[0]} outCoin={coins[1]} field={field} onField={setField} detail={false} onDetail={() => {}}
      onFlip={(next) => { setCoins([coins[1], coins[0]]); setField(next); }} onPick={() => {}} hidden={false} walletFee="sponsored"
      // The host says it holds no coin list yet, as it does when Trade is opened directly.
      trading={{ signedIn: viewer.signedIn, sessionPending: viewer.sessionPending, balanceKnown: false, walletAddress: ADDRESS, onSignIn() {}, listCoins: async () => [], findRoute,
        requestQuote: async () => ({ status: "error" }), trade: async () => ({ status: "traded" }), ...money }} />;
  }
  const settle = () => act(() => settleQueries(client, 30_000));
  /** The estimate leaves after the typing pause; its balances and prices follow. */
  const quoted = async () => {
    await waitFor(() => container.querySelector("[data-out]")?.textContent !== "—", "the estimate");
    await settle();
  };
  await act(async () => root.render(withQueryClient(client,
    <SocialViewerProvider signedIn callsign="pilot" getAccessToken={async () => "fixture"}><Screen /></SocialViewerProvider>)));
  await settle();
  const type = async (value: string) => {
    const input = container.querySelector<HTMLInputElement>("input")!;
    await act(async () => { setInputValue(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    await quoted();
  };
  const panels = () => [...container.querySelectorAll("[data-panel]")].map((panel) => panel.textContent!.replaceAll("\u00a0", " "));
  const swap = () => container.querySelector<HTMLButtonElement>("[data-trade]")!;
  const max = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Max")!;
  const flip = async () => { await act(async () => container.querySelector<HTMLButtonElement>("[data-flip]")!.click()); await quoted(); };
  /** The host's coin list arrives, with whatever prices it has. */
  const list = async (next: readonly [WalletCoinView, WalletCoinView]) => { await act(async () => host.list!(next)); await settle(); };
  const view = async (next: Viewer) => { await act(async () => host.viewer!(next)); await settle(); };
  return { container, client, settle, type, panels, swap, max, flip, list, view };
}

for (const coin of [SUI, PIP]) {
  test(`Swap shows both balances and values ${coin.symbol}, which has no price of its own, before and after a flip`, async (t) => {
    const api = server(t, { balances: { [USDC.coinType]: "50000000", [coin.coinType]: "7000000000" }, prices: { [coin.coinType]: "2" } });
    // 10 USDC buys 4 coins worth $8; those 4 coins sell back for 6.4 USDC.
    const screen = await openSwap(t, [USDC, coin], routes((from) => (from === USDC.coinType ? 4_000_000_000n : 6_400_000n)));
    await screen.type("10");

    let [pay, receive] = screen.panels();
    assert.match(pay!, /Balance 50 USDC/);
    assert.match(receive!, new RegExp(`Balance 7 ${coin.symbol}`));
    assert.match(receive!, /≈ \$8\.00/);
    assert.match(screen.container.textContent!, /Low payout\. About 20% below/);
    assert.deepEqual([...api.balanceReads].sort(), [USDC.coinType, coin.coinType].sort());
    assert.deepEqual(api.priceReads, [coin.coinType], "one price read, for the coin without a price only");

    await screen.flip();
    [pay, receive] = screen.panels();
    assert.match(pay!, new RegExp(`Balance 7 ${coin.symbol}`));
    assert.match(pay!, /≈ \$8\.00/);
    assert.match(receive!, /Balance 50 USDC/);
    assert.match(screen.container.textContent!, /Low payout\. About 20% below/);
  });
}

test("Swap reads neither balance until it is the screen in use of a signed-in viewer", async (t) => {
  const api = server(t, { balances: {}, prices: {} });
  const screen = await openSwap(t, [USDC, SUI], routes(() => 4_000_000_000n), { ...READY, active: false });
  assert.deepEqual([api.balanceReads, api.priceReads], [[], []], "a screen not in use asks for no balance and no price");
  await screen.view({ ...READY, signedIn: false });
  await screen.view({ ...READY, sessionPending: true });
  assert.deepEqual(api.balanceReads, []);
  for (const panel of screen.panels()) assert.match(panel, /Checking balance/, "both sides wait alike while the session is restored");

  await screen.view(READY);

  assert.equal(api.balanceReads.length, 2);
});

test("Swap asks no price for a coin whose list gave one", async (t) => {
  const api = server(t, { balances: {}, prices: {} });
  const screen = await openSwap(t, [USDC, { ...SUI, price: 2 }], routes(() => 4_000_000_000n));
  await screen.type("10");

  assert.match(screen.panels()[1]!, /≈ \$8\.00/);
  assert.deepEqual(api.priceReads, []);
});

test("a price the coin list brings after the estimate values it, with no new route asked", async (t) => {
  server(t, { balances: {}, prices: {} });
  let asked = 0;
  const answer = routes(() => 4_000_000_000n);
  const screen = await openSwap(t, [USDC, SUI], (request) => { asked += 1; return answer(request); });
  await screen.type("10");
  assert.match(screen.panels()[1]!, /SUI—$/);
  const before = asked;

  await screen.list([USDC, { ...SUI, price: 2 }]);

  assert.match(screen.panels()[1]!, /≈ \$8\.00/);
  assert.equal(asked, before);
});

test("the last answer, kept faint while a new amount is asked, keeps its dollar value", async (t) => {
  server(t, { balances: {}, prices: { [SUI.coinType]: "2" } });
  const screen = await openSwap(t, [USDC, SUI], routes(() => 4_000_000_000n));
  await screen.type("10");

  const input = screen.container.querySelector<HTMLInputElement>("input")!;
  await act(async () => { setInputValue(input, "20"); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });

  assert.match(screen.panels()[1]!, /4SUI≈ \$8\.00/);
});

test("after a trade both balances are read again; the last numbers stay up while Max and Swap wait for the new ones", async (t) => {
  const api = server(t, { balances: { [USDC.coinType]: "50000000", [SUI.coinType]: "7000000000" }, prices: { [SUI.coinType]: "2" } });
  const screen = await openSwap(t, [USDC, SUI], routes(() => 4_900_000_000n));
  await screen.type("10");
  assert.equal(screen.max().disabled, false);
  assert.equal(screen.swap().disabled, false);

  api.state.held = [];
  api.state.balances = { [USDC.coinType]: "40000000", [SUI.coinType]: "12000000000" };
  await act(async () => { void invalidateAfter(screen.client, { kind: "trade" }); });
  await waitFor(() => api.state.held!.length === 2 && (screen.max().disabled || screen.swap().disabled), "the form to notice both balances are being read again");
  let [pay, receive] = screen.panels();
  assert.match(pay!, /Balance 50 USDC/);
  assert.match(receive!, /Balance 7 SUI/);
  assert.equal(screen.max().disabled, true);
  assert.equal(screen.swap().disabled, true);
  const described = screen.swap().getAttribute("aria-describedby")!.split(" ").map((id) => screen.container.querySelector(`[id="${id}"]`)?.textContent ?? "").join(" ");
  assert.match(described, /Checking your balance…/, "the line beside the waiting button says what it waits for");

  await act(async () => { api.state.held!.splice(0).forEach((release) => release()); });
  api.state.held = null;
  await screen.settle();
  [pay, receive] = screen.panels();
  assert.match(pay!, /Balance 40 USDC/);
  assert.match(receive!, /Balance 12 SUI/);
  assert.equal(screen.max().disabled, false);
  assert.equal(screen.swap().disabled, false);
  assert.equal(api.balanceReads.length, 4, "two reads on opening, two after the trade");
});

test("a balance read that fails after a good one shows a dash, never the old number", async (t) => {
  const api = server(t, { balances: { [USDC.coinType]: "50000000", [SUI.coinType]: "7000000000" }, prices: { [SUI.coinType]: "2" } });
  const screen = await openSwap(t, [USDC, SUI], routes(() => 4_900_000_000n));
  await screen.type("10");

  api.state.failing.add(USDC.coinType).add(SUI.coinType);
  await act(async () => { void invalidateAfter(screen.client, { kind: "trade" }); });
  await waitFor(() => screen.panels().every((panel) => panel.includes("Balance —")), "both failed reads to show as a dash");

  assert.equal(screen.max().disabled, true);
});

test("a failed balance read of the coin you receive and an old price both show a dash and leave Swap usable", async (t) => {
  const api = server(t, { balances: { [USDC.coinType]: "50000000" }, prices: { [SUI.coinType]: "2" }, priceAgeMs: 10 * 60_000 });
  api.state.failing.add(SUI.coinType);
  const screen = await openSwap(t, [USDC, SUI], routes(() => 4_000_000_000n));
  await screen.type("10");

  const [, receive] = screen.panels();
  assert.match(receive!, /Balance —/);
  assert.match(receive!, /SUI—$/, "the dollar value is a dash");
  assert.doesNotMatch(screen.container.textContent!, /\$8\.00|Low payout|could not load/);
  assert.equal(screen.swap().disabled, false);
});

/** A sealed quote for 10 USDC to 4 SUI, with no dollar value for what you receive. */
function sealedAnswer(ask: Parameters<CoinSheetTrading["requestQuote"]>[0]): Awaited<ReturnType<CoinSheetTrading["requestQuote"]>> {
  return { status: "ok", httpStatus: 200, body: { ...fixtureQuote(ask, FIXTURE_COINS, DEFAULT_SWAP_MODE, Date.now()), quote_id: "q1.sealed", expires_at_ms: Date.now() + 60_000,
    amount_out: "4000000000", min_out: "3999000000", price_impact_bps: 0, amount_in_usd: "10.00", amount_out_usd: null, offer_refused: null, dry_run: "passed" } };
}

test("once a sealed quote asks for a payout review, a price that later goes missing never sends it without the second press", async (t) => {
  const prices: Record<string, string> = {};
  const api = server(t, { balances: { [USDC.coinType]: "50000000", [SUI.coinType]: "7000000000" }, prices });
  let answer: () => void = () => {};
  let sent = 0;
  const screen = await openSwap(t, [USDC, SUI], routes(() => 4_000_000_000n), READY, {
    requestQuote: async (ask) => {
      await new Promise<void>((resolve) => { answer = resolve; });
      return sealedAnswer(ask);
    },
    trade: async () => { sent += 1; return { status: "traded" }; },
  });
  await screen.type("10");
  assert.doesNotMatch(screen.container.textContent!, /Low payout/);
  await act(async () => screen.swap().click());
  const reprice = async (price: string | null, shown: () => boolean) => {
    if (price === null) delete prices[SUI.coinType];
    else prices[SUI.coinType] = price;
    await act(() => screen.client.refetchQueries({ type: "active", predicate: (query) => JSON.stringify(query.queryKey).includes("price") }));
    await waitFor(shown, "the new price to reach the screen");
  };
  await reprice("2", () => screen.container.textContent!.includes("Low payout"));
  await act(async () => answer());
  await screen.settle();
  assert.match(screen.container.textContent!, /Review the payout before confirming\./);

  await reprice(null, () => screen.panels()[1]!.endsWith("SUI—"));
  // The balances are read again while the question is on screen.
  api.state.held = [];
  await act(async () => { void invalidateAfter(screen.client, { kind: "trade" }); });
  await waitFor(() => api.state.held!.length === 2 && screen.max().disabled, "the form to notice both balances are being read again");
  await act(async () => { api.state.held!.splice(0).forEach((release) => release()); });
  api.state.held = null;
  await screen.settle();

  assert.equal(sent, 0);
  assert.match(screen.container.textContent!, /Low payout\. About 20% below/);
  assert.match(screen.container.textContent!, /Review the payout before confirming\./);
  await act(async () => screen.swap().click());
  await screen.settle();
  assert.equal(sent, 1);
});

test("a low payout already on screen at the press needs no second press when the sealed quote agrees", async (t) => {
  server(t, { balances: { [USDC.coinType]: "50000000", [SUI.coinType]: "7000000000" }, prices: { [SUI.coinType]: "2" } });
  let sent = 0;
  const screen = await openSwap(t, [USDC, SUI], routes(() => 4_000_000_000n), READY, {
    requestQuote: async (ask) => sealedAnswer(ask),
    trade: async () => { sent += 1; return { status: "traded" }; },
  });
  await screen.type("10");
  assert.match(screen.container.textContent!, /Low payout\. About 20% below/);

  await act(async () => screen.swap().click());
  await screen.settle();

  assert.equal(sent, 1);
});
