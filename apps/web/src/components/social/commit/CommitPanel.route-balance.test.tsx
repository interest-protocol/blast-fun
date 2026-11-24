import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { installTestDom, setInputValue, waitFor } from "../../../../test/fixtures/social/test-dom.ts";
import { FIXTURE_COINS } from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";
import { fixtureQuote } from "../../../../test/fixtures/social/coins/swap-fixture.ts";
import { KAI, STORY_NOW, TIDE } from "../../../../test/fixtures/social/commit/commit-fixtures.ts";
import { ACCESS_TOKEN, WALLET_ADDRESS, walletReads } from "../../../../test/fixtures/social/commit/wallet-reads.ts";
import type { SocialTradeQuoteRequest } from "@blast/core/modules/social/contracts/trades.ts";

/**
 * The You pay panel's route states and its balance: the route message follows the latest quote for the
 * current coin and amount, a confirmed no-route answer is the only one that says there is no route, and one
 * fresh spendable balance (keyed by wallet, network and coin) feeds the label, Max and the checks.
 */
const dom = installTestDom();
Object.assign(dom.document, { oninput: null });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { invalidateAfter } = await import("#web/lib/query/invalidate.ts");
const { queryKeys } = await import("#web/lib/query/keys.ts");
const { SocialViewerProvider } = await import("../SignInGate");
const { CommitPanel } = await import("./CommitPanel");

const WAL = { ...FIXTURE_COINS[1]!, key: "wal", coinType: `0x${"a".repeat(64)}::wal::WAL`, symbol: "WAL", name: "Walrus", price: 2, atoms: 100_000_000_000n };
const OTHER_WALLET = `0x${"be".repeat(32)}`;
// Lets answers already on their way land (a macrotask turn each), for the checks that something did not change.
const flush = async () => { for (let turn = 0; turn < 3; turn++) await act(async () => new Promise<void>((resolve) => setImmediate(resolve))); };

type Answer = (request: SocialTradeQuoteRequest) => Promise<Response> | Response;

/** A panel paying with WAL for the sample USDC sale: `answer` serves the swap quotes, `reads` the wallet. */
async function mount(t: TestContext, answer: Answer, held = [WAL]) {
  const originalFetch = globalThis.fetch;
  const wallet = walletReads(held);
  const asked: SocialTradeQuoteRequest[] = [];
  globalThis.fetch = wallet.wrap(async (url, init) => {
    if (String(url) !== "/api/social/trades/quote") return Response.json({}, { status: 503 });
    const request = JSON.parse(String(init?.body)) as SocialTradeQuoteRequest;
    asked.push(request);
    return answer(request);
  });
  const container = dom.document.createElement("div"); container.setAttribute("data-blast-ui", ""); dom.document.body.append(container);
  const root = createRoot(container);
  const client = createTestQueryClient();
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); globalThis.fetch = originalFetch; });
  const render = (address: string | null, walletCoinsState: "loading" | "ready" = "ready") => act(async () => root.render(withQueryClient(client, <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}>
    <CommitPanel sale={TIDE} viewer={{ ...KAI, usdc: 0 }} walletCoins={[WAL]} walletCoinsState={walletCoinsState} walletAddress={address} walletFee="sponsored" blockers={[]} nowMs={STORY_NOW} onBlast={async () => ({ ok: true })} onDeposit={() => assert.fail("a routed purchase must not open a deposit")} inline />
  </SocialViewerProvider>)));
  await render(WALLET_ADDRESS);
  const field = () => container.querySelector<HTMLInputElement>("input")!;
  const buy = () => container.querySelector<HTMLButtonElement>('[data-ui-variant="primary"]')!;
  const type = (value: string) => act(async () => { setInputValue(field(), value); field().dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  const text = () => container.textContent ?? "";
  const retry = () => [...container.querySelectorAll("button")].find((button) => /^(Try again|Refresh quote)$/.test(button.textContent ?? ""));
  const cached = () => client.getQueryCache().findAll({ queryKey: queryKeys.me.wallet() }).map((entry) => entry.state.data as { atoms: bigint } | undefined).find((data) => data?.atoms !== undefined)?.atoms;
  const max = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Max")!;
  // Marks the wallet reads stale and waits until the read they trigger has landed.
  const reread = async () => {
    const before = wallet.state.reads.length;
    await client.invalidateQueries({ queryKey: queryKeys.me.wallet() });
    await waitFor(() => wallet.state.reads.length > before && client.isFetching() === 0, "the balance read landed");
  };
  // Pay with WAL through the shared picker.
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="Pay with"]')!.click());
  const option = await waitFor(() => [...dom.document.querySelectorAll<HTMLElement>('[role="option"]')].find((each) => each.textContent?.includes("WAL")), "the picker lists WAL");
  await act(async () => option.click());
  await waitFor(() => container.querySelector('button[aria-label="Pay with WAL"]'), "WAL is the payment coin");
  await waitFor(() => !max().disabled, "the balance read landed");
  return { wallet, client, asked, cached, render, field, buy, type, text, retry, max, reread };
}

const ok = (request: SocialTradeQuoteRequest) => Response.json(fixtureQuote(request, [FIXTURE_COINS[0]!, WAL], { quote: "ok", trade: "ok", signedIn: true, fee: "sponsored" }, Date.now()));

test("a route shows the estimate and the swap action, and never says there is no route", async (t) => {
  const panel = await mount(t, ok);
  await panel.type("6");
  assert.doesNotMatch(panel.text(), /No route/, "typing alone is not a refusal");
  assert.match(panel.text(), /Checking swap route|Finding a route/i);
  await waitFor(() => panel.buy().textContent === "Swap & contribute", "the route answered");
  assert.match(panel.text(), /You contribute/);
  assert.equal(panel.buy().textContent, "Swap & contribute");
  assert.equal(panel.buy().disabled, false);
  assert.doesNotMatch(panel.text(), /No route/, "a valid route never says there is no route");
});

test("only a confirmed no-route answer says there is no route", async (t) => {
  const panel = await mount(t, (request) => Response.json(fixtureQuote(request, [WAL], { quote: "unavailable", trade: "ok", signedIn: true, fee: "sponsored" }, Date.now())));
  await panel.type("6");
  await waitFor(() => /No route from WAL to USDC/.test(panel.text()), "the quote service said there is no route");
  assert.equal(panel.buy().disabled, true);
});

test("a timeout or an error is retryable and never claims there is no route", async (t) => {
  let healthy = false;
  const panel = await mount(t, (request) => healthy ? ok(request) : Response.json({}, { status: 503 }));
  await panel.type("6");
  await waitFor(panel.retry, "the error offers a retry");
  assert.doesNotMatch(panel.text(), /No route/, "an error is not a confirmed no-route");
  assert.equal(panel.buy().disabled, true);
  healthy = true;
  await act(async () => panel.retry()!.click());
  await waitFor(() => panel.buy().textContent === "Swap & contribute", "the retry found the route");
  assert.equal(panel.retry(), undefined);
  assert.equal(panel.buy().textContent, "Swap & contribute");
  assert.equal(panel.buy().disabled, false);
});

test("a route with too little balance keeps the quote and says Insufficient balance", async (t) => {
  const panel = await mount(t, ok, [{ ...WAL, atoms: 1_000_000_000n }]);
  await panel.type("25");
  await waitFor(() => /You contribute 49.75 USDC/.test(panel.text()), "the route answered");
  assert.equal(panel.buy().textContent, "Insufficient balance");
  assert.match(panel.text(), /You contribute 49.75 USDC/, "the quote stays");
  assert.equal(panel.buy().disabled, true);
  assert.doesNotMatch(panel.text(), /No route/, "a quote exists, so the route is not the problem");
});

test("a late quote for an older amount never answers the newer one", async (t) => {
  let release: () => void = () => undefined;
  let answered = false;
  const first = new Promise<void>((resolve) => { release = resolve; });
  const asked: string[] = [];
  const panel = await mount(t, async (request) => {
    asked.push(String(request.amount_in));
    if (request.amount_in === "25000000000") { await first; answered = true; }
    return ok(request);
  });
  await panel.type("25");
  await waitFor(() => asked.includes("25000000000"), "the first amount was asked");
  await panel.type("30");
  await waitFor(() => /You contribute 59.7 USDC/.test(panel.text()), "the newer amount answered");
  release();
  await waitFor(() => answered, "the older answer arrived");
  await flush();
  assert.match(panel.text(), /You contribute 59.7 USDC/, "the answer for 25 was discarded");
  assert.doesNotMatch(panel.text(), /49.75/);
  assert.equal(panel.buy().disabled, false);
});

test("a balance that moves while the panel is open reaches Max and the checks without a reload", async (t) => {
  const panel = await mount(t, ok);
  await act(async () => panel.max().click());
  assert.equal(panel.field().value, "100");
  panel.wallet.state.coins = [{ ...WAL, atoms: 10_000_000_000n }];
  await panel.reread();
  await waitFor(() => /Balance 10 WAL/.test(panel.text()), "the label shows the moved balance");
  await act(async () => panel.max().click());
  assert.equal(panel.field().value, "10", "Max follows the fresh spendable balance");
  await panel.type("25");
  await waitFor(() => panel.buy().textContent === "Insufficient balance", "the moved balance is checked");
});

test("an older read never replaces a newer balance", async (t) => {
  const panel = await mount(t, ok);
  panel.wallet.state.coins = [{ ...WAL, atoms: 10_000_000_000n }];
  panel.wallet.state.asOfMs = 0;
  await panel.reread();
  await flush();
  assert.equal(panel.cached(), 100_000_000_000n, "the read from before the one shown is dropped");
  await act(async () => panel.max().click());
  assert.equal(panel.field().value, "100");
});

test("switching wallets never shows the previous wallet's balance", async (t) => {
  const panel = await mount(t, ok);
  await act(async () => panel.max().click());
  assert.equal(panel.field().value, "100");
  let release: () => void = () => undefined;
  panel.wallet.state.hold = new Promise<void>((resolve) => { release = resolve; });
  panel.wallet.state.address = OTHER_WALLET;
  panel.wallet.state.coins = [{ ...WAL, atoms: 3_000_000_000n }];
  await panel.render(OTHER_WALLET);
  assert.ok(panel.max().disabled, "no Max while the new wallet's balance is unknown");
  assert.equal(panel.buy().disabled, true);
  assert.doesNotMatch(panel.text(), /100 WAL/);
  panel.wallet.state.hold = null;
  release();
  await waitFor(() => !panel.max().disabled, "the new wallet's balance arrived");
  await act(async () => panel.max().click());
  assert.equal(panel.field().value, "3");
});

test("an unreadable balance disables balance-dependent actions and says so", async (t) => {
  const panel = await mount(t, ok);
  panel.wallet.state.fail = true;
  await panel.reread();
  await waitFor(() => /Balance unavailable/.test(panel.text()), "the unreadable balance is shown");
  assert.ok(panel.max().disabled);
  assert.equal(panel.buy().disabled, true);
});

test("while the wallet address is still being read the balance is loading, not unavailable", async (t) => {
  const panel = await mount(t, ok);
  await panel.render(null, "loading");
  assert.doesNotMatch(panel.text(), /Balance unavailable/);
  assert.ok(panel.max().disabled);
  assert.equal(panel.buy().disabled, true);
  await panel.render(WALLET_ADDRESS);
  await waitFor(() => !panel.max().disabled, "the balance read landed");
});

test("a failed balance read offers Try again, and the retry restores the balance", async (t) => {
  const panel = await mount(t, ok);
  panel.wallet.state.fail = true;
  await panel.reread();
  const again = () => [...dom.document.querySelectorAll("button")].find((button) => button.textContent === "Try again");
  await waitFor(again, "the unreadable balance offers a retry");
  panel.wallet.state.fail = false;
  await act(async () => again()!.click());
  await waitFor(() => !panel.max().disabled && /Balance 100 WAL/.test(panel.text()), "the retry read the balance");
});

test("a read already on its way when a confirm lands is read again", async (t) => {
  const panel = await mount(t, ok);
  const client = panel.client;
  let release: () => void = () => undefined;
  panel.wallet.state.hold = new Promise<void>((resolve) => { release = resolve; });
  const before = panel.wallet.state.reads.length;
  void client.refetchQueries({ queryKey: queryKeys.me.wallet(), type: "active" });
  await waitFor(() => panel.wallet.state.reads.length > before, "a read is on its way");
  // The confirm joins that read (cancelRefetch: false), and the wallet moves before it answers.
  void client.invalidateQueries({ queryKey: queryKeys.me.wallet() }, { cancelRefetch: false });
  panel.wallet.state.coins = [{ ...WAL, atoms: 10_000_000_000n }];
  panel.wallet.state.hold = null;
  release();
  await waitFor(() => /Balance 10 WAL/.test(panel.text()), "the balance after the confirm is shown");
  assert.ok(panel.wallet.state.reads.length >= before + 2, "the joined read was repeated");
});

test("a second confirmed action overtakes an already invalidated balance read", async (t) => {
  const { wallet, client, text } = await mount(t, ok);
  const first = Promise.withResolvers<void>();
  wallet.state.hold = first.promise;
  const before = wallet.state.reads.length;
  const refresh = invalidateAfter(client, { kind: "trade" });
  await waitFor(() => wallet.state.reads.length > before, "the first confirm started a read");
  const overlap = invalidateAfter(client, { kind: "balances" });
  wallet.state.coins = [{ ...WAL, atoms: 10_000_000_000n }];
  wallet.state.hold = null;
  first.resolve();
  await Promise.all([refresh, overlap]);
  await waitFor(() => /Balance 10 WAL/.test(text()), "the newest balance is shown");
  assert.equal(wallet.state.reads.length, before + 2);
  await invalidateAfter(client, { kind: "wallet-stale" });
  assert.equal(wallet.state.reads.length, before + 2, "an idle holdings hint does not read the payment coin");
  assert.match(text(), /Balance 10 WAL/);
});

test("a window focus after the balance went stale reads it again", async (t) => {
  const panel = await mount(t, ok);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  panel.wallet.state.coins = [{ ...WAL, atoms: 10_000_000_000n }];
  t.mock.timers.tick(6_000);
  let release: () => void = () => undefined;
  panel.wallet.state.hold = new Promise<void>((resolve) => { release = resolve; });
  await act(async () => { dom.window.dispatchEvent(new dom.window.Event("focus")); });
  await waitFor(() => panel.max().disabled, "an out-of-date balance is not a fact while it is read again");
  assert.equal(panel.buy().disabled, true);
  assert.doesNotMatch(panel.text(), /Balance 100 WAL/);
  panel.wallet.state.hold = null;
  release();
  await waitFor(() => /Balance 10 WAL/.test(panel.text()) && !panel.max().disabled, "the focus read the moved balance");
});
