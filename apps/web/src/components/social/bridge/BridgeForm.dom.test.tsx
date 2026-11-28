import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { beforeEach, type TestContext } from "node:test";

import { addresses, type Quote } from "@mayanfinance/swap-sdk";

import { installTestDom, recordAnimations, setInputValue, testEvent, waitFor } from "../../../../test/fixtures/social/test-dom.ts";

import type { BridgeRow, BridgeSdk, EvmWallet, QuoteInput, SourceWallet } from "./bridge-sdk.ts";
import { rememberSolanaSubmission, settleSolanaSubmission } from "./solana-submission.ts";

const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { GC_MS } = await import("#web/lib/query/client.ts");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { BridgeForm } = await import("./BridgeForm.tsx");
const { SUI_COIN_TYPE } = await import("@blast/core/lib/sui/coin-types.ts");
const { mayanSdk } = await import("./mayan-sdk.ts");

// Live Mayan quotes captured 2026-11-26 with placeholder addresses (the guard tests use the same file).
const QUOTES = JSON.parse(readFileSync(new URL("../../../../test/fixtures/social/bridge/blink-quotes.json", import.meta.url), "utf8")) as Record<"baseUsdcToSui" | "solToSuiUsdc", Quote>;
const QUOTE = QUOTES.baseUsdcToSui;
// Live Mayan answers captured 2026-11-28 with the same placeholders: the Fast MCTP quote comes first.
const live = (pair: string) => (JSON.parse(readFileSync(new URL(`../../../../test/fixtures/social/bridge/all-routes-${pair}.json`, import.meta.url), "utf8")) as Quote[])[0]!;
const USDC_TO_USDC = live("base-usdc-usdc");
const ETH_TO_SUI = live("base-eth-sui");
const LIVE_NOW = Date.parse("2026-11-28T11:10:00Z");
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

type MountOptions = Readonly<{ signedIn?: boolean; at?: number; clock?: () => number }>;

async function mount(sdk: BridgeSdk, calls: Calls, wallet: SourceWallet | null = evm(), queries: Record<string, unknown> = {}, { signedIn = true, at = BEFORE_EXPIRY, clock = () => at }: MountOptions = {}) {
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  const client = createTestQueryClient({ queries });
  // Arrival deduplication is shared across the status read and view for the app's cache lifetime.
  client.setQueryDefaults(["bridge", "arrival"], { gcTime: GC_MS });
  const render = (next: SourceWallet | null, key = "first") => act(async () => root.render(withQueryClient(client,
    <BridgeForm
      key={key}
      blastAddress={signedIn ? BLAST : null}
      now={clock}
      onArrived={() => { calls.arrived += 1; }}
      onSignIn={() => undefined}
      sdk={sdk}
      signedIn={signedIn}
      wallets={{ evm: next?.kind === "evm" ? next : null, solana: next?.kind === "solana" ? next : null, connect: () => undefined }}
    />,
  )));
  await render(wallet);
  const button = () => container.querySelector<HTMLButtonElement>("button[data-ui-variant=primary]")!;
  const text = () => container.textContent ?? "";
  return {
    container,
    client,
    button,
    text,
    rerender: render,
    /** A fresh form on the same query cache, like closing and reopening Bridge. */
    remount: () => render(wallet, "again"),
    hide: () => act(async () => root.render(null)),
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
      await waitFor(() => calls.quotes.length > 0 && /you get at least|Code:/i.test(text()), "the quote settles");
    },
    /** Each press asks Mayan for a fresh quote first; wait until that run is over. */
    async press() {
      const asked = calls.quotes.length;
      await act(async () => button().click());
      await waitFor(() => calls.quotes.length > asked && !button().hasAttribute("aria-busy"), "the press settles");
    },
    async unmount() {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
    },
  };
}

const newCalls = (): Calls => ({ quotes: [], sends: 0, approves: 0, arrived: 0 });

// At these prices the recorded Blink quotes lose under 3%, so a press sends. A test of the loss check sets its own prices.
beforeEach((t) => { stubPrices(t as TestContext, { SOL: { usd: "70" }, SUI: { usd: "0.67" } }); });

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

test("a lost Solana send response stays blocked after reopening until expiry is verified", async () => {
  const calls = newCalls();
  const address = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  let expiryProven = false;
  let rpcFails = true;
  const sdk = fakeSdk(calls, [QUOTES.solToSuiUsdc], {
    async send(_quote, _request, _wallet, onSigned) {
      calls.sends += 1;
      rememberSolanaSubmission(address, "sol-hash", { slot: 200, blockhash: "blockhash", lastValidBlockHeight: 340 });
      onSigned("sol-hash");
      throw new Error("RPC disconnected after broadcasting");
    },
    checkSolanaSubmission: (source) => settleSolanaSubmission({
      async getSignatureStatuses() {
        if (rpcFails) throw new Error("RPC unavailable");
        return { context: { slot: 360 }, value: [null] };
      },
    }, source, async (expiry, signature) => {
      assert.deepEqual(expiry, { slot: 200, blockhash: "blockhash", lastValidBlockHeight: 340 });
      assert.equal(signature, "sol-hash");
      return expiryProven ? "failed" : "pending";
    }),
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
  };
  const receiveUsdc = () => act(async () => [...form.container.querySelectorAll<HTMLButtonElement>("[aria-label='Coin to receive'] button")].find((option) => option.textContent === "USDC")!.click());
  const check = async (copy: RegExp) => {
    assert.equal(form.button().textContent, "Check Solana transfer");
    await act(async () => form.button().click());
    await waitFor(() => copy.test(form.text()), "the source status result");
    assert.equal(calls.sends, 1, "a check never signs or sends again");
  };

  try {
    await pickSolana();
    await receiveUsdc();
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
    expiryProven = true;
    await check(/didn’t go through/);
    assert.equal(form.button().textContent, "Bridge");
    assert.equal(form.button().disabled, true, "a new send requires re-entering the amount");
    await receiveUsdc();
    await form.type("0.1");
    await waitFor(() => !form.button().disabled, "the new transfer can be sent");
    await form.press();
    assert.equal(calls.sends, 2, "a deliberate new send is allowed after verified expiry");
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
    await waitFor(() => /Code: bridge_no_route\./.test(form.text()), "the no-route message");
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
    await waitFor(() => /you get at least 29\.3968 SUI/i.test(form.text()), "the money sentence");
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

test("an in-flight arrival is reported once after closing and reopening Bridge", async () => {
  const calls = newCalls();
  const listed: BridgeRow = { hash: "0xhash", chain: "base", fromAmount: "20", fromSymbol: "USDC", toAmount: "29.81", toSymbol: "SUI", state: "pending", at: new Date(BEFORE_EXPIRY).toISOString() };
  // The app keeps finished queries for minutes; the test client's default drops them at once.
  let watching = false;
  const completion = Promise.withResolvers<{ state: "done"; toAmount: string }>();
  const done = { state: "done", toAmount: "29.81" } as const;
  const form = await mount(fakeSdk(calls, [QUOTE], {
    history: async () => (calls.sends > 0 ? [listed] : []),
    status: () => { watching = true; return completion.promise; },
  }), calls, evm(), { gcTime: 5 * 60_000 });
  try {
    await form.pickUsdc();
    await form.type("20");
    await form.press();
    await waitFor(() => watching, "the status read starts");
    await form.hide();
    await act(async () => completion.resolve(done));
    await waitFor(() => calls.arrived === 1, "the arrival");
    await form.remount();
    await waitFor(() => /Arrived · 29\.81\u00a0SUI/.test(form.text()), "the listed row");
    assert.equal(calls.arrived, 1, "the cached arrival is not told twice");
  } finally {
    completion.resolve(done);
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
  const sdk = fakeSdk(calls, [USDC_TO_USDC], {
    history: async () => [refreshed ? { ...transfer, state: "refunded" } : transfer],
    status: async () => { statusReads += 1; return { state: "pending", toAmount: null }; },
  });
  const form = await mount(sdk, calls, evm(), { gcTime: 5 * 60_000 });
  try {
    await waitFor(() => statusReads === 1 && form.text().includes("On the way"), "the cached pending transfer");
    refreshed = true;
    await form.remount();
    await waitFor(() => form.text().includes("Refunded in USDC to your Blast wallet on Sui"), "the terminal refund from history");
    assert.doesNotMatch(form.text(), /On the way/);
  } finally {
    await form.unmount();
  }
});

test("a failed history read offers a retry and a successful empty read clears it", async () => {
  const calls = newCalls();
  let reads = 0;
  const answer = Promise.withResolvers<BridgeRow[]>();
  const sdk = fakeSdk(calls, [], { history: async () => {
    if (++reads <= 2) throw new Error("Mayan unavailable");
    return answer.promise;
  } });
  const form = await mount(sdk, calls, evm(), { retryDelay: 0 });
  try {
    const retry = await waitFor(() => [...form.container.querySelectorAll("button")].find((button) => button.textContent === "Retry history"), "the history retry action");
    assert.match(form.text(), /Couldn’t load recent bridges/);
    assert.match(form.text(), /Code: bridge_history_failed\./);
    await act(async () => retry.click());
    await waitFor(() => reads === 3, "the manual history retry starts");
    await act(async () => answer.resolve([]));
    await waitFor(() => !form.text().includes("Recent bridges"), "the empty history removes the retry action");
  } finally {
    answer.resolve([]);
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
    assert.doesNotMatch(form.text(), /you get at least 29\.3968\s+USDC/i);
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

test("nothing is sent when Bridge closes, the wallet changes or the quote runs out during the allowance check", async () => {
  for (const change of ["closed", "wallet changed", "quote ran out"] as const) {
    const calls = newCalls();
    let hold = false;
    let checking = false;
    let time = BEFORE_EXPIRY;
    const allowance = Promise.withResolvers<boolean>();
    const sdk = fakeSdk(calls, [QUOTE]);
    const form = await mount({ ...sdk, allowanceEnough: (...args) => {
      if (!hold) return sdk.allowanceEnough(...args);
      checking = true;
      return allowance.promise;
    } }, calls, evm(), {}, { clock: () => time });
    try {
      await form.pickUsdc();
      await form.type("20");
      hold = true;
      await act(async () => form.button().click());
      await waitFor(() => checking, "the allowance check starts");
      if (change === "closed") await form.hide();
      if (change === "wallet changed") await form.rerender(evm(`0x${"22".repeat(20)}`));
      if (change === "quote ran out") time += 24 * 60 * 60 * 1000;
      await act(async () => allowance.resolve(true));
      if (change !== "closed") await waitFor(() => !form.button().hasAttribute("aria-busy"), "the press settles");
      assert.equal(calls.sends, 0, change);
      if (change === "quote ran out") assert.match(form.text(), /Code: bridge_quote_failed/);
    } finally {
      allowance.resolve(false);
      await form.unmount();
    }
  }
});

test("history can confirm a watched bridge before the status read does", async () => {
  const calls = newCalls();
  const listed: BridgeRow = { hash: "0xhash", chain: "base", fromAmount: "20", fromSymbol: "USDC", toAmount: "29.81", toSymbol: "SUI", state: "done", at: new Date(BEFORE_EXPIRY).toISOString() };
  let arrived = false;
  const status = Promise.withResolvers<{ state: "done"; toAmount: string }>();
  const form = await mount(fakeSdk(calls, [QUOTE], {
    history: async () => arrived ? [listed] : [],
    status: () => status.promise,
  }), calls);
  try {
    await form.pickUsdc();
    await form.type("20");
    await form.press();
    await waitFor(() => /On the way/.test(form.text()), "the pending bridge");
    arrived = true;
    await act(async () => { await form.client.invalidateQueries({ queryKey: ["bridge", "history", BLAST] }); });
    await waitFor(() => calls.arrived === 1, "history confirms arrival");
    await act(async () => status.resolve({ state: "done", toAmount: "29.81" }));
    await form.remount();
    assert.equal(calls.arrived, 1, "the status result and reopened history do not announce twice");
  } finally {
    status.resolve({ state: "done", toAmount: "29.81" });
    await form.unmount();
  }
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
  const lower = { ...QUOTE, minReceived: QUOTE.minReceived - 0.1, expectedAmountOut: QUOTE.expectedAmountOut - 0.1 };
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

test("an accepted new rate drops its note even when the wallet then says no", async () => {
  const calls = newCalls();
  const lower = { ...QUOTE, minReceived: QUOTE.minReceived - 0.1, expectedAmountOut: QUOTE.expectedAmountOut - 0.1 };
  const form = await mount(fakeSdk(calls, [QUOTE, lower], { send: async () => { calls.sends += 1; throw coded(4001); } }), calls);
  try {
    await form.pickUsdc();
    await form.type("20");
    await form.press();
    assert.match(form.text(), /The quote changed/);
    await form.press();
    assert.equal(calls.sends, 1);
    assert.doesNotMatch(form.text(), /The quote changed/);
    assert.equal(form.button().textContent, "Bridge");
  } finally {
    await form.unmount();
  }
});

test("a busy Bridge button stays focusable, so focus has somewhere to come back to", async () => {
  const calls = newCalls();
  const form = await mount(fakeSdk(calls, [QUOTE], { send: () => { calls.sends += 1; return new Promise<string>(() => undefined); } }), calls);
  try {
    await form.pickUsdc();
    await form.type("20");
    await act(async () => form.button().click());
    await waitFor(() => calls.sends === 1, "the wallet is asked");
    assert.equal(form.button().getAttribute("aria-busy"), "true");
    // Chrome drops focus to the page when a focused button turns natively disabled.
    assert.equal(form.button().hasAttribute("disabled"), false);
    const quotes = calls.quotes.length;
    await act(async () => form.button().click());
    assert.equal(calls.quotes.length, quotes, "a second press while busy does nothing");
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
    assert.equal(form.container.querySelector("[role=alert]")?.textContent ?? null, null);
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
    await waitFor(() => /you get at least/i.test(form.text()), "the new price");
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

// Mayan's live quotes: one sentence above the button, and the loss check.

/** Mayan's price API on this machine: the real SDK talks to it, so errors and request bodies are the SDK's own. */
async function fakeMayan(t: TestContext, reply: (asked: number) => Readonly<{ status: number; body: string }>) {
  const bodies: Array<Record<string, unknown>> = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      bodies.push(JSON.parse(body) as Record<string, unknown>);
      const answer = reply(bodies.length);
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const real = addresses.PRICE_URL;
  addresses.PRICE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(() => {
    addresses.PRICE_URL = real;
    server.close();
  });
  return bodies;
}

/** The fake, with a wallet that holds one ETH. */
function funded(calls: Calls, answers: ReadonlyArray<Quote | Error>, overrides: Partial<BridgeSdk> = {}): BridgeSdk {
  return fakeSdk(calls, answers, { balance: async () => 10n ** 18n, ...overrides });
}

/** The card's fake, with its quotes read by the real Mayan adapter. */
function realQuotes(calls: Calls): BridgeSdk {
  const real = mayanSdk();
  return funded(calls, [], { quote: (input) => { calls.quotes.push(input.swapper); return real.quote(input); } });
}

/** `deadline64` moved past the real clock, which the adapter reads. */
const answering = (quote: Quote) => JSON.stringify({ quotes: [{ ...quote, deadline64: String(Math.floor(Date.now() / 1000) + 3600) }], minimumSdkVersion: [1, 0, 0] });

type Priced = Readonly<{ usd: string; ageMs?: number }>;

/** The coins the loss check reads: SUI, and the wrapped coins on Sui that price ETH and SOL. */
const PRICED = new Map([
  [SUI_COIN_TYPE, "SUI"],
  ["0xd0e89b2af5e4910726fbcd8b8dd37bb79b29e5f83f7491bca830e94f7f226d29::eth::ETH", "ETH"],
  ["0xb7844e289a8410e50fb3ca48d69eb9cf29e27d223ef90353fe1bd8e27ff8f3f8::coin::COIN", "SOL"],
] as const);

/** Blast's price route: each coin asked answers with its price here, or has no entry. */
function stubPrices(t: TestContext, prices: Readonly<{ ETH?: Priced; SOL?: Priced; SUI?: Priced }>, status = 200) {
  const asked: string[][] = [];
  const real = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const coins = new URL(String(input), "http://127.0.0.1").searchParams.getAll("coin");
    // Anything else is the real SDK talking to the fake Mayan.
    if (coins.length === 0) return real(input, init);
    asked.push(coins);
    const listed = coins.flatMap((coin) => {
      const name = PRICED.get(coin);
      const price = name && prices[name];
      return price ? [{ presale_id: null, coin_type: coin, tier: "5m", from_ms: 0, points: [], price_usd: price.usd, price_24h_usd: null, change_24h_bps: null, day_open_usd: null, day_open_ms: null, price_as_of_ms: LIVE_NOW - (price.ageMs ?? 1_000) }] : [];
    });
    return Response.json({ window: "24h", clock_ms: LIVE_NOW, prices: listed, as_of: { checkpoint: 1, timestamp_ms: LIVE_NOW, lag_ms: 0 } }, { status });
  });
  return asked;
}

/** A card on the clock of the 2026-11-28 quotes. */
const liveCard = (sdk: BridgeSdk, calls: Calls) => mount(sdk, calls, evm(), {}, { at: LIVE_NOW });

/** The loss sheet only: the token picker is a dialog too. */
const sheet = () => [...dom.document.querySelectorAll<HTMLElement>("[role='dialog']")].find((dialog) => /Loss unknown|You might lose/.test(dialog.textContent ?? "")) ?? null;
const sheetButton = (name: "Back" | "Send") => [...sheet()!.querySelectorAll("button")].find((button) => button.textContent === name)!;
/** Call before the sheet opens: it leaves only when its closing motion ends. */
function sheetMotion() {
  const motion = recordAnimations();
  return () => waitFor(() => { motion.finishAll(); return sheet() === null; }, "the loss sheet closes");
}

test("up to 3% sends on one press, under one sentence that alone states the minimum", async (t) => {
  const prices = stubPrices(t, {});
  const calls = newCalls();
  const form = await liveCard(fakeSdk(calls, [USDC_TO_USDC]), calls);
  try {
    await form.pickUsdc("USDC");
    await form.type("20");
    const sentence = form.button().previousElementSibling!.textContent!;
    assert.equal(sentence.replaceAll(" ", " "), "Send 20 USDC from Base. You get at least 19.9803 USDC.");
    assert.ok(sentence.split(/\s+/).length <= 25);
    assert.match(form.text(), /Fee\$0\.02/);
    assert.doesNotMatch(form.text(), /Route|Mayan Blink|Fast MCTP/);
    await form.press();
    assert.equal(calls.sends, 1);
    assert.ok(!sheet(), "no loss sheet");
    assert.equal(prices.length, 0, "USDC on both sides is dollars already");
  } finally {
    await form.unmount();
  }
});

test("a worst case under 3% reads both prices once and sends on one press", async (t) => {
  const prices = stubPrices(t, { ETH: { usd: "2600" }, SUI: { usd: "1.05" } });
  const calls = newCalls();
  const form = await liveCard(funded(calls, [ETH_TO_SUI]), calls);
  try {
    await form.type("0.01");
    assert.equal(prices.length, 0, "typing reads no price");
    assert.equal(form.text().split("24.4211").length - 1, 1, "the minimum appears once");
    assert.match(form.text(), /or a USDC refund to your Blast wallet minus a refund fee\./, "an auction order says what comes back");
    await form.press();
    assert.equal(calls.sends, 1);
    assert.ok(!sheet(), "no loss sheet");
    const asked = [...PRICED].filter(([, name]) => name !== "SOL").map(([coin]) => coin);
    assert.deepEqual(prices.map((coins) => coins.toSorted()), [asked.toSorted()], "one request names both coins");
  } finally {
    await form.unmount();
  }
});

test("above 3% the sheet names the loss: Back sends nothing, Send sends", async (t) => {
  stubPrices(t, { ETH: { usd: "2600" }, SUI: { usd: "1" } });
  const sheetClosed = sheetMotion();
  const calls = newCalls();
  const form = await liveCard(funded(calls, [ETH_TO_SUI]), calls);
  try {
    await form.type("0.01");
    await form.press();
    assert.equal(calls.sends, 0);
    assert.match(sheet()!.textContent!, /You might lose 6\.1%/);
    assert.doesNotMatch(sheet()!.textContent!, /Send more/);
    await act(async () => sheetButton("Back").click());
    await sheetClosed();
    assert.equal(calls.sends, 0);
    await form.press();
    await act(async () => sheetButton("Send").click());
    await waitFor(() => calls.sends === 1, "the accepted send");
    await sheetClosed();
    assert.equal(calls.quotes.length, 4, "typing, two presses and the accepted send each ask Mayan");
  } finally {
    await form.unmount();
  }
});

test("a loss only the fixed fee puts above 3% says to send more", async (t) => {
  stubPrices(t, { ETH: { usd: "2600" }, SUI: { usd: "1.02" } });
  const calls = newCalls();
  const form = await liveCard(funded(calls, [{ ...ETH_TO_SUI, clientRelayerFeeSuccess: 1 }]), calls);
  try {
    await form.type("0.01");
    await form.press();
    assert.match(sheet()!.textContent!, /You might lose 4\.2%/);
    assert.match(sheet()!.textContent!, /Send more to lose less\./);
    assert.equal(calls.sends, 0);
  } finally {
    await form.unmount();
  }
});

for (const [name, prices, status] of [
  ["a missing", { ETH: { usd: "2600" } }, 200],
  ["a stale", { ETH: { usd: "2600" }, SUI: { usd: "1.05", ageMs: 121_000 } }, 200],
  ["a failed", {}, 503],
] as const) {
  test(`${name} price leaves the button and asks before sending`, async (t) => {
    stubPrices(t, prices, status);
    const calls = newCalls();
    const form = await liveCard(funded(calls, [ETH_TO_SUI]), calls);
    try {
      await form.type("0.01");
      assert.equal(form.button().textContent, "Bridge");
      await form.press();
      assert.match(sheet()!.textContent!, /Loss unknown/);
      assert.equal(calls.sends, 0);
      await act(async () => sheetButton("Send").click());
      await waitFor(() => calls.sends === 1, "the accepted send");
    } finally {
      await form.unmount();
    }
  });
}

test("a lower fresh minimum asks again, also after the loss was accepted", async (t) => {
  stubPrices(t, { ETH: { usd: "2600" }, SUI: { usd: "1" } });
  const sheetClosed = sheetMotion();
  const calls = newCalls();
  // Only the minimum falls; the estimate on screen stays the same.
  const lower = { ...ETH_TO_SUI, minReceived: ETH_TO_SUI.minReceived - 0.1 };
  const form = await liveCard(funded(calls, [ETH_TO_SUI, ETH_TO_SUI, lower]), calls);
  try {
    await form.type("0.01");
    await form.press();
    await act(async () => sheetButton("Send").click());
    await waitFor(() => form.button().textContent === "Bridge at new rate", "the new rate");
    await sheetClosed();
    assert.equal(calls.sends, 0);
    await form.press();
    assert.equal(calls.sends, 0, "the lower minimum loses more, so it asks too");
    await act(async () => sheetButton("Send").click());
    await waitFor(() => calls.sends === 1, "the accepted send");
  } finally {
    await form.unmount();
  }
});

test("a wallet rejection after accepting the loss returns to the button without an error", async (t) => {
  stubPrices(t, {});
  const sheetClosed = sheetMotion();
  const calls = newCalls();
  const form = await liveCard(funded(calls, [ETH_TO_SUI], { send: async () => { calls.sends += 1; throw coded(4001); } }), calls);
  try {
    await form.type("0.01");
    await form.press();
    await act(async () => sheetButton("Send").click());
    await waitFor(() => calls.sends === 1 && !form.button().hasAttribute("aria-busy"), "the rejected signature");
    await sheetClosed();
    assert.equal(form.button().textContent, "Bridge");
    assert.equal(form.container.querySelector("[role=alert]")?.textContent ?? null, null);
  } finally {
    await form.unmount();
  }
});

test("a Blink quote alone sends, with its own refund wording", async () => {
  const calls = newCalls();
  const form = await mount(fakeSdk(calls, [QUOTE]), calls);
  try {
    await form.pickUsdc();
    await form.type("20");
    assert.match(form.text(), /or a refund to your Base wallet/);
    await form.press();
    // The fixed test clock is older than the stubbed price, so the price counts as fresh.
    assert.equal(calls.sends, 1);
  } finally {
    await form.unmount();
  }
});

test("signed out with no wallet, any pair shows price, minimum, fee and time, and Mayan gets no address", async (t) => {
  const bodies = await fakeMayan(t, () => ({ status: 200, body: answering(ETH_TO_SUI) }));
  const calls = newCalls();
  const form = await mount(realQuotes(calls), calls, null, {}, { signedIn: false, at: LIVE_NOW });
  try {
    await form.type("0.01");
    const shown = form.text().replaceAll(" ", " ");
    assert.match(shown, /24\.7917/);
    assert.match(shown, /you get at least 24\.4211 SUI/);
    assert.match(shown, /Fee\$0\.04/);
    assert.match(shown, /ArrivesAbout 35 s/);
    assert.equal(bodies.length, 1);
    assert.equal("swapperAddress" in bodies[0]!, false);
    assert.equal("destinationAddress" in bodies[0]!, false);
  } finally {
    await form.unmount();
  }
});

for (const [name, body] of [["a JSON", JSON.stringify({ code: "RATE_LIMITED", message: "Too many requests" })], ["a plain-text", "Too Many Requests"]] as const) {
  test(`${name} 429 from Mayan is asked once, never retried`, async (t) => {
    const bodies = await fakeMayan(t, () => ({ status: 429, body }));
    const calls = newCalls();
    const form = await liveCard(realQuotes(calls), calls);
    try {
      await form.type("0.01");
      assert.match(form.text(), /Code: bridge_quote_failed\./);
      assert.equal(bodies.length, 1);
    } finally {
      await form.unmount();
    }
  });
}

for (const [name, failure] of [["Mayan's own 5xx", JSON.stringify({ code: "INTERNAL", message: "upstream failed" })], ["an unreadable 5xx", "bad gateway"]] as const) {
  test(`${name} is asked again`, async (t) => {
    const bodies = await fakeMayan(t, (asked) => asked === 1 ? { status: 502, body: failure } : { status: 200, body: answering(ETH_TO_SUI) });
    const calls = newCalls();
    const form = await liveCard(realQuotes(calls), calls);
    try {
      await form.type("0.01");
      assert.match(form.text(), /you get at least/);
      assert.equal(bodies.length, 2);
    } finally {
      await form.unmount();
    }
  });
}

test("a dropped connection, as the browser reports it, is asked again", async () => {
  const calls = newCalls();
  const form = await liveCard(funded(calls, [new TypeError("Network request failed"), ETH_TO_SUI]), calls);
  try {
    await form.type("0.01");
    assert.match(form.text(), /you get at least/);
    assert.equal(calls.quotes.length, 2);
  } finally {
    await form.unmount();
  }
});
