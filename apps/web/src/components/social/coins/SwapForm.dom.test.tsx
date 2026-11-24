import { sellPresetAmount, typedAmount, type TradeAmount } from "#web/components/social/trade/trade-ticket.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom, setInputValue, testEvent } from "../../../../test/fixtures/social/test-dom.ts";
import { FIXTURE_COINS, DEFAULT_SWAP_MODE } from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";
import { fixtureQuote } from "../../../../test/fixtures/social/coins/swap-fixture.ts";

import type { WalletCoinView } from "./coin-model";
import type { TradeAsk } from "./SwapForm";

const dom = installTestDom();
Object.defineProperty(dom.document, "oninput", { value: null, writable: true, configurable: true });
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, settleQueries, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { SwapForm, SWAP_SUCCESS_MS } = await import("./SwapForm");
const pressTrade = async (button: HTMLButtonElement, client: ReturnType<typeof createTestQueryClient>) => {
  await act(async () => { button.focus(); button.click(); });
  await act(async () => settleQueries(client));
};
const { CoinSheet } = await import("./CoinSheet");
const { SocialViewerProvider } = await import("../SignInGate");
const { TokenPickerBody } = await import("./TokenPicker");

for (const ending of ["reset", "dismiss", "unmount", "pending"] as const) {
  test(`a confirmed swap settles on the button: ${ending}`, async () => {
    const inCoin = { ...FIXTURE_COINS[1]!, atoms: 100000000000n };
    const outCoin = FIXTURE_COINS[0]!;
    const quote = fixtureQuote({ in_coin: inCoin.coinType, out_coin: outCoin.coinType, side: "sell", amount_in: "100000000000" }, FIXTURE_COINS, DEFAULT_SWAP_MODE, Date.now());
    const container = dom.document.createElement("div");
    dom.document.body.appendChild(container);
    const root = createRoot(container);
    const client = createTestQueryClient();
    let trades = 0;
    let resets = 0;
    let quotes = 0;
    const asks: TradeAsk[] = [];
    let unmounted = false;
    let balance = inCoin.atoms;
    function Screen({ active }: { active: boolean }) {
      const [field, setField] = useState<TradeAmount>(() => ending === "reset" ? sellPresetAmount("max", inCoin) : typedAmount("100", inCoin.decimals));
      const [detail, setDetail] = useState(true);
      return <SwapForm active={active}
        inCoin={{ ...inCoin, atoms: balance }} outCoin={outCoin} field={field}
        onField={(next) => { resets += 1; setField(next); }} detail={detail} onDetail={setDetail}
        onFlip={() => undefined} onPick={() => undefined} hidden={false} walletFee="sponsored"
        trading={{ signedIn: true, onSignIn: () => undefined, listCoins: async () => [],
          requestQuote: async () => ({ status: "ok", body: { ...quote, quote_id: `quote-${++quotes}` }, httpStatus: 200 }),
          trade: async (ask) => {
            trades += 1;
            asks.push(ask);
            if (ending === "reset" && trades === 1) return { status: "fee_required", feeMist: "1000" };
            return { status: ending === "pending" ? "pending" : "traded" };
          },
        }} />;
    }
    const render = (active = true) => act(async () => root.render(withQueryClient(client, <Screen active={active} />)));
    try {
      await render();
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)); });
      const button = container.querySelector<HTMLButtonElement>("[data-trade]")!;
      if (ending === "reset") {
        assert.equal(container.querySelector<HTMLInputElement>("input")!.value, "100", "Max starts with the whole 100-token balance");
        assert.equal(Array.from(container.querySelectorAll("[aria-pressed=true]")).some(preset => preset.textContent === "Max"), true, "Max is selected before sending");
      }
      await pressTrade(button, client);
      if (ending === "reset") {
        // The fee goes in the money sentence; the button keeps its verb (KA-6).
        assert.equal(button.textContent, "Swap");
        assert.match(container.textContent!, /Network fee/);
        await pressTrade(button, client);
        assert.equal(asks[1]!.acceptFee, true);
      }
      assert.equal(resets, 0);
      if (ending === "pending") {
        assert.doesNotMatch(button.textContent ?? "", /Successful/);
        assert.equal(container.querySelector('[role="status"]')!.textContent, "");
      } else {
        assert.equal(button.textContent, "Successful");
        assert.equal(button.getAttribute("aria-disabled"), "true");
        assert.equal(button.getAttribute("aria-busy"), null);
        assert.equal(container.querySelector<HTMLInputElement>("input")!.value, "100");
        assert.equal(container.querySelector<HTMLInputElement>("input")!.disabled, true);
        assert.equal(container.querySelector<HTMLButtonElement>("[data-flip]")!.disabled, true);
        assert.match(container.querySelector('[role="status"]')!.textContent!, /Swap successful/);
        await act(async () => button.click());
        assert.equal(trades, ending === "reset" ? 2 : 1, "success cannot submit a second swap");
        if (ending === "reset") {
          const output = container.querySelector("[data-out]")!.textContent;
          balance = 0n;
          await render();
          assert.equal(container.querySelector("[data-out]")!.textContent, output, "a Max swap keeps its confirmed quote after balances refresh");
        }
      }
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, SWAP_SUCCESS_MS - 500)); });
      assert.equal(resets, 0, "success stays visible for the full pause");
      if (ending === "dismiss") await render(false);
      else if (ending === "unmount") {
        await act(async () => root.unmount());
        unmounted = true;
      } else await render();
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 700)); });
      assert.equal(resets, ending === "reset" ? 1 : 0, "rerenders preserve the timer; dismissal cancels it");
      if (ending === "reset") {
        const input = container.querySelector<HTMLInputElement>("input")!;
        assert.equal(input.value, "");
        assert.equal(input.placeholder, "0");
        assert.equal(input.disabled, false);
        assert.equal(dom.document.activeElement, input, "reset returns keyboard focus to the amount field");
        assert.equal(input.getAttribute("data-mode"), "typed");
        assert.equal(container.querySelector("[data-out]")!.textContent, "—");
        assert.equal(container.querySelector('[aria-pressed="true"]'), null);
        assert.equal(container.querySelector('[aria-expanded="true"]'), null);
        assert.doesNotMatch(container.textContent!, /Successful|Whole balance/);
        assert.match(container.textContent!, /Balance 0\u00a0SUI/);
        assert.match(container.textContent!, /Balance 860\u00a0USDC/);
        balance = inCoin.atoms;
        await render();
        setInputValue(input, "100");
        await act(async () => input.dispatchEvent(testEvent("input")));
        await act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)); });
        await pressTrade(button, client);
        assert.equal(trades, 3, "the open form can submit another swap");
        assert.notEqual(asks[2]!.quote.quote_id, asks[1]!.quote.quote_id, "a new swap fetches a fresh quote even for the same amount");
        assert.notEqual(asks[2]!.idempotencyKey, asks[1]!.idempotencyKey);
        assert.equal(asks[2]!.acceptFee, false, "fee approval does not carry into the next swap");
      }
    } finally {
      if (!unmounted) await act(async () => root.unmount());
      client.clear();
      container.remove();
    }
  });
}

test("the picker finds SUI while typing a short type and after pasting a padded type", async () => {
  const sui = FIXTURE_COINS.find((coin) => coin.symbol === "SUI")!;
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  const picked: string[] = [];
  try {
    await act(async () => root.render(<TokenPickerBody current={sui} wallet={FIXTURE_COINS} pins={[]} hidden={false} listCoins={async () => []} onPick={(coin) => picked.push(coin.symbol)} />));
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search coins"]')!;
    for (const query of ["0x", "0x000", "0x2", "0x2::sui::SUI", sui.coinType]) {
      await act(async () => { setInputValue(input, query); input.dispatchEvent(testEvent("input")); });
      const option = [...container.querySelectorAll<HTMLElement>('[role="option"]')].find((row) => row.textContent?.includes("SUI"));
      assert.ok(option, `${query} shows SUI`);
    }
    await act(async () => input.dispatchEvent(testEvent("keydown", { key: "Enter" })));
    assert.deepEqual(picked, ["SUI"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("the coin picker selects held DEEP and WAL by keyboard and keeps unknown decimals visible but disabled", async () => {
  const base = FIXTURE_COINS[0]!;
  const deep: WalletCoinView = { ...base, key: "deep", coinType: `0x${"9".repeat(64)}::deep::DEEP`, symbol: "DEEP", name: "DeepBook", presale: null };
  const wal: WalletCoinView = { ...base, key: "wal", coinType: `0x${"8".repeat(64)}::wal::WAL`, symbol: "WAL", name: "Walrus", presale: null };
  const unknown: WalletCoinView = { ...base, key: "unknown", coinType: `0x${"7".repeat(64)}::coin::TOKEN`, symbol: "TOKEN", name: "TOKEN (base units)", metadataAvailable: false, presale: null };
  const picked: string[] = [];
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<TokenPickerBody current={base} wallet={[base, deep, wal, unknown]} pins={[]} hidden={false} listCoins={async () => []} onPick={(coin) => picked.push(coin.symbol)} />));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    const options = [...container.querySelectorAll<HTMLElement>('[role="option"]')];
    const disabled = options.find((option) => option.textContent?.includes("TOKEN"))!;
    assert.equal(disabled.getAttribute("aria-disabled"), "true");
    assert.match(disabled.textContent!, /Metadata unavailable/);
    await act(async () => disabled.click());
    assert.deepEqual(picked, []);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Search coins"]')!;
    for (const symbol of ["DEEP", "WAL"]) {
      await act(async () => { setInputValue(input, symbol); input.dispatchEvent(testEvent("input")); });
      await act(async () => input.dispatchEvent(testEvent("keydown", { key: "ArrowDown" })));
      await act(async () => input.dispatchEvent(testEvent("keydown", { key: "Enter" })));
    }
    assert.deepEqual(picked, ["DEEP", "WAL"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("sign-in keeps the swap amount and pair, asks for a fresh quote, and never sends automatically", async () => {
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  const client = createTestQueryClient();
  let signIns = 0;
  let trades = 0;
  const reads: boolean[] = [];
  const render = async (signedIn: boolean, sessionPending = false) => {
    await act(async () => root.render(withQueryClient(client,
      <SocialViewerProvider signedIn={signedIn} sessionPending={sessionPending} callsign={signedIn ? "pilot" : null}>
        <CoinSheet
          first={{ kind: "trade", key: "usdc", out: "sui" }} session={1} open
          onClose={() => undefined} onCopy={() => undefined} onRetry={() => undefined} onWithdraw={async () => false}
          wallet={signedIn && !sessionPending ? { status: "ready", address: "0x1", fee: "sponsored", coins: FIXTURE_COINS } : { status: sessionPending ? "loading" : "visitor" }}
          trading={{
            signedIn, sessionPending, balanceKnown: signedIn && !sessionPending,
            onSignIn: () => { signIns += 1; }, listCoins: async () => [],
            requestQuote: async (request) => {
              reads.push(signedIn);
              return { status: "ok", httpStatus: 200, body: fixtureQuote(request, FIXTURE_COINS, DEFAULT_SWAP_MODE, Date.now()) };
            },
            trade: async () => { trades += 1; return { status: "traded" }; },
          }}
        />
      </SocialViewerProvider>,
    )));
  };
  try {
    await render(false);
    const input = dom.document.querySelector<HTMLInputElement>('[data-coin-focus]')!;
    await act(async () => { setInputValue(input, "100"); input.dispatchEvent(testEvent("input")); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)); });
    assert.ok(reads.includes(false), "visitors can quote");
    const button = dom.document.querySelector<HTMLButtonElement>('[data-trade]')!;
    assert.equal(button.textContent, "Sign in");
    await act(async () => button.click());
    assert.equal(signIns, 1);
    await render(false, true);
    assert.equal(button.disabled, true);
    assert.match(button.textContent ?? "", /Restoring session/);
    await render(true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)); });
    assert.equal(dom.document.querySelector('[data-coin-focus]'), input);
    assert.equal(input.value, "100");
    const screen = dom.document.body.cloneNode(true) as HTMLElement;
    screen.querySelectorAll("style").forEach(style => style.remove());
    assert.match(screen.textContent ?? "", /PayBalance [\d,.]+\u00a0USDCUSDC.*ReceiveBalance [\d,.]+\u00a0SUI[\d,.]+SUI/);
    assert.ok(reads.includes(true), "the signed-in viewer gets a fresh quote");
    assert.equal(trades, 0);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  }
});

test("the pay balance keeps one slot through session restore, signer resolution and exact coin reads", async () => {
  const host = dom.document.createElement("div");
  const root = createRoot(host);
  const client = createTestQueryClient();
  const originalFetch = globalThis.fetch;
  const address = "0x" + "c".repeat(64);
  let answer: ((atoms: string) => void) | undefined;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://blast.test");
    assert.equal(url.pathname, "/api/social/me/wallet");
    return new Promise<Response>((resolve) => {
      answer = (atoms) => resolve(Response.json({ address, coin_type: url.searchParams.get("balance_coin"), atoms, as_of_ms: Date.now() }));
    });
  };
  const render = (signedIn: boolean, sessionPending: boolean, walletAddress: string | null, inCoin = FIXTURE_COINS[1]!) =>
    act(async () => root.render(withQueryClient(client,
      <SocialViewerProvider signedIn={signedIn} callsign={null} getAccessToken={async () => "fixture"}>
        <SwapForm active persistent inCoin={inCoin} outCoin={FIXTURE_COINS[2]!} field={typedAmount("", inCoin.decimals)}
          onField={() => {}} detail={false} onDetail={() => {}} onFlip={() => {}} onPick={() => {}}
          trading={{ signedIn, sessionPending, walletAddress, onSignIn() {}, listCoins: async () => [],
            requestQuote: async () => ({ status: "error" }), trade: async () => ({ status: "traded" }) }}
          walletFee="sponsored" hidden={false} />
      </SocialViewerProvider>,
    )));
  const slot = () => host.querySelector('[id$="-balance"]');
  try {
    await render(false, true, null);
    const first = slot()!;
    const action = host.querySelector<HTMLButtonElement>("[data-trade]")!;
    assert.equal(action.textContent, "Swap");
    assert.equal(action.disabled, true);
    assert.ok(first.querySelector('[aria-label="Checking balance"]'));
    await render(true, true, null);
    assert.equal(slot(), first);
    assert.equal(answer, undefined, "no private read before the signer resolves");
    await render(true, false, address);
    assert.ok(answer);
    assert.equal(action.textContent, "Swap", "the action stays in place while the private read finishes");
    assert.equal(action.disabled, true);
    assert.equal(slot(), first);
    assert.ok(first.querySelector('[aria-label="Checking balance"]'));
    await act(async () => { answer!("42000000000"); await settleQueries(client); });
    assert.equal(slot(), first);
    assert.match(first.textContent ?? "", /42.*SUI/);
    await render(true, false, address, FIXTURE_COINS[0]!);
    assert.ok(first.querySelector('[aria-label="Checking balance"]'));
    assert.doesNotMatch(first.textContent ?? "", /42/);
    await render(false, false, null);
    assert.equal(slot(), first);
    assert.equal(first.textContent, "Balance —");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    client.clear();
  }
});

test("a rejected trade releases the busy controls and asks the person to check their wallet", async () => {
  const inCoin = FIXTURE_COINS[1]!;
  const outCoin = FIXTURE_COINS[0]!;
  const quote = fixtureQuote({ in_coin: inCoin.coinType, out_coin: outCoin.coinType, side: "sell", amount_in: "100000000000" }, FIXTURE_COINS, DEFAULT_SWAP_MODE, Date.now());
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  const client = createTestQueryClient();
  let calls = 0;
  try {
    await act(async () => root.render(withQueryClient(client,
      <SwapForm
        active
        inCoin={inCoin} outCoin={outCoin} field={typedAmount("100", inCoin.decimals)}
        onField={() => undefined} detail={false} onDetail={() => undefined}
        onFlip={() => undefined} onPick={() => undefined} hidden={false} walletFee="sponsored"
        trading={{ signedIn: true, onSignIn: () => undefined, listCoins: async () => [], requestQuote: async () => ({ status: "ok", body: quote, httpStatus: 200 }), trade: async () => { calls += 1; throw new Error("Transport interrupted"); } }}
      />,
    )));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)); });
    const button = container.querySelector<HTMLButtonElement>("[data-trade]")!;
    assert.equal(button.disabled, false);
    await pressTrade(button, client);
    assert.equal(calls, 1);
    assert.equal(button.textContent, "Swap", "the button keeps its verb; the line above says what failed");
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /Check your wallet before retrying/);
    assert.equal(button.getAttribute("aria-busy"), null);
    assert.equal(container.querySelector<HTMLInputElement>("input")!.disabled, false);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  }
});

test("the estimate stays on past the server quote's expiry; a press whose sealed quote already lapsed never trades", async () => {
  const inCoin = FIXTURE_COINS[1]!;
  const outCoin = FIXTURE_COINS[0]!;
  const quote = { ...fixtureQuote({ in_coin: inCoin.coinType, out_coin: outCoin.coinType, side: "sell", amount_in: "100000000000" }, FIXTURE_COINS, DEFAULT_SWAP_MODE, Date.now()), expires_at_ms: Date.now() + 900 };
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  const client = createTestQueryClient();
  let trades = 0;
  let asks = 0;
  try {
    await act(async () => root.render(withQueryClient(client,
      <SwapForm
        active
        inCoin={inCoin} outCoin={outCoin} field={typedAmount("100", inCoin.decimals)}
        onField={() => undefined} detail={false} onDetail={() => undefined}
        onFlip={() => undefined} onPick={() => undefined} hidden={false} walletFee="sponsored"
        trading={{ signedIn: true, onSignIn: () => undefined, listCoins: async () => [], requestQuote: async () => { asks += 1; return { status: "ok", body: quote, httpStatus: 200 }; }, trade: async () => { trades += 1; return { status: "traded" }; } }}
      />,
    )));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)); });
    const button = container.querySelector<HTMLButtonElement>("[data-trade]")!;
    assert.equal(button.disabled, false);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 650)); });
    assert.equal(button.disabled, false, "the estimate carries no expiry");
    await act(async () => button.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
    assert.equal(asks, 2, "the press asked for its sealed quote");
    assert.match(container.querySelector('[role="alert"]')!.textContent!, /The price changed before sending. Nothing was sent./);
    assert.equal(trades, 0);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  }
});

test("a press whose seal fails or is refused ends at once: the line says why, nothing is asked again until the next press", async () => {
  const inCoin = FIXTURE_COINS[1]!;
  const outCoin = FIXTURE_COINS[0]!;
  const quote = fixtureQuote({ in_coin: inCoin.coinType, out_coin: outCoin.coinType, side: "sell", amount_in: "100000000000" }, FIXTURE_COINS, DEFAULT_SWAP_MODE, Date.now());
  // The server's shape (`unavailableQuote`): no amounts at all.
  const refused = { ...quote, quote_id: null, expires_at_ms: null, amount_in: null, amount_out: null, min_out: null, unavailable_reason: "dry_run_failed" as const };
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  const client = createTestQueryClient();
  const answers: Awaited<ReturnType<Parameters<typeof SwapForm>[0]["trading"]["requestQuote"]>>[] = [];
  let asks = 0;
  let trades = 0;
  try {
    await act(async () => root.render(withQueryClient(client,
      <SwapForm
        active
        inCoin={inCoin} outCoin={outCoin} field={typedAmount("100", inCoin.decimals)}
        onField={() => undefined} detail={false} onDetail={() => undefined}
        onFlip={() => undefined} onPick={() => undefined} hidden={false} walletFee="sponsored"
        trading={{ signedIn: true, onSignIn: () => undefined, listCoins: async () => [], requestQuote: async () => { asks += 1; return answers.shift() ?? { status: "ok", body: { ...quote, quote_id: null }, httpStatus: 200 }; }, trade: async () => { trades += 1; return { status: "traded" }; } }}
      />,
    )));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)); });
    const button = container.querySelector<HTMLButtonElement>("[data-trade]")!;
    assert.equal(asks, 1, "the estimate");
    answers.push({ status: "error" });
    await act(async () => button.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    assert.equal(asks, 2, "the press sealed once");
    assert.match(container.textContent ?? "", /could not be confirmed/);
    assert.equal(button.disabled, false, "the next press is the retry");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5_600)); });
    assert.equal(asks, 2, "a failed seal is never asked again on its own");
    answers.push({ status: "ok", body: refused, httpStatus: 200 });
    await act(async () => button.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    assert.equal(asks, 3);
    assert.match(container.textContent ?? "", /wouldn’t go through right now/, "the refusal names its reason");
    assert.doesNotMatch(container.textContent ?? "", /could not be confirmed/, "the next press clears the failed line");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_000)); });
    assert.equal(asks, 3, "a refused seal is never asked again on its own");
    assert.equal(button.disabled, false, "the estimate stands (it is never read again here): the next press asks again");
    answers.push({ status: "ok", body: { ...quote, quote_id: "sealed-retry" }, httpStatus: 200 });
    await act(async () => button.click());
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
    assert.equal(asks, 4, "the retry is one sealed ask");
    assert.equal(trades, 1, "an offered quote trades immediately");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  }
});

test("selecting a different coin restores focus to the same picker trigger on both sides", async (t) => {
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  const client = createTestQueryClient();
  dom.document.documentElement.dataset.blastInput = "keyboard";
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    delete dom.document.documentElement.dataset.blastInput;
  });
  await act(async () => root.render(withQueryClient(client,
    <SocialViewerProvider signedIn callsign="pilot">
      <CoinSheet first={{ kind: "trade", key: "usdc", out: "sui" }} session={1} open
        wallet={{ status: "ready", address: "0x1", fee: "sponsored", coins: FIXTURE_COINS }}
        trading={{ signedIn: true, onSignIn: () => undefined, listCoins: async () => [], requestQuote: async () => ({ status: "error" }), trade: async () => ({ status: "traded" }) }}
        onClose={() => undefined} onCopy={() => undefined} onRetry={() => undefined} onWithdraw={async () => false} />
    </SocialViewerProvider>,
  )));
  for (const { side, symbol } of [{ side: "in", symbol: "KSTL" }, { side: "out", symbol: "LUMN" }]) {
    const trigger = dom.document.querySelector<HTMLButtonElement>(`[data-coin-pick="${side}"]`)!;
    await act(async () => { trigger.focus(); trigger.click(); });
    const search = dom.document.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await act(async () => { setInputValue(search, symbol); search.dispatchEvent(testEvent("input")); });
    await act(async () => search.dispatchEvent(testEvent("keydown", { key: "ArrowDown" })));
    await act(async () => search.dispatchEvent(testEvent("keydown", { key: "Enter" })));
    const restored = dom.document.querySelector<HTMLButtonElement>(`[data-coin-pick="${side}"]`)!;
    assert.match(restored.getAttribute("aria-label")!, new RegExp(symbol));
    assert.ok(dom.document.activeElement === restored, `Focus should return to the ${side} coin picker trigger`);
  }
});


test("persistent trading holds pending execution without reporting success or sending twice", async () => {
  const inCoin = FIXTURE_COINS[1]!;
  const outCoin = FIXTURE_COINS[0]!;
  const quote = fixtureQuote({ in_coin: inCoin.coinType, out_coin: outCoin.coinType, side: "sell", amount_in: "100000000000" }, FIXTURE_COINS, DEFAULT_SWAP_MODE, Date.now());
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  const root = createRoot(container);
  const client = createTestQueryClient();
  let trades = 0;
  try {
    await act(async () => root.render(withQueryClient(client, <SwapForm active persistent
      inCoin={inCoin} outCoin={outCoin} field={typedAmount("100", inCoin.decimals)}
      onField={() => undefined} detail={false} onDetail={() => undefined}
      onFlip={() => undefined} onPick={() => undefined} hidden={false} walletFee="sponsored"
      trading={{ signedIn: true, onSignIn: () => undefined, listCoins: async () => [], requestQuote: async () => ({ status: "ok", body: quote, httpStatus: 200 }), trade: async () => { trades += 1; return { status: "pending" }; } }}
    />)));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)); });
    const button = container.querySelector<HTMLButtonElement>("[data-trade]")!;
    await pressTrade(button, client);
    assert.equal(button.disabled, true);
    assert.equal(button.textContent, "Swapping…", "a sent trade still confirming keeps the running verb, off");
    assert.equal(container.querySelector('[id$="-cost"]')!.textContent, "Waiting for your wallet. Check it before you trade again.");
    assert.doesNotMatch(container.textContent!, /Successful|Swap successful/);
    await act(async () => button.click());
    assert.equal(trades, 1);
    assert.equal(container.querySelector<HTMLInputElement>("input")!.disabled, true);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  }
});


test("a remounted form with a retained quote cache requires a new answer on return before enabling trade", async t => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_791_000_000_000 });
  const client = createTestQueryClient({ queries: { gcTime: 300_000 } });
  const container = dom.document.createElement("div");
  dom.document.body.appendChild(container);
  let root = createRoot(container);
  const inCoin = FIXTURE_COINS[0]!;
  const outCoin = FIXTURE_COINS[2]!;
  let reads = 0;
  let holdAnswer = false;
  let answer: (() => void) | null = null;
  function Screen({ active }: Readonly<{ active: boolean }>) {
    const [field, setField] = useState(() => typedAmount("100", inCoin.decimals));
    return <SwapForm active={active} inCoin={inCoin} outCoin={outCoin} field={field} onField={setField}
      detail={false} onDetail={() => {}} onFlip={() => {}} onPick={() => {}} hidden={false} walletFee="sponsored"
      trading={{ signedIn: true, onSignIn() {}, listCoins: async () => [],
        requestQuote: async request => {
          reads += 1;
          const quote = fixtureQuote(request, FIXTURE_COINS, DEFAULT_SWAP_MODE, Date.now());
          if (holdAnswer) await new Promise<void>(resolve => { answer = resolve; });
          return { status: "ok", body: quote, httpStatus: 200 };
        },
        trade: async () => { throw new Error("this test must never execute a trade"); },
      }} />;
  }
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await act(async () => {
      t.mock.timers.tick(1);
      await new Promise<void>(resolve => setImmediate(resolve));
    });
  };
  const render = async (active: boolean) => {
    await act(async () => root.render(withQueryClient(client,
      <SocialViewerProvider signedIn callsign="pilot"><Screen active={active} /></SocialViewerProvider>)));
    await flush();
  };
  const debounce = async () => {
    await act(async () => t.mock.timers.tick(300));
    await flush();
  };
  const submit = () => container.querySelector<HTMLButtonElement>("[data-trade]")!;
  try {
    await render(true);
    await debounce();
    assert.equal(reads, 1);
    assert.equal(submit().disabled, false);
    await render(false);
    await render(true);
    await debounce();
    assert.equal(reads, 2, "the first return gets a new dry run");
    assert.equal(submit().disabled, false);

    await act(async () => root.unmount());
    root = createRoot(container);
    await render(true);
    await debounce();
    assert.equal(reads, 2, "an ordinary same-request remount can reuse its fresh quote");
    assert.equal(submit().disabled, false);
    await render(false);
    holdAnswer = true;
    await render(true);
    assert.equal(submit().disabled, true, "return cannot submit the previous mount's quote during debounce");
    await debounce();
    assert.equal(reads, 3, "return starts a distinct quote read despite the retained five-minute cache");
    assert.equal(submit().disabled, true, "fresh wallet facts cannot enable trade while its new quote is withheld");
    assert.equal(container.querySelector<HTMLInputElement>("input")!.value, "100", "return retains the user's amount");
    assert.ok(answer, "a new quote answer is pending");
    await act(async () => answer!());
    await flush();
    assert.equal(submit().disabled, false, "eligibility returns only after the new dry run settles");
  } finally {
    const readsBeforeUnmount = reads;
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    await act(async () => t.mock.timers.tick(30_000));
    await flush();
    assert.equal(reads, readsBeforeUnmount, "unmount cannot start another quote read");
  }
});
