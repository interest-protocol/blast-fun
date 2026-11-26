import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Quote } from "@mayanfinance/swap-sdk";

import { installTestDom, setInputValue, testEvent, waitFor } from "../../../../test/fixtures/social/test-dom.ts";

import type { BridgeSdk, EvmWallet } from "./bridge-sdk.ts";

const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { BridgeForm } = await import("./BridgeForm.tsx");

// Live Mayan quotes captured 2026-11-26 with placeholder addresses (the guard tests use the same file).
const QUOTES = JSON.parse(readFileSync(new URL("../../../../test/fixtures/social/bridge/blink-quotes.json", import.meta.url), "utf8")) as Record<"baseUsdcToSui", Quote>;
const QUOTE = QUOTES.baseUsdcToSui;
const BLAST = `0x${"ab".repeat(32)}`;
const SOURCE = `0x${"11".repeat(20)}`;
const BEFORE_EXPIRY = Date.parse("2026-11-26T08:40:00Z");
const CONFIG = { rpcs: { base: "https://base.example" } };

type Calls = { quotes: Array<string | undefined>; sends: number; approves: number; arrived: number };

/** The fake Mayan: each quote call takes the next answer (the last one repeats). */
function fakeSdk(calls: Calls, answers: ReadonlyArray<Quote | Error>, overrides: Partial<BridgeSdk> = {}): BridgeSdk {
  return {
    async quote(input) {
      calls.quotes.push(input.swapper);
      const answer = answers[Math.min(calls.quotes.length - 1, answers.length - 1)]!;
      if (answer instanceof Error) throw answer;
      return answer;
    },
    balance: async () => 1_000_000_000n,
    allowanceEnough: async () => true,
    approve: async () => { calls.approves += 1; },
    async send(_quote, _request, _wallet, onSigned) {
      calls.sends += 1;
      onSigned("0xhash");
      return "0xhash";
    },
    history: async () => [],
    status: async () => ({ state: "done", toAmount: "29.81" }),
    ...overrides,
  };
}

function evm(address = SOURCE): EvmWallet {
  return { kind: "evm", address, chainId: 8453, switchChain: async () => undefined, provider: async () => ({ request: async () => null }) };
}

const coded = (code: unknown) => Object.assign(new Error("refused"), { code });

async function mount(sdk: BridgeSdk, calls: Calls, wallet: EvmWallet | null = evm()) {
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  const client = createTestQueryClient();
  const render = (next: EvmWallet | null) => act(async () => root.render(withQueryClient(client,
    <BridgeForm
      blastAddress={BLAST}
      config={CONFIG}
      now={() => BEFORE_EXPIRY}
      onArrived={() => { calls.arrived += 1; }}
      onSignIn={() => undefined}
      sdk={sdk}
      signedIn
      wallets={{ evm: next, solana: null, connect: () => undefined }}
    />,
  )));
  await render(wallet);
  const button = () => container.querySelector<HTMLButtonElement>("button[data-ui-size=lg]")!;
  const text = () => container.textContent ?? "";
  return {
    container,
    button,
    text,
    rerender: render,
    /** USDC to send, then SUI to receive: USDC defaults the receiving coin to USDC. */
    async pickUsdc() {
      const option = (group: string, symbol: string) => [...container.querySelectorAll<HTMLButtonElement>(`[aria-label='${group}'] button`)].find((button) => button.textContent === symbol)!;
      await act(async () => option("Coin to send", "USDC").click());
      assert.equal(option("Coin to receive", "USDC").getAttribute("aria-pressed"), "true", "USDC sends to USDC by default");
      await act(async () => option("Coin to receive", "SUI").click());
    },
    async type(amount: string) {
      const input = container.querySelector<HTMLInputElement>("input")!;
      await act(async () => { setInputValue(input, amount); input.dispatchEvent(testEvent("input")); });
      await waitFor(() => calls.quotes.length > 0 && /You get at least|Code:/.test(text()), "the quote settles");
    },
    /** Each press asks Mayan for a fresh quote first; wait until that run is over. */
    async press() {
      const asked = calls.quotes.length;
      await act(async () => button().click());
      await waitFor(() => calls.quotes.length > asked && !button().hasAttribute("aria-busy"), "the press settles");
    },
    unmount: () => act(async () => root.unmount()),
  };
}

const newCalls = (): Calls => ({ quotes: [], sends: 0, approves: 0, arrived: 0 });

test("a checked quote bridges on one press, lists the row and reports the arrival once", async () => {
  const calls = newCalls();
  const form = await mount(fakeSdk(calls, [QUOTE]), calls);
  try {
    await form.pickUsdc();
    await form.type("20");
    await waitFor(() => /You get at least 29\.3968 SUI/.test(form.text()), "the money sentence");
    assert.equal(form.button().textContent, "Bridge");
    assert.equal(calls.quotes.at(-1), SOURCE, "the shown quote is bound to the source wallet");
    await form.press();
    await waitFor(() => calls.arrived === 1, "the arrival");
    assert.equal(calls.sends, 1);
    assert.match(form.text(), /Arrived · 29\.81 SUI/);
    await form.rerender(evm());
    assert.equal(calls.arrived, 1, "an arrival is told once, even when the rows render again");
  } finally {
    await form.unmount();
  }
});

test("the guard refuses a quote for another recipient before any wallet call", async () => {
  const calls = newCalls();
  const elsewhere = structuredClone(QUOTE) as Quote & { blinkQuote: { crossChain: { orderParams: Record<string, unknown> } } };
  const order = elsewhere.blinkQuote.crossChain.orderParams;
  for (const key of Object.keys(order)) if (typeof order[key] === "string" && (order[key] as string).toLowerCase().includes("abab")) order[key] = `0x${"cd".repeat(32)}`;
  const form = await mount(fakeSdk(calls, [QUOTE, elsewhere]), calls);
  try {
    await form.pickUsdc();
    await form.type("20");
    await form.press();
    assert.equal(calls.sends, 0);
    assert.equal(calls.approves, 0);
    assert.match(form.text(), /Code: bridge_quote_failed\./);
  } finally {
    await form.unmount();
  }
});

test("a lower fresh quote waits for a new press at the new rate", async () => {
  const calls = newCalls();
  const lower = { ...QUOTE, minReceived: QUOTE.minReceived - 1, expectedAmountOut: QUOTE.expectedAmountOut - 1 };
  const form = await mount(fakeSdk(calls, [QUOTE, lower]), calls);
  try {
    await form.pickUsdc();
    await form.type("20");
    await form.press();
    assert.equal(calls.sends, 0);
    assert.equal(form.button().textContent, "Bridge at new rate");
    assert.match(form.text(), /The rate changed/);
    await form.press();
    assert.equal(calls.sends, 1);
  } finally {
    await form.unmount();
  }
});

test("the allowance is checked again on the fresh quote", async () => {
  const calls = newCalls();
  let checks = 0;
  const form = await mount(fakeSdk(calls, [QUOTE], { allowanceEnough: async () => ++checks === 1 }), calls);
  try {
    await form.pickUsdc();
    await form.type("20");
    assert.equal(form.button().textContent, "Bridge");
    await form.press();
    assert.equal(calls.sends, 0);
    await waitFor(() => form.button().textContent === "Approve USDC", "the approval step");
  } finally {
    await form.unmount();
  }
});

test("a wallet rejection returns to the button without an error", async () => {
  const calls = newCalls();
  const form = await mount(fakeSdk(calls, [QUOTE], { send: async () => { throw coded(4001); } }), calls);
  try {
    await form.pickUsdc();
    await form.type("20");
    await form.press();
    assert.equal(form.button().textContent, "Bridge");
    assert.equal(form.container.querySelector("[role=alert]"), null);
  } finally {
    await form.unmount();
  }
});

test("Mayan's 9999 pauses the card and points to the Sui address", async () => {
  const calls = newCalls();
  const form = await mount(fakeSdk(calls, [coded(9999)]), calls);
  try {
    await form.type("0.01");
    await waitFor(() => /Code: bridge_paused\./.test(form.text()), "the paused line");
    assert.equal(form.button().disabled, true);
    assert.equal(calls.quotes.length, 1, "a paused SDK is not asked again");
  } finally {
    await form.unmount();
  }
});

test("a failed price offers Try again, which asks Mayan once more", async () => {
  const calls = newCalls();
  const form = await mount(fakeSdk(calls, [coded("SERVER_DOWN"), QUOTE]), calls);
  try {
    await form.pickUsdc();
    await form.type("20");
    await waitFor(() => /Code: bridge_quote_failed\./.test(form.text()), "the failed line");
    assert.equal(form.button().textContent, "Try again");
    assert.equal(form.button().disabled, false);
    await form.press();
    await waitFor(() => /You get at least/.test(form.text()), "the new price");
    assert.equal(form.button().textContent, "Bridge");
  } finally {
    await form.unmount();
  }
});

test("a different source wallet asks for a quote bound to it", async () => {
  const calls = newCalls();
  const form = await mount(fakeSdk(calls, [QUOTE]), calls);
  try {
    await form.pickUsdc();
    await form.type("20");
    const other = `0x${"22".repeat(20)}`;
    await form.rerender(evm(other));
    await waitFor(() => calls.quotes.at(-1) === other, "a quote for the new wallet");
  } finally {
    await form.unmount();
  }
});
