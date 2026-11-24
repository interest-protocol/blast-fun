import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom, setInputValue } from "../../../../test/fixtures/social/test-dom.ts";
import { FIXTURE_COINS } from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";
import { fixtureQuote } from "../../../../test/fixtures/social/coins/swap-fixture.ts";
import { KAI, STORY_NOW, TIDE } from "../../../../test/fixtures/social/commit/commit-fixtures.ts";
import { ACCESS_TOKEN, WALLET_ADDRESS, walletReads } from "../../../../test/fixtures/social/commit/wallet-reads.ts";
import type { SocialTradeQuoteRequest } from "@blast/core/modules/social/contracts/trades.ts";
import type { CommitBlastInput } from "./CommitPanel";

const dom = installTestDom();
Object.assign(dom.document, { oninput: null });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { SocialViewerProvider } = await import("../SignInGate");
const { CommitPanel } = await import("./CommitPanel");
const WAL = { ...FIXTURE_COINS[1]!, key: "wal", coinType: `0x${"a".repeat(64)}::wal::WAL`, symbol: "WAL", name: "Walrus", price: 2, atoms: 100_000_000_000n };
const SUI = { ...FIXTURE_COINS[1]!, price: null, value: null, atoms: 50_000_000_000n, amount: 50 };
const coins = [FIXTURE_COINS[0]!, WAL];

async function pickPayment(container: HTMLElement, symbol: string) {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label^="Pay with"]')!;
  assert.ok(trigger, "payment uses the shared coin modal at every wallet size");
  assert.equal(container.querySelector('select[aria-label="Pay with"]'), null);
  await act(async () => trigger.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
  const option = Array.from(dom.document.querySelectorAll<HTMLElement>('[role="option"]')).find(option => option.textContent?.includes(symbol));
  assert.ok(option, `picker lists ${symbol}`);
  await act(async () => option.click());
}

test("with no USDC, a held coin funds the presale with one clear swap-and-buy action; no liquidity disables it", async (t) => {
  const originalFetch = globalThis.fetch;
  let available = true;
  const asked: SocialTradeQuoteRequest[] = [];
  const wallet = walletReads(coins);
  globalThis.fetch = wallet.wrap(async (url, init) => {
    if (String(url) !== "/api/social/trades/quote") return Response.json({}, { status: 503 });
    const request = JSON.parse(String(init?.body)) as SocialTradeQuoteRequest;
    asked.push(request);
    return Response.json(fixtureQuote(request, coins, { quote: available ? "ok" : "unavailable", trade: "ok", signedIn: true, fee: "sponsored" }, Date.now()));
  });
  const sent: CommitBlastInput[] = [];
  const container = dom.document.createElement("div"); container.setAttribute("data-blast-ui", ""); dom.document.body.append(container);
  const root = createRoot(container);
  const client = createTestQueryClient();
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); globalThis.fetch = originalFetch; });
  await act(async () => root.render(withQueryClient(client, <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}>
    <CommitPanel sale={TIDE} viewer={{ ...KAI, usdc: 0 }} walletCoins={coins} walletAddress={WALLET_ADDRESS} walletFee="sponsored" blockers={[]} nowMs={STORY_NOW} onBlast={async (input) => { sent.push(input); return { ok: true }; }} onDeposit={() => assert.fail("a routed purchase must not open a deposit")} inline />
  </SocialViewerProvider>)));
  await pickPayment(container, "WAL");
  const type = async (value: string) => act(async () => { const input = container.querySelector<HTMLInputElement>("input")!; setInputValue(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  await type("25");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  const buy = () => container.querySelector<HTMLButtonElement>('[data-ui-variant="primary"]')!;
  assert.equal(buy().textContent, "Swap & contribute");
  assert.equal(buy().disabled, false);
  assert.match(container.textContent!, /You contribute 49.75 USDC/);
  assert.match(container.textContent!, /Paid by Blast/);
  assert.equal(asked[0]!.in_coin, WAL.coinType);
  await act(async () => buy().click());
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.quoteAtoms, "49750000");
  assert.match(sent[0]!.swapQuoteId!, /^q1\./);
  assert.equal(sent[0]!.paymentSymbol, "WAL");
  available = false;
  await type("30");
  assert.equal(buy().disabled, true, "changing the amount invalidates the old executable quote immediately");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  assert.equal(buy().disabled, true);
  assert.match(container.textContent!, /No pool|no pool|liquidity|route/i);
  assert.equal(sent.length, 1);
});

test("SUI can be paid directly at full precision or bought with WAL; switching coins drops the previous quote", async (t) => {
  const sale = { ...TIDE, name: "ALON", symbol: "ALON", quoteType: SUI.coinType, quoteCoin: SUI.symbol, quoteDecimals: 9 };
  const originalFetch = globalThis.fetch;
  const asked: SocialTradeQuoteRequest[] = [];
  const wallet = walletReads([SUI, WAL]);
  globalThis.fetch = wallet.wrap(async (url, init) => {
    assert.equal(String(url), "/api/social/trades/quote");
    const request = JSON.parse(String(init?.body)) as SocialTradeQuoteRequest;
    asked.push(request);
    const quote = fixtureQuote(request, [WAL, { ...SUI, price: 1 }], { quote: "ok", trade: "ok", signedIn: true, fee: "sponsored" }, Date.now());
    return Response.json({ ...quote, amount_in_usd: null, amount_out_usd: null, price_per_out: null });
  });
  const sent: CommitBlastInput[] = [];
  const container = dom.document.createElement("div"); container.setAttribute("data-blast-ui", ""); dom.document.body.append(container);
  const root = createRoot(container); const client = createTestQueryClient();
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); globalThis.fetch = originalFetch; });
  await act(async () => root.render(withQueryClient(client, <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}>
    <CommitPanel sale={sale} viewer={{ ...KAI, suiUsd: null, quoteCoin: "SUI", quoteBalance: 50, quoteUsd: null }} walletCoins={[SUI, WAL]} walletAddress={WALLET_ADDRESS} walletFee="sponsored" blockers={[]} nowMs={STORY_NOW} onBlast={async (input) => { sent.push(input); return { ok: true }; }} onDeposit={() => assert.fail("no deposit")} inline purchase compact />
  </SocialViewerProvider>)));
  const field = () => container.querySelector<HTMLInputElement>("input")!;
  const buy = () => container.querySelector<HTMLButtonElement>('[data-ui-variant="primary"]')!;
  const type = async (value: string) => act(async () => { setInputValue(field(), value); field().dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  assert.equal(field().value, "", "the payment amount starts empty");
  await type("25.000000001");
  assert.equal(field().value, "25.000000001");
  assert.equal(buy().disabled, false);
  await act(async () => buy().click());
  assert.deepEqual([sent[0]!.payWith, sent[0]!.quoteAtoms, sent[0]!.usd, sent[0]!.swapQuoteId], ["SUI", "25000000001", 0, undefined]);
  await pickPayment(container, WAL.symbol); await type("25");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  assert.equal(asked[0]!.out_coin, SUI.coinType);
  assert.match(container.textContent!, /You contribute 49.75 SUI/);
  assert.match(container.textContent!, /0.251256 SUI/);
  assert.equal(buy().textContent, "Swap & contribute");
  await act(async () => buy().click());
  assert.equal(sent[1]!.quoteAtoms, "49750000000");
  assert.equal(sent[1]!.paymentSymbol, "WAL");
  await pickPayment(container, SUI.symbol);
  assert.equal(field().value, ""); assert.equal(buy().disabled, true);
  await type("25"); await act(async () => buy().click());
  assert.equal(sent[2]!.swapQuoteId, undefined);
  assert.equal(sent[2]!.quoteAtoms, "25000000000");
});

test("ALON keeps a valid USDC amount, refuses an unsupported route and offers direct SUI payment", async (t) => {
  const { ALON_READ, ALON_NOW } = await import("../../../../test/fixtures/social/commit/alon.ts");
  const { commitSaleOf } = await import("./commit-view");
  const sale = commitSaleOf({ ...ALON_READ, presale: { ...ALON_READ.presale, quote_type: SUI.coinType, quote_symbol: SUI.symbol } }, { suiUsd: null })!;
  const usdc = FIXTURE_COINS[0]!;
  const originalFetch = globalThis.fetch;
  const wallet = walletReads([usdc, SUI]);
  globalThis.fetch = wallet.wrap(async (url, init) => {
    assert.equal(String(url), "/api/social/trades/quote");
    return Response.json(fixtureQuote(JSON.parse(String(init?.body)) as SocialTradeQuoteRequest, [usdc, SUI], { quote: "unavailable", trade: "ok", signedIn: true, fee: "sponsored" }, Date.now()));
  });
  const sent: CommitBlastInput[] = [];
  const container = dom.document.createElement("div"); container.setAttribute("data-blast-ui", ""); dom.document.body.append(container);
  const root = createRoot(container); const client = createTestQueryClient();
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); globalThis.fetch = originalFetch; });
  await act(async () => root.render(withQueryClient(client, <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}>
    <CommitPanel sale={sale} viewer={{ ...KAI, suiUsd: null, quoteCoin: "SUI", quoteBalance: 50, quoteUsd: null }} walletCoins={[usdc, SUI]} walletAddress={WALLET_ADDRESS} draft={{ coinType: usdc.coinType, amount: "10", why: "" }} blockers={[]} nowMs={ALON_NOW} onBlast={async (input) => { sent.push(input); return { ok: true }; }} onDeposit={() => assert.fail("no deposit")} inline />
  </SocialViewerProvider>)));
  const field = () => container.querySelector<HTMLInputElement>("input")!;
  const buy = () => container.querySelector<HTMLButtonElement>('[data-ui-variant="primary"]')!;
  assert.equal(field().value, "10");
  assert.equal(buy().disabled, true);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
  assert.match(container.textContent!, /No route from USDC to SUI/);
  assert.equal(buy().disabled, true);
  assert.equal(sent.length, 0);
  assert.equal(field().value, "10", "failure preserves the selected coin and amount");
  await pickPayment(container, "SUI");
  assert.equal(field().value, "", "changing units clears the old USDC amount");
  assert.ok(container.querySelector('button[aria-label="Pay with SUI"]'));
  await act(async () => { setInputValue(field(), "10"); field().dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  assert.equal(buy().disabled, false);
  await act(async () => buy().click());
  assert.equal(sent[0]!.quoteAtoms, "10000000000");
  assert.equal(sent[0]!.swapQuoteId, undefined);
});
