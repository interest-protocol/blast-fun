import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import type { SocialTradeQuoteRequest } from "@blast/core/modules/social/contracts/trades.ts";

import { installTestDom, setInputValue, recordAnimations, testEvent, type TestElement } from "../../../../test/fixtures/social/test-dom.ts";
import type { CoinScreen } from "./coin-model";

/**
 * OA-48: the trade screen is named for the action that opened it. A sale's
 * Buy or Sell (`openTrade` with its coin) opens `Buy KSTL` / `Sell KSTL` with
 * the button `Buy 47,604 KSTL for 100 USDC` / `Sell … for … USDC`; the flip
 * turns one into the other at once; another pair, the plain swap and a coin's
 * own Trade are the Swap board's `Swap`. In a running sheet (jsdom), with
 * quotes answered as the fixture answers them.
 */

const { document } = installTestDom();
// React decides at load whether the browser has `input` events (`'oninput' in document`); this one does.
Object.defineProperty(document, "oninput", { value: null, writable: true, configurable: true });
const motion = recordAnimations();

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { CoinSheet } = await import("./CoinSheet");
const { DEFAULT_SWAP_MODE, FIXTURE_COINS, FIXTURE_WALLET_ADDRESS } = await import("../../../../test/fixtures/social/coins/coins-fixture-model.ts");
const { fixtureQuote } = await import("../../../../test/fixtures/social/coins/swap-fixture.ts");
const { encodeTradeAction, tradeOpening } = await import("./swap-model");

const KSTL = FIXTURE_COINS.find((coin) => coin.symbol === "KSTL")!;
const KSTL_ACTION = (side: "buy" | "sell") =>
  encodeTradeAction({
    side,
    coin: { coin_type: KSTL.coinType, symbol: "KSTL", name: "Kestrel", decimals: 9, icon_url: null, usd_price: "0.0021", presale_id: KSTL.key },
  });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function mount(t: TestContext, first: CoinScreen) {
  const asked: SocialTradeQuoteRequest[] = [];
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const client = createTestQueryClient();
  const trading = {
    signedIn: true,
    onSignIn: () => undefined,
    async requestQuote(body: SocialTradeQuoteRequest) {
      asked.push(body);
      return { status: "ok" as const, body: fixtureQuote(body, FIXTURE_COINS, DEFAULT_SWAP_MODE, Date.now()), httpStatus: 200 };
    },
    listCoins: async () => [],
    trade: async () => ({ status: "traded" as const }),
  };
  await act(async () =>
    root.render(
      withQueryClient(
        client,
        <CoinSheet
          first={first}
          onClose={() => undefined}
          onCopy={() => undefined}
          onRetry={() => undefined}
          onWithdraw={async () => false}
          open
          session={1}
          trading={trading}
          wallet={{ status: "ready", address: FIXTURE_WALLET_ADDRESS, fee: "sponsored", coins: FIXTURE_COINS }}
        />,
      ),
    ),
  );
  await settle(0);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.parentNode?.removeChild(container);
  });
  const $ = (selector: string) => document.querySelector<HTMLElement>(selector) as TestElement | null;
  const dialog = () => $('[role="dialog"]')!;
  return {
    $,
    asked,
    /** The dialog's accessible name: the text of the element its `aria-labelledby` names. */
    name: () => document.getElementById(dialog().getAttribute("aria-labelledby")!)?.textContent ?? null,
    title: () => dialog().querySelector<HTMLElement>("h2")?.textContent ?? null,
    cta: () => $("[data-trade]")?.textContent ?? null,
  };
}

/** Time passes: every motion reaches its end, and the quote's pause and answer have run. */
async function settle(ms: number) {
  await act(async () => motion.finishAll());
  await act(async () => wait(ms));
}

async function click(element: TestElement | null) {
  assert.ok(element !== null, "the control is on the page");
  await act(async () => element.click());
}

async function typeInto(field: TestElement | null, value: string) {
  assert.ok(field !== null);
  const input = field as TestElement & { value: string; type?: string };
  input.type = "text";
  await act(async () => {
    setInputValue(input, value);
    input.dispatchEvent(testEvent("input", { bubbles: true }));
  });
}

const amount = (h: Awaited<ReturnType<typeof mount>>) => h.$("[data-coin-focus]");

test("OA-48: a sale's Buy opens `Buy KSTL`, named so for screen readers, with focus on the amount; the button says the buy", async (t) => {
  const h = await mount(t, tradeOpening(KSTL_ACTION("buy"))!.screen);
  assert.equal(h.title(), "Buy KSTL");
  assert.equal(h.name(), "Buy KSTL", "the dialog's accessible name is the title");
  assert.ok(document.activeElement === amount(h), "focus is on the amount field");
  assert.equal(h.cta(), "Buy KSTL", "no amount: the button keeps the buy, off, and the line above asks for one");
  await typeInto(amount(h), "100");
  await settle(400);
  assert.equal(h.asked.length, 1);
  assert.match(h.cta()!, /^Buy [\d,.]+\u00a0KSTL$/);
});

test("OA-48: a sale's Sell opens `Sell KSTL`; the button reads Sell {in} KSTL for {out} USDC", async (t) => {
  const h = await mount(t, tradeOpening(KSTL_ACTION("sell"))!.screen);
  assert.equal(h.title(), "Sell KSTL");
  assert.equal(h.name(), "Sell KSTL");
  await typeInto(amount(h), "1000");
  await settle(400);
  assert.match(h.cta()!, /^Sell 1,000\u00a0KSTL$/);
  await typeInto(amount(h), "700000");
  assert.equal(h.cta(), "Sell KSTL", "over the balance: the verb stays, off; the line above says why");
});

test("OA-48: the flip turns Buy into Sell and back at once, title and button", async (t) => {
  const h = await mount(t, tradeOpening(KSTL_ACTION("buy"))!.screen);
  await typeInto(amount(h), "100");
  await settle(400);
  await click(h.$("[data-flip]"));
  assert.equal(h.title(), "Sell KSTL", "renamed in the same press, before any answer");
  assert.equal(h.name(), "Sell KSTL");
  assert.equal([...h.$('[role="dialog"]')!.querySelectorAll<HTMLElement>("[data-trade]")].length, 1, "the same screen, flipped in place (no step swap)");
  assert.ok(document.activeElement === amount(h), "focus stays on the amount");
  await settle(400);
  assert.match(h.cta()!, /^Sell [\d,.]+\u00a0KSTL$/);
  await click(h.$("[data-flip]"));
  assert.equal(h.title(), "Buy KSTL");
  assert.equal(h.$("[data-flip]")!.style.transform, "rotate(360deg)", "the button turns on from where it is: two flips, one full turn");
  await settle(400);
  assert.match(h.cta()!, /^Buy [\d,.]+\u00a0KSTL$/);
});

test("the focused coin stays a buy when the payment coin changes", async (t) => {
  const h = await mount(t, tradeOpening(KSTL_ACTION("buy"))!.screen);
  // You sell: pick SUI from the picker's quick choices.
  await click(h.$('[aria-label="Change sell token (USDC)"]'));
  await settle(0);
  assert.equal(h.title(), "Select payment coin");
  await click([...document.querySelectorAll<HTMLElement>('[aria-label="Quick choices"] button')].find((chip) => chip.textContent.includes("SUI")) ?? null);
  await settle(0);
  assert.equal(h.title(), "Buy KSTL", "buying the focused coin works with SUI too");
  assert.equal(h.name(), "Buy KSTL");
  await typeInto(amount(h), "10");
  await settle(400);
  assert.match(h.cta()!, /^Buy [\d,.]+\u00a0KSTL$/);
  // And back to USDC: the coin in focus is kept, so it is a buy again.
  await click(h.$('[aria-label="Change sell token (SUI)"]'));
  await settle(0);
  await click([...document.querySelectorAll<HTMLElement>('[aria-label="Quick choices"] button')].find((chip) => chip.textContent.includes("USDC")) ?? null);
  await settle(0);
  assert.equal(h.title(), "Buy KSTL");
});

test("OA-48: the coin in focus is kept through the sealed quote a press asks for", async (t) => {
  const h = await mount(t, tradeOpening(KSTL_ACTION("sell"))!.screen);
  await typeInto(amount(h), "1000");
  await settle(400);
  const first = h.asked.length;
  assert.ok(first >= 1);
  // A press asks the server again, for the executable quote.
  await click(h.$("[data-trade]"));
  await settle(50);
  assert.ok(h.asked.length > first, "the press sealed a fresh quote");
  assert.equal(h.title(), "Sell KSTL");
  assert.equal(h.name(), "Sell KSTL");
});

test("OA-48: the Money menu's plain swap and a coin's own Trade stay `Swap`, flipped or not", async (t) => {
  const plain = await mount(t, tradeOpening(undefined)!.screen);
  assert.equal(plain.title(), "Swap");
  assert.equal(plain.name(), "Swap");
  await typeInto(amount(plain), "100");
  await settle(400);
  assert.match(plain.cta()!, /^Swap$/);
  await click(plain.$("[data-flip]"));
  assert.equal(plain.title(), "Swap");
});

test("OA-48: a coin's own Trade (the coin screen) has no coin in focus: `Swap`", async (t) => {
  const h = await mount(t, { kind: "coin", key: KSTL.key });
  await click([...document.querySelectorAll("button")].find((button) => button.textContent === "Trade") ?? null);
  await settle(0);
  assert.equal(h.title(), "Swap");
  assert.ok(h.$("[data-trade]") !== null, "on the trade screen");
});
