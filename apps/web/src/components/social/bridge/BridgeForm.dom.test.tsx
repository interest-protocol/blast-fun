import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import type { Quote } from "@mayanfinance/swap-sdk";

import { installTestDom, recordAnimations, setInputValue, testEvent, waitFor } from "../../../../test/fixtures/social/test-dom.ts";

import type { BridgeRow, BridgeSdk, EvmWallet, QuoteInput, SourceWallet } from "./bridge-sdk.ts";
import { rememberSolanaSubmission, settleSolanaSubmission } from "./solana-submission.ts";

const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { BridgeForm } = await import("./BridgeForm.tsx");

// Live Mayan quotes captured 2026-11-26 with placeholder addresses (the guard tests use the same file).
const QUOTES = JSON.parse(readFileSync(new URL("../../../../test/fixtures/social/bridge/blink-quotes.json", import.meta.url), "utf8")) as Record<"baseUsdcToSui" | "solToSuiUsdc", Quote>;
const QUOTE = QUOTES.baseUsdcToSui;
const FAST_MCTP = JSON.parse(readFileSync(new URL("../../../../test/fixtures/social/bridge/fast-mctp-quote.json", import.meta.url), "utf8")) as Quote;
const BLAST = `0x${"ab".repeat(32)}`;
const SOURCE = `0x${"11".repeat(20)}`;
const BEFORE_EXPIRY = Date.parse("2026-11-26T08:40:00Z");

type Calls = { quotes: Array<string | undefined>; sends: number; approves: number; arrived: number };

/** The fake Mayan: each quote call takes the next answer (the last one repeats). */
function fakeSdk(calls: Calls, answers: ReadonlyArray<Quote | Error>, overrides: Partial<BridgeSdk> = {}): BridgeSdk {
  return {
    tokens: async () => [],
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
    checkSolanaSubmission: async () => null,
    history: async () => [],
    status: async () => ({ state: "done", toAmount: "29.81" }),
    ...overrides,
  };
}

function evm(address = SOURCE): EvmWallet {
  return { kind: "evm", address, chainId: 8453, switchChain: async () => undefined, provider: async () => ({ request: async () => null }) };
}

const coded = (code: unknown) => Object.assign(new Error("refused"), { code });

async function mount(sdk: BridgeSdk, calls: Calls, wallet: SourceWallet | null = evm(), queries: Record<string, unknown> = {}) {
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  const client = createTestQueryClient({ queries });
  const render = (next: SourceWallet | null, key = "first") => act(async () => root.render(withQueryClient(client,
    <BridgeForm
      key={key}
      blastAddress={BLAST}
      now={() => BEFORE_EXPIRY}
      onArrived={() => { calls.arrived += 1; }}
      onSignIn={() => undefined}
      sdk={sdk}
      signedIn
      wallets={{ evm: next?.kind === "evm" ? next : null, solana: next?.kind === "solana" ? next : null, connect: () => undefined }}
    />,
  )));
  await render(wallet);
  const button = () => container.querySelector<HTMLButtonElement>("button[data-ui-variant=primary]")!;
  const text = () => container.textContent ?? "";
  return {
    container,
    button,
    text,
    rerender: render,
    /** A fresh form on the same query cache, like closing and reopening Bridge. */
    remount: () => render(wallet, "again"),
    /** USDC to send, then SUI to receive: USDC defaults the receiving coin to USDC. */
    async pickUsdc(receive: "SUI" | "USDC" = "SUI") {
      const option = (group: string, symbol: string) => [...container.querySelectorAll<HTMLButtonElement>(`[aria-label='${group}'] button`)].find((button) => button.textContent === symbol)!;
      await act(async () => container.querySelector<HTMLButtonElement>("[aria-label^='Coin to send:']")!.click());
      const source = await waitFor(() => [...dom.document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")].find((button) => button.textContent?.startsWith("USDC")), "the source token options");
      await act(async () => source.click());
      assert.equal(option("Coin to receive", "USDC").getAttribute("aria-pressed"), "true", "USDC sends to USDC by default");
      if (receive === "SUI") await act(async () => option("Coin to receive", "SUI").click());
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
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const newCalls = (): Calls => ({ quotes: [], sends: 0, approves: 0, arrived: 0 });

test("switching the source network keeps keyboard focus in the send flow", async () => {
  const calls = newCalls();
  const switched = Promise.withResolvers<void>();
  const wrongNetwork = { ...evm(), chainId: 1, switchChain: () => switched.promise };
  const form = await mount(fakeSdk(calls, [QUOTE]), calls, wrongNetwork);
  try {
    const button = form.button();
    assert.equal(button.textContent, "Switch to Base");
    button.focus();
    await act(async () => button.click());
    await waitFor(() => button.getAttribute("aria-busy") === "true", "the switch is pending");
    assert.equal(button.disabled, false, "the busy action remains focusable");
    await form.rerender(evm());
    assert.equal(form.button(), button, "a wallet event may arrive before the switch returns");
    await act(async () => switched.resolve());
    await waitFor(() => form.button() !== button, "the switch has finished");
    const chain = form.container.querySelector('[aria-label="From Base. Change chain"]');
    assert.equal(dom.document.activeElement, chain);
  } finally {
    switched.resolve();
    await form.unmount();
  }
});

test("a lost Solana send response stays blocked after reopening until Solana confirms a failure", async () => {
  const calls = newCalls();
  const address = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  let finalized = false;
  let rpcFails = true;
  const sdk = fakeSdk(calls, [QUOTES.solToSuiUsdc], {
    async send(_quote, _request, _wallet, onSigned) {
      calls.sends += 1;
      rememberSolanaSubmission(address, "sol-hash");
      onSigned("sol-hash");
      throw new Error("RPC disconnected after broadcasting");
    },
    checkSolanaSubmission: (source) => settleSolanaSubmission({
      async getSignatureStatuses() {
        if (rpcFails) throw new Error("RPC unavailable");
        return { context: { slot: 180 }, value: [finalized ? { confirmationStatus: "finalized", confirmations: null, slot: 170, err: { InstructionError: [0, "Custom"] } } : null] };
      },
    }, source),
    status: async () => ({ state: "pending", toAmount: null }),
  });
  Object.defineProperty(navigator, "locks", { configurable: true, value: {
    request: async (_name: string, _options: LockOptions, work: (lock: object) => Promise<unknown>) => work({}),
  } });
  const form = await mount(sdk, calls, { kind: "solana", address, signTransaction: async (bytes) => bytes });
  const pickSolana = async () => {
    await act(async () => form.container.querySelector<HTMLButtonElement>("[aria-label='From Base. Change chain']")!.click());
    const item = await waitFor(() => [...dom.document.querySelectorAll<HTMLElement>("[role='menuitemradio']")].find((option) => option.textContent === "Solana"), "Solana in the source chain menu");
    await act(async () => item.click());
    await act(async () => [...form.container.querySelectorAll<HTMLButtonElement>("[aria-label='Coin to receive'] button")].find((option) => option.textContent === "USDC")!.click());
  };
  const check = async (copy: RegExp) => {
    assert.equal(form.button().textContent, "Check Solana transfer");
    await act(async () => form.button().click());
    await waitFor(() => copy.test(form.text()), "the source status result");
    assert.equal(calls.sends, 1, "a check never signs or sends again");
  };

  try {
    await pickSolana();
    await form.type("0.1");
    await form.press();
    assert.equal(calls.sends, 1);
    assert.doesNotMatch(form.text(), /bridge didn’t start/);
    await form.remount();
    await pickSolana();
    await check(/Couldn’t check the Solana transfer/);
    rpcFails = false;
    await check(/hasn’t confirmed/);
    assert.ok(form.container.querySelector("a[href='https://explorer.solana.com/tx/sol-hash']"), "the saved signature remains available after reopening");
    finalized = true;
    await check(/didn’t go through/);
    assert.equal(form.button().textContent, "Bridge");
    assert.equal(form.button().disabled, true, "a new send requires re-entering the amount");
    await form.type("0.1");
    await form.press();
    assert.equal(calls.sends, 2, "a deliberate new send is allowed after finalized failure");
  } finally {
    await form.unmount();
    Reflect.deleteProperty(navigator, "locks");
    dom.window.localStorage.removeItem(`blast:solana-bridge-submission:${address}`);
    dom.window.sessionStorage.removeItem(`blast:bridge-submissions:${BLAST}`);
  }
});

test("a search picks a catalog token by its contract and quotes its own decimals", async () => {
  const motion = recordAnimations();
  const calls = newCalls();
  const token = { symbol: "CBBTC", name: "Coinbase Wrapped BTC", decimals: 8, mayan: "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", native: false, reserve: 0n, logo: null };
  const requests: QuoteInput[] = [];
  const form = await mount(fakeSdk(calls, [QUOTE], {
    tokens: async (chain) => {
      assert.equal(chain, "base");
      return [token];
    },
    quote: async (input) => {
      requests.push(input);
      calls.quotes.push(input.swapper);
      throw coded("ROUTE_NOT_FOUND");
    },
  }), calls);
  try {
    const trigger = form.container.querySelector<HTMLButtonElement>("[aria-label^='Coin to send:']")!;
    await act(async () => trigger.click());
    const search = await waitFor(() => dom.document.querySelector<HTMLInputElement>("[aria-label='Search tokens']"), "the token search");
    assert.equal(search.closest("[role=dialog]")?.getAttribute("aria-modal"), "true");
    await waitFor(() => dom.document.activeElement === search, "the token search takes focus");
    await act(async () => {
      setInputValue(search, token.mayan);
      search.dispatchEvent(testEvent("input"));
    });
    const match = () => [...dom.document.querySelectorAll<HTMLButtonElement>("[role='dialog'] button")].find((button) => button.textContent?.includes("Coinbase Wrapped BTC"));
    await waitFor(() => !!match(), "the matching catalog token");
    await act(async () => match()!.click());
    await act(async () => motion.finishAll());
    assert.equal(trigger.getAttribute("aria-label"), "Coin to send: CBBTC");
    assert.equal(dom.document.activeElement, trigger);
    const amount = form.container.querySelector<HTMLInputElement>("[inputmode='decimal']")!;
    await act(async () => {
      setInputValue(amount, "0.0002");
      amount.dispatchEvent(testEvent("input"));
    });
    await waitFor(() => requests.length > 0, "the catalog token is quoted");
    assert.equal(requests[0]!.token.mayan, token.mayan);
    assert.equal(requests[0]!.amountIn64, "20000");
    await waitFor(() => /No route/i.test(form.text()), "the no-route message");
    assert.equal(form.button().disabled, true);
    assert.equal(calls.sends, 0);
    assert.equal(calls.approves, 0);
  } finally {
    await form.unmount();
  }
});


test("a checked quote bridges on one press, lists the row and reports the arrival once", async () => {
  const calls = newCalls();
  const form = await mount(fakeSdk(calls, [QUOTE]), calls);
  try {
    await form.pickUsdc();
    const half = await waitFor(() => [...form.container.querySelectorAll<HTMLButtonElement>("[aria-label='Amount presets'] button")].find((button) => button.textContent === "50%"), "amount presets after the source balance loads");
    await act(async () => half.click());
    assert.equal(form.container.querySelector<HTMLInputElement>("[inputmode=decimal]")?.value, "500");
    await form.type("20");
    await waitFor(() => /You get at least 29\.3968 SUI/.test(form.text()), "the money sentence");
    assert.equal(form.button().textContent, "Bridge");
    assert.equal(calls.quotes.at(-1), SOURCE, "the shown quote is bound to the source wallet");
    await form.press();
    await waitFor(() => calls.arrived === 1, "the arrival");
    assert.equal(calls.sends, 1);
    await waitFor(() => /Arrived · 29\.81\u00a0SUI/.test(form.text()), "the arrived row");
    await form.rerender(evm());
    assert.equal(calls.arrived, 1, "an arrival is told once, even when the rows render again");
  } finally {
    await form.unmount();
  }
});

test("reopening Bridge does not report an arrival again from the cache", async () => {
  const calls = newCalls();
  const listed: BridgeRow = { hash: "0xhash", chain: "base", fromAmount: "20", fromSymbol: "USDC", toAmount: "29.81", toSymbol: "SUI", state: "pending", at: new Date(BEFORE_EXPIRY).toISOString() };
  // The app keeps finished queries for minutes; the test client's default drops them at once.
  const form = await mount(fakeSdk(calls, [QUOTE], { history: async () => (calls.sends > 0 ? [listed] : []) }), calls, evm(), { gcTime: 5 * 60_000 });
  try {
    await form.pickUsdc();
    await form.type("20");
    await form.press();
    await waitFor(() => calls.arrived === 1, "the arrival");
    await form.remount();
    await waitFor(() => /Arrived · 29\.81\u00a0SUI/.test(form.text()), "the listed row");
    assert.equal(calls.arrived, 1, "the cached arrival is not told twice");
  } finally {
    await form.unmount();
  }
});

test("a terminal Fast MCTP history row wins over a cached pending status", async () => {
  const calls = newCalls();
  const transfer: BridgeRow = {
    hash: "0xrefund", chain: "base", fromAmount: "20", fromSymbol: "USDC", toAmount: null,
    toSymbol: "USDC", state: "pending", refundOnSui: true, at: new Date(BEFORE_EXPIRY).toISOString(),
  };
  let refreshed = false;
  let statusReads = 0;
  const sdk = fakeSdk(calls, [FAST_MCTP], {
    history: async () => [refreshed ? { ...transfer, state: "refunded" } : transfer],
    status: async () => { statusReads += 1; return { state: "pending", toAmount: null }; },
  });
  const form = await mount(sdk, calls, evm(), { gcTime: 5 * 60_000 });
  try {
    await waitFor(() => statusReads === 1 && form.text().includes("On the way"), "the cached pending transfer");
    refreshed = true;
    await form.remount();
    await waitFor(() => form.text().includes("Refunded to your Blast wallet on Sui"), "the terminal refund from history");
    assert.doesNotMatch(form.text(), /On the way/);
  } finally {
    await form.unmount();
  }
});

test("a failed history read offers a retry and a successful empty read clears it", async () => {
  const calls = newCalls();
  let failed = true;
  const sdk = fakeSdk(calls, [], { history: async () => {
    if (failed) throw new Error("Mayan unavailable");
    return [];
  } });
  const form = await mount(sdk, calls);
  try {
    const retry = await waitFor(() => [...form.container.querySelectorAll("button")].find((button) => button.textContent === "Retry history"), "the history retry action");
    assert.match(form.text(), /Couldn’t load recent bridges/);
    assert.match(form.text(), /Code: bridge_history_failed\./);
    failed = false;
    await act(async () => retry.click());
    await waitFor(() => !form.text().includes("Recent bridges"), "the recovered empty history");
  } finally {
    await form.unmount();
  }
});

test("reopening before Mayan indexes a submission retries history and resumes watching", async () => {
  const { environmentManager } = await import("@tanstack/react-query");
  const wasServer = environmentManager.isServer();
  environmentManager.setIsServer(() => false);
  const storageKey = `blast:bridge-submissions:${BLAST}`;
  window.sessionStorage.removeItem(storageKey);
  const calls = newCalls();
  const listed: BridgeRow = { hash: "0xhash", chain: "base", fromAmount: "20", fromSymbol: "USDC", toAmount: "29.81", toSymbol: "SUI", state: "pending", at: new Date(BEFORE_EXPIRY).toISOString() };
  let reopened = false;
  let readsAfterReopen = 0;
  const form = await mount(fakeSdk(calls, [QUOTE], {
    history: async () => (reopened && ++readsAfterReopen > 1 ? [listed] : []),
    status: async () => reopened ? { state: "done", toAmount: "29.81" } : { state: "pending", toAmount: null },
  }), calls);
  try {
    await form.pickUsdc();
    await form.type("20");
    await form.press();
    assert.match(window.sessionStorage.getItem(storageKey) ?? "", /^\d+:0xhash$/);
    reopened = true;
    await form.remount();
    await waitFor(() => /Arrived · 29\.81\u00a0SUI/.test(form.text()), "history catches up and status resumes", 12_000);
    assert.equal(readsAfterReopen, 2);
    assert.equal(calls.arrived, 1);
  } finally {
    await form.unmount();
    window.sessionStorage.removeItem(storageKey);
    environmentManager.setIsServer(() => wasServer);
  }
});

test("changing the receive coin never relabels an old quote", async () => {
  const calls = newCalls();
  let finish: (quote: Quote) => void = () => undefined;
  const form = await mount(fakeSdk(calls, [QUOTE], {
    quote: async (input) => {
      calls.quotes.push(input.swapper);
      if (input.to.symbol === "USDC") return new Promise<Quote>((resolve) => { finish = resolve; });
      return QUOTE;
    },
  }), calls);
  try {
    await form.pickUsdc();
    await form.type("20");
    const receiveUsdc = [...form.container.querySelectorAll<HTMLButtonElement>("[aria-label='Coin to receive'] button")].find((button) => button.textContent === "USDC")!;
    await act(async () => receiveUsdc.click());
    assert.doesNotMatch(form.text(), /You get at least 29\.3968\s+USDC/);
    assert.equal(form.button().disabled, true);
  } finally {
    await form.unmount();
    finish(QUOTE);
  }
});

test("a failed balance can be retried and blocks signing until it loads", async () => {
  const calls = newCalls();
  let failed = true;
  const form = await mount(fakeSdk(calls, [QUOTE], {
    balance: async () => {
      if (failed) throw new Error("balance unavailable");
      return 1_000_000_000n;
    },
  }), calls, evm(), { retryDelay: 0 });
  try {
    await form.pickUsdc();
    await form.type("20");
    await waitFor(() => /bridge_balance_failed/.test(form.text()), "the balance error");
    assert.match(form.text(), /Balance —/);
    assert.equal(form.button().disabled, true);
    assert.match(dom.document.getElementById(form.button().getAttribute("aria-describedby")!)?.textContent ?? "", /bridge_balance_failed/);
    assert.equal(calls.sends + calls.approves, 0);
    const retry = [...form.container.querySelectorAll("button")].find((button) => button.textContent === "Retry balance")!;
    failed = false;
    await act(async () => retry.click());
    await waitFor(() => !form.button().disabled, "the balance read enables Bridge");
    assert.doesNotMatch(form.text(), /bridge_balance_failed/);
  } finally {
    await form.unmount();
  }
});

test("closing Bridge while the fresh quote is on its way opens no wallet", async () => {
  const calls = newCalls();
  let hold = false;
  let release: (quote: Quote) => void = () => undefined;
  const sdk = fakeSdk(calls, [QUOTE]);
  const form = await mount({ ...sdk, quote: (input) => hold ? new Promise<Quote>((resolve) => { calls.quotes.push(input.swapper); release = resolve; }) : sdk.quote(input) }, calls);
  await form.pickUsdc();
  await form.type("20");
  hold = true;
  const asked = calls.quotes.length;
  await act(async () => form.button().click());
  await waitFor(() => calls.quotes.length > asked, "the fresh quote is asked");
  await form.unmount();
  await act(async () => release(QUOTE));
  assert.equal(calls.sends, 0);
});

test("closing Bridge while the allowance is checked opens no wallet", async () => {
  const calls = newCalls();
  let hold = false;
  let release: (enough: boolean) => void = () => undefined;
  const sdk = fakeSdk(calls, [QUOTE]);
  const form = await mount({ ...sdk, allowanceEnough: (...args) => hold ? new Promise<boolean>((resolve) => { release = resolve; }) : sdk.allowanceEnough(...args) }, calls);
  await form.pickUsdc();
  await form.type("20");
  hold = true;
  await act(async () => form.button().click());
  await waitFor(() => form.button().hasAttribute("aria-busy"), "the press is running");
  await form.unmount();
  await act(async () => release(true));
  assert.equal(calls.sends, 0);
});

test("closing Bridge while the SDK prepares the send aborts it before the wallet", async () => {
  const calls = newCalls();
  let seen: AbortSignal | null = null;
  const form = await mount(fakeSdk(calls, [QUOTE], { send: (_quote, _request, _wallet, _onSigned, signal) => { seen = signal; return new Promise<string>(() => undefined); } }), calls);
  await form.pickUsdc();
  await form.type("20");
  await act(async () => form.button().click());
  await waitFor(() => seen !== null, "the SDK has the send");
  assert.equal(seen!.aborted, false);
  await form.unmount();
  assert.equal(seen!.aborted, true);
});

test("an arrival reads the source balance again", async () => {
  const calls = newCalls();
  let balances = 0;
  let arrive: () => void = () => undefined;
  const arrived = new Promise<void>((resolve) => { arrive = resolve; });
  const form = await mount(fakeSdk(calls, [QUOTE], {
    balance: async () => { balances += 1; return 1_000_000_000n; },
    status: async () => { await arrived; return { state: "done", toAmount: "29.81" }; },
  }), calls);
  try {
    await form.pickUsdc();
    await form.type("20");
    await form.press();
    await waitFor(() => balances >= 2, "the read right after sending");
    const afterSend = balances;
    await act(async () => arrive());
    await waitFor(() => calls.arrived === 1, "the arrival");
    await waitFor(() => balances > afterSend, "a balance read after the arrival");
  } finally {
    await form.unmount();
  }
});

test("a send error after the price shows the send copy, not a price error", async () => {
  const calls = newCalls();
  const form = await mount(fakeSdk(calls, [QUOTE], { send: async () => { throw coded("TIMEOUT"); } }), calls);
  try {
    await form.pickUsdc();
    await form.type("20");
    await form.press();
    await waitFor(() => /Code: bridge_send_failed\./.test(form.text()), "the send line");
    assert.doesNotMatch(form.text(), /bridge_quote_failed/);
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
    assert.match(form.text(), /The quote changed/);
    await form.press();
    assert.equal(calls.sends, 1);
  } finally {
    await form.unmount();
  }
});

test("the wallet waits after switching to Fast MCTP and after its estimated output falls", async () => {
  const calls = newCalls();
  const shown = { ...QUOTE, minReceived: 19.9 };
  const firstFastQuote = { ...FAST_MCTP, minReceived: 19.97 };
  const worseEstimate = { ...firstFastQuote, expectedAmountOut: 19.979, expectedAmountOutBaseUnits: "19979000" };
  const form = await mount(fakeSdk(calls, [shown, firstFastQuote, worseEstimate]), calls);
  try {
    await form.pickUsdc("USDC");
    await form.type("20");
    await form.press();
    assert.equal(calls.sends, 0);
    assert.match(form.text(), /Mayan Fast MCTP/);
    assert.match(form.text(), /The amount shown is an estimate/);
    assert.equal(form.button().textContent, "Bridge at new rate");
    await form.press();
    assert.equal(calls.sends, 0);
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
    assert.match(form.text(), /\u2014SUIUSDC/, "a failed price shows a dash, not a zero");
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
