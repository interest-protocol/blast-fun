import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { DisclosureButton } from "#web/components/blast-ui/Button.tsx";
import type { WalletCoinBalance } from "#web/components/social/coins/use-wallet-coin-balance.ts";

import { CREATE_SUI_QUOTE_TYPE, CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import type { ActionState, FreshReview } from "../transaction/action-machine";
import type { ActionController } from "../transaction/controller";
import { LaunchpadSignerProvider } from "../transaction/LaunchpadSignerProvider";
import { TradeRail } from "./TradeRail";
import { tradePresetAmount } from "./trade-display.ts";
import type { CurveTradeInput } from "./curve-adapter";

const input: CurveTradeInput = { launchId: "0x1", direction: "buy", amount: "10", slippageBps: 100n };
const editing: ActionState<CurveTradeInput> = { phase: "editing", input, attempt: 0, notice: null };
const asset = { symbol: "TOAD", decimals: 6, quote: { coinType: CREATE_TEST_SUI_QUOTE_TYPE, decimals: 9, symbol: "TEST_SUI", iconUrl: null } };

function frozen(state: ActionState<CurveTradeInput>): ActionController<CurveTradeInput> {
  return {
    getState: () => state, subscribe: () => () => {}, onInvalidate: () => () => {},
    edit() {}, submit() {}, chooseSigner() {}, cancel() {}, approve() {}, recheck() {}, acknowledge() {},
  };
}

function render(state = editing, options: { reading?: boolean; problem?: string; asset?: typeof asset; direction?: "buy" | "sell"; price?: string; paymentControl?: ReactNode; payBalance?: WalletCoinBalance; estimate?: { receive: string; minimum: string; detail: string; minimumAtomic?: bigint } } = {}) {
  let bridges = 0;
  const session = {
    controllers: { buy: frozen(state), sell: frozen({ ...editing, input: { ...input, direction: "sell" } }) },
    direction: options.direction ?? "buy", setDirection() {}, balances: { quote: 20_000_000_000n, meme: 15_000_000n }, refresh() {},
  };
  const html = renderToStaticMarkup(<LaunchpadSignerProvider kinds={["wallet", "privy"]} renderBridge={() => void (bridges += 1)}>
    <TradeRail session={session} asset={options.asset ?? asset} ready={!options.reading && !options.problem} reading={!!options.reading} problem={options.problem ?? null} price={options.price} estimate={() => options.estimate ?? null} paymentControl={options.paymentControl} payBalance={options.payBalance} receipt={() => null} />
  </LaunchpadSignerProvider>);
  return { html, text: html.replace(/<[^>]*>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " "), bridges };
}

test("the coin trade rail uses quote marks, exact balances and shared controls without initializing wallets", () => {
  const { html, text, bridges } = render();
  assert.match(text, /Buy Sell/);
  assert.match(text, /Balance: 20 TSUI/);
  assert.match(html, /<button [^>]*aria-label="Inspect full balance: 20 TEST_SUI"[^>]*>20\sTSUI<\/button>/);
  assert.equal([...html.matchAll(/aria-label="TEST_SUI"/g)].length, 1, "only the pay coin has a logo");
  assert.match(text, /TSUI/);
  assert.doesNotMatch(text, /TEST_SUI|\bSUI\b|\bUSDC\b/);
  assert.match(html, /aria-label="Trade direction"/);
  assert.match(text, /Slippage tolerance 0\.5% 1% 2%/);
  assert.match(html, /aria-label="Slippage tolerance"[^>]*role="group"/);
  assert.match(text, /Buy TOAD/);
  assert.equal(bridges, 0);
});

test("a copied TEST_SUI ticker does not receive the canonical quote alias", () => {
  const copied = { ...asset, quote: { ...asset.quote, coinType: "0x123::copy::TEST_SUI" } };
  const shown = render(editing, { asset: copied });
  assert.match(shown.text, /TEST_SUI/);
  assert.doesNotMatch(shown.text, /TSUI/);
});

test("the payment selector shares the amount field and replaces the static unit", () => {
  const { html } = render(editing, { paymentControl: <DisclosureButton aria-label="Pay with TEST_SUI">TEST_SUI</DisclosureButton> });
  const field = html.slice(html.indexOf('data-ui-field=""'), html.indexOf('class="amt amtOut"'));
  assert.ok(field);
  assert.match(field, /<input/);
  assert.match(field, /aria-label="Pay with TEST_SUI"/);
  assert.doesNotMatch(field.slice(field.indexOf('<div class="amtRow"')), /aria-label="TEST_SUI"/);
});

test("routed payment balance never falls back to the curve's own quote balance", () => {
  const loading = render(editing, { payBalance: { status: "loading" } });
  assert.match(loading.html, /Reading your wallet/);
  assert.match(loading.html, /<button[^>]*disabled=""[^>]*>Max<\/button>/);
  assert.doesNotMatch(loading.text, /Balance: 20 TSUI/);
  const unavailable = render(editing, { payBalance: { status: "unavailable", retry() {} } });
  assert.match(unavailable.text, /Retry balance/);
  assert.doesNotMatch(unavailable.text, /Balance: 20 TSUI/);
  assert.match(render(editing, { payBalance: { status: "ready", atoms: 0n } }).text, /Balance: 0 TSUI/);
});

test("loading and failed reads show their recovery states and disable review", () => {
  assert.match(render(editing, { reading: true }).html, /Reading trading route/);
  const failed = render(editing, { problem: "The node did not answer." });
  assert.match(failed.text, /Trading couldn't load The node did not answer\. Try again/);
  assert.match(failed.html, /<button[^>]*disabled=""[^>]*>Buy TOAD/);
});

test("a subscript-zero pool price retains its quote coin mark", () => {
  const { html, text } = render(editing, { price: "1 TOAD = 0.0₉246 TEST_SUI" });
  assert.match(text, /1 TOAD = 0\.0₉246/);
  assert.match(html, /aria-label="TEST_SUI"/);
  assert.doesNotMatch(text, /TEST_SUI|\$/);
});

test("choosing a signer stays explicit and an ambiguous buy prevents selling", () => {
  const choosing = render({ phase: "choosing-signer", input, attempt: 1 });
  assert.match(choosing.text, /Connect Sui wallet Continue with Blast wallet Cancel/);
  assert.equal(choosing.bridges, 0);
  const state = { phase: "ambiguous", input, attempt: 1, digest: "fixture-digest", reason: "submission-unknown", message: "Check the submitted transaction." } as ActionState<CurveTradeInput>;
  const ambiguous = render(state);
  assert.match(ambiguous.text, /Check transaction/);
  assert.doesNotMatch(ambiguous.text, /Review buy|Buy and sign/);
  const sell = render(state, { direction: "sell" });
  assert.match(sell.text, /A buy is unresolved/);
  assert.match(sell.html, /<button[^>]*disabled=""[^>]*>Sell 10 TOAD/);
});


test("quote marks preserve meme symbols that contain the quote symbol", () => {
  const collision = { ...asset, symbol: "SUICAT", quote: { ...asset.quote, coinType: CREATE_SUI_QUOTE_TYPE, symbol: "SUI" } };
  const state: ActionState<CurveTradeInput> = { input, attempt: 0, phase: "review", changes: [], review: { id: "fixture", signer: { kind: "wallet", address: "0x1", chain: "sui:mainnet" }, deploymentFingerprint: "fixture", transactionBytes: new Uint8Array(), facts: [
    { key: "trade", label: "Trade", value: "Buy SUICAT with SUI" },
    { key: "balance-quote", label: "Your SUI balance", value: "100 SUI" },
    { key: "amount-out", label: "You receive", value: "20 SUICAT" },
  ] } };
  const rendered = render(state, { asset: collision });
  assert.match(rendered.text, /Check the updated trade/);
  assert.doesNotMatch(rendered.text, /Your quote balance|20 SUICAT/);
  assert.match(rendered.text, /\bSUI\b/);
  assert.match(rendered.html, /aria-label="SUI"/);
});


test("curve actions keep the primary button while checking and awaiting the wallet", () => {
  assert.match(render().text, / Buy /);
  assert.doesNotMatch(render().text, /Review buy/);
  for (const phase of ["preflighting", "signing", "reconciling"] as const) {
    const { html } = render({ ...editing, phase, purpose: "review" } as ActionState<CurveTradeInput>);
    assert.match(html, /<button[^>]*aria-busy="true"/);
    assert.doesNotMatch(html, /<h3>Review/);
  }
});


test("a curve receipt stays compact, leaves an empty amount ready to type, and a blocked quote offers a refresh", () => {
  const done: ActionState<CurveTradeInput> = { ...editing, input: { ...input, amount: "" }, phase: "succeeded", review: {} as FreshReview, digest: "fixture-digest", explorerUrl: "https://suiscan.xyz/mainnet/tx/fixture-digest" };
  const { html, text } = render(done);
  assert.match(text, /Buy confirmed\. Buy TOAD/);
  assert.doesNotMatch(text, /Trade again/);
  assert.match(html, /aria-label="View transaction"/);
  const field = html.match(/<input[^>]*id="[^"]*-amount"[^>]*>/)?.[0] ?? "";
  assert.match(field, /value=""/);
  assert.doesNotMatch(field, /disabled/, "the next amount can be typed straight away");
  assert.match(html, /<button[^>]*disabled=""[^>]*>Buy TOAD/, "nothing to buy until an amount is typed");
  assert.doesNotMatch(text, /Transaction details are still loading|Network|Blast deployment/);
  const blocked: ActionState<CurveTradeInput> = { ...editing, phase: "blocked", block: { stage: "preview", code: "ineligible", message: "The price moved.", details: [] } };
  assert.match(render(blocked).text, /The price moved\. Refresh quote/);
});


test("live curves show the shared compact amount panels and output-only buy label", () => {
  const { html, text } = render(editing, { estimate: { receive: "2,380.123456 TOAD", minimum: "2,356.322221 TOAD", detail: "Curve fees 0.1 TEST_SUI", minimumAtomic: 2356322221n } });
  assert.match(html, /swapDialog/);
  assert.match(text, /You get/);
  assert.match(html, /<button[^>]*data-trade=""[^>]*>Buy 2,380.12 TOAD<\/button>/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(text, /Buy .* with|Estimated receive/);
});

test("live curve selling names the sold amount, not the quote receive amount", () => {
  const { html } = render(editing, { direction: "sell", estimate: { receive: "0.3 TEST_SUI", minimum: "0.297 TEST_SUI", detail: "Curve fees 0.1 TEST_SUI" } });
  assert.match(html, /<button[^>]*data-trade=""[^>]*>Sell 10 TOAD<\/button>/);
  assert.doesNotMatch(html, />Sell 0.3/);
});


test("curve amount presets floor fractional atoms and preserve exact Max and tiny balances", () => {
  assert.equal(tradePresetAmount("25", 412380000000n, 9), "103.095");
  assert.equal(tradePresetAmount("max", 123456789123456789n, 9), "123,456,789.123456789");
  assert.equal(tradePresetAmount("50", 2n, 9), "0.000000001");
});
