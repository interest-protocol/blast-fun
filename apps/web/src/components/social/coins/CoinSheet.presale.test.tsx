import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom, setInputValue, recordAnimations, testEvent } from "../../../../test/fixtures/social/test-dom.ts";
import { ACCESS_TOKEN, WALLET_FACTS, installWalletReads } from "../../../../test/fixtures/social/commit/wallet-reads.ts";
import { ALON_ID, ALON_READ } from "../../../../test/fixtures/social/commit/alon.ts";
import { PUBLIC_BASE_COINS, type CoinScreen } from "./coin-model";
import { createCommitQuotes } from "../commit/commit-quote";
import { commitSaleOf, commitViewerOf } from "../commit/commit-view";
import type { CommitFacts, CommitKit } from "../commit/commit-kit";

const { document } = installTestDom();
Object.defineProperty(document, "oninput", { value: null, writable: true, configurable: true });
const motion = recordAnimations();
// The purchase form reads its payment balance fresh from the wallet, as in the app.
const WALLET = "0x" + "ab".repeat(32);
const quoteCoin = { ...PUBLIC_BASE_COINS.find(coin => coin.key === "sui")!, atoms: 50_000_000_000n, amount: 50 };
const walletCoins = PUBLIC_BASE_COINS.map(coin => coin.key === quoteCoin.key ? quoteCoin : coin);
installWalletReads(walletCoins, WALLET);
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CoinSheet } = await import("./CoinSheet");
const { FeedOverlaysProvider } = await import("../feed-ui/shell-bridge");
const { SocialViewerProvider } = await import("../SignInGate");
const { queryKeys } = await import("#web/lib/query/keys.ts");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");

const alonRead = { ...ALON_READ, presale: { ...ALON_READ.presale, quote_type: quoteCoin.coinType, quote_symbol: quoteCoin.symbol } };
const alon = { ...quoteCoin, key: ALON_ID, coinType: alonRead.presale.sale_token, symbol: "ALON", name: "alon", presale: { inPresale: true, trading: false, venue: "bluefin", multiple: null, presaleId: ALON_ID, quoteType: quoteCoin.coinType, quoteSymbol: quoteCoin.symbol } };
const settle = async () => { await act(async () => motion.finishAll()); await act(async () => new Promise(resolve => setTimeout(resolve, 80))); };
const click = async (control: Element | null) => { assert.ok(control, `Missing control; available buttons: ${[...document.querySelectorAll("button")].map(button => button.textContent).join(" | ")}`); await act(async () => { (control as HTMLElement).focus(); (control as HTMLElement).click(); }); await settle(); };
const type = async (control: Element | null, value: string) => { assert.ok(control); await act(async () => { setInputValue(control as HTMLInputElement, value); control.dispatchEvent(testEvent("input", { bubbles: true })); }); };

test("presale navigation preserves separate trade and purchase drafts and restores picker focus", async t => {
  const client = createTestQueryClient();
  client.setQueryData(queryKeys.presales.detail(ALON_ID), alonRead);
  const pending = Promise.withResolvers<Awaited<ReturnType<CommitKit["send"]>>>();
  let sends = 0;
  let closes = 0;
  const detail = { ...alonRead, presale: { ...alonRead.presale, end_ms: Date.now() + 86400000 } };
  const sale = commitSaleOf(detail, { suiUsd: null });
  const quotes = createCommitQuotes<CommitFacts>({ client, read: async () => ({ detail, sale, viewer: { ...commitViewerOf({ sale, wallet: null, entry: null, allowlist: null }), quoteBalance: 50 }, wallet: { ...WALLET_FACTS, address: WALLET }, blockers: [], proof: null }) });
  const kit: CommitKit = { quotes, quotePayment: async () => assert.fail("unexpected swap quote"), signedIn: true, signIn: () => {}, deposit: () => {}, send: async () => { sends++; return pending.promise; } };
  const container = document.createElement("div"); container.setAttribute("data-blast-ui", ""); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); quotes.dispose(); client.clear(); container.remove(); });
  const render = (first: CoinScreen, session = 1) => withQueryClient(client, <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}><FeedOverlaysProvider value={{ commitKit: kit }}>
    <CoinSheet open session={session} first={first} wallet={{ status: "ready", address: WALLET, fee: "sponsored", coins: walletCoins }} extraCoins={[alon]} trading={{ signedIn: true, onSignIn: () => {}, requestQuote: async () => ({ status: "error" }), listCoins: async () => [alon], trade: async () => ({ status: "traded" }) }} onClose={() => { closes++; }} onCopy={() => {}} onRetry={() => {}} onWithdraw={async () => false} />
  </FeedOverlaysProvider></SocialViewerProvider>);
  await act(async () => root.render(render({ kind: "trade", key: "usdc", out: "sui" })));
  await settle();
  const $ = (selector: string) => container.querySelector(selector);
  await type($("[data-coin-focus]"), "75");
  await click($('[aria-label="Change receive token (SUI)"]'));
  await click([...container.querySelectorAll('[role="option"]')].find(option => option.textContent?.includes('alon')) ?? null);
  assert.equal($("h2")?.textContent, "Buy ALON");
  assert.ok($('[aria-label="Back"]'), "Buy has a return path");
  assert.equal(($('input[inputmode="decimal"]') as HTMLInputElement).value, "", "the swap draft does not become a presale payment");
  await click($('[aria-label="Pay with USDC"]'));
  await click([...container.querySelectorAll('[aria-label="Quick choices"] button')].find(button => button.textContent === "SUI") ?? null);
  await click([...container.querySelectorAll("button")].find(button => button.textContent === "25") ?? null);
  await click($("details:last-of-type summary"));
  await type($("textarea"), "Long-term conviction");
  assert.doesNotMatch(container.textContent!, /enter a new amount/);
  await click($('[aria-label="Change receiving coin"]'));
  await click($('[aria-label="Back"]'));
  assert.equal(($('input[inputmode="decimal"]') as HTMLInputElement).value, "25");
  assert.equal(($("textarea") as HTMLTextAreaElement).value, "Long-term conviction");
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Change receiving coin");
  await click($('[aria-label="Back"]'));
  assert.equal($("h2")?.textContent, "Select coin to receive");
  await click($('[aria-label="Back"]'));
  assert.equal(($('[data-coin-focus]') as HTMLInputElement).value, "75");
  assert.equal(document.activeElement?.getAttribute("aria-label"), "Change receive token (SUI)");
  assert.equal(sends, 0, "navigation does not send money");
  await click($('[aria-label="Change receive token (SUI)"]'));
  await click([...container.querySelectorAll('[role="option"]')].find(option => option.textContent?.includes('alon')) ?? null);
  assert.equal(($('input[inputmode="decimal"]') as HTMLInputElement).value, "25");
  await click($('[data-kind="commit"] [data-ui-variant="primary"]'));
  assert.equal(($('[aria-label="Back"]') as HTMLButtonElement).disabled, true);
  assert.equal(($('[aria-label="Change receiving coin"]') as HTMLButtonElement).disabled, true, "pending purchases cannot be remounted and submitted twice");
  await act(async () => client.setQueryData(queryKeys.presales.detail(ALON_ID), { ...detail, presale: { ...detail.presale, phase: "trading" } }));
  assert.ok($("[data-kind=\"commit\"]"), "migration cannot replace a pending purchase and lose its receipt");
  await act(async () => client.setQueryData(queryKeys.presales.detail(ALON_ID), detail));
  await act(async () => pending.resolve({ status: "refused", message: "Fixture wallet declined" }));
  assert.match(container.textContent!, /Fixture wallet declined/);
  assert.equal(($('[aria-label="Back"]') as HTMLButtonElement).disabled, false);
  assert.equal(sends, 1);
  assert.equal(closes, 0, "a refused purchase does not report completion");
  await act(async () => root.render(render({ kind: "trade", key: quoteCoin.key, out: ALON_ID }, 2)));
  await settle();
  assert.equal($("h2")?.textContent, "Buy ALON");
  await click($('[aria-label="Back"]'));
  assert.equal($("h2")?.textContent, "Swap", "a directly opened Buy can return to Swap");
});

test("a coin selected during presale becomes a swap as soon as fresh wallet metadata says trading", async t => {
  const client = createTestQueryClient();
  client.setQueryData(queryKeys.presales.detail(ALON_ID), alonRead);
  const container = document.createElement("div"); container.setAttribute("data-blast-ui", ""); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  const migrated = { ...alon, presale: { ...alon.presale, inPresale: false, trading: true } };
  const render = (trading: boolean) => withQueryClient(client, <SocialViewerProvider signedIn callsign="kai"><CoinSheet open session={1} first={{ kind: "trade", key: "usdc", out: "sui" }} wallet={{ status: "ready", address: "0x" + "ab".repeat(32), fee: "sponsored", coins: [...PUBLIC_BASE_COINS, ...(trading ? [migrated] : [])] }} extraCoins={trading ? [migrated] : []} trading={{ signedIn: true, onSignIn: () => {}, requestQuote: async () => ({ status: "error" }), listCoins: async () => [alon], trade: async () => ({ status: "traded" }) }} onClose={() => {}} onCopy={() => {}} onRetry={() => {}} onWithdraw={async () => false} /></SocialViewerProvider>);
  await act(async () => root.render(render(false))); await settle();
  await click(container.querySelector('[aria-label="Change receive token (SUI)"]'));
  await click([...container.querySelectorAll('[role="option"]')].find(option => option.textContent?.includes('alon')) ?? null);
  assert.match(container.textContent!, /Presale purchases are unavailable/);
  await act(async () => client.setQueryData(queryKeys.presales.detail(ALON_ID), { ...alonRead, presale: { ...alonRead.presale, phase: "trading", sale_decimals: alon.decimals, price_usd: null } })); await settle();
  assert.ok(container.querySelector("[data-coin-focus]"), "public migration also updates a coin the wallet does not hold yet");
  await act(async () => root.render(render(true))); await settle();
  assert.ok(container.querySelector('[data-coin-focus]'), "the swap amount field appears without closing or refreshing");
  assert.match(container.textContent!, /Pay/);
  assert.doesNotMatch(container.textContent!, /Presale purchases are unavailable/);
});


test("standalone Buy restores its pair and amount after OAuth without a presale identity", async t => {
  const { SIGN_IN_DRAFT_EVENT } = await import("../sign-in-draft");
  const { tradableCoinView } = await import("./swap-model");
  const client = createTestQueryClient();
  const native = tradableCoinView({ presale_id: null, coin_type: "0x" + "ca".repeat(32) + "::coin::NATIVE", symbol: "NATIVE", name: "Native coin", decimals: 9, usd_price: "0.02", icon_url: null });
  const container = document.createElement("div"); container.setAttribute("data-blast-ui", ""); document.body.append(container);
  let root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  const render = (signedIn: boolean, restored = false) => withQueryClient(client, <SocialViewerProvider signedIn={signedIn} callsign={signedIn ? "kai" : null}>
    <CoinSheet open session={1} draftKey="coins:native-oauth" first={restored ? { kind: "trade", key: "usdc", out: "sui" } : { kind: "trade", key: "usdc", out: native.key, focus: native.key }}
      wallet={{ status: "ready", address: "0x" + "ab".repeat(32), fee: "sponsored", coins: PUBLIC_BASE_COINS }} extraCoins={restored ? [] : [native]}
      trading={{ signedIn, onSignIn: () => {}, requestQuote: async () => ({ status: "error" }), listCoins: async () => [], trade: async () => assert.fail("sign-in never sends a trade") }}
      onClose={() => {}} onCopy={() => {}} onRetry={() => {}} onWithdraw={async () => false} />
  </SocialViewerProvider>);
  await act(async () => root.render(render(false))); await settle();
  await type(container.querySelector("[data-coin-focus]"), "12.5");
  await act(async () => document.dispatchEvent(testEvent(SIGN_IN_DRAFT_EVENT)));
  await act(async () => root.unmount()); root = createRoot(container);
  await act(async () => root.render(render(true, true))); await settle();
  assert.equal(container.querySelector<HTMLInputElement>("[data-coin-focus]")?.value, "12.5");
  assert.ok(container.querySelector('[aria-label="Change receive token (NATIVE)"]'));
  assert.doesNotMatch(container.textContent!, /Presale purchases are unavailable/);
});
