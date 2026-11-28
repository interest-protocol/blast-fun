import assert from "node:assert/strict";
import test, { mock } from "node:test";

import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { installTestDom, recordAnimations, setInputValue, testEvent } from "../../../../test/fixtures/social/test-dom.ts";
import { ALON_ID, ALON_NOW, ALON_READ, TSUI } from "../../../../test/fixtures/social/commit/alon.ts";
import { ACCESS_TOKEN, WALLET_ADDRESS, WALLET_FACTS, installWalletReads, walletReads } from "../../../../test/fixtures/social/commit/wallet-reads.ts";
import { createCommitQuotes } from "./commit-quote";
import { fetchCommitSale } from "./commit-client";
import { commitSaleOf, commitViewerOf } from "./commit-view";
import type { CommitFacts, CommitKit } from "./commit-kit";
import { QueryRefusal } from "#web/lib/query/client.ts";

const dom = installTestDom();
const motion = recordAnimations();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { InlineCommit } = await import("./InlineCommit");
const { CommitPanel } = await import("./CommitPanel");
const { SocialViewerProvider } = await import("../SignInGate");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");

installWalletReads([TSUI]);
// The fixture sale is open at ALON_NOW; the panel reads the time itself.
mock.method(Date, "now", () => ALON_NOW);
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });

const factsOf = (detail = ALON_READ): CommitFacts => {
  const sale = commitSaleOf(detail, { suiUsd: null });
  return { detail, sale, viewer: { ...commitViewerOf({ sale, wallet: null, entry: null, allowlist: null }), quoteBalance: 50 }, wallet: WALLET_FACTS, blockers: [], proof: null };
};

async function typeAmount(container: HTMLElement, value: string) {
  const amount = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]');
  assert.ok(amount);
  await settle();
  await act(async () => { setInputValue(amount, value); amount.dispatchEvent(testEvent("input")); });
}

test("a delayed purchase read shows its supplied loading status, then the real form", async (t) => {
  const client = createTestQueryClient();
  const read = Promise.withResolvers<CommitFacts>();
  const quotes = createCommitQuotes<CommitFacts>({ client, read: () => read.promise });
  const kit: CommitKit = { quotes, quotePayment: async () => assert.fail("unexpected swap"), signedIn: false, signIn() {}, deposit() {}, send: async () => assert.fail("preview only") };
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); quotes.dispose(); client.clear(); container.remove(); });
  await act(async () => root.render(withQueryClient(client, <InlineCommit kit={kit} presaleId={ALON_ID} purchase={{}} fallback={<p role="status">Loading purchase details</p>} />)));
  assert.match(container.querySelector('[role="status"]')?.textContent ?? "", /Loading purchase details/);
  assert.equal(container.querySelector('input[inputmode="decimal"]'), null);
  assert.ok(container.querySelector('[aria-busy="true"]'));
  assert.equal(container.querySelector("button"), null, "loading must not impersonate an available purchase");
  await act(async () => { read.resolve(factsOf()); });
  assert.ok(container.querySelector('input[inputmode="decimal"]'));
  assert.equal(container.querySelector('[data-presale-state="loading"]'), null);
});

test("compact details and message modals preserve the form, draft, and purchase consequences", async (t) => {
  const client = createTestQueryClient();
  const container = dom.document.createElement("div"); container.setAttribute("data-blast-ui", ""); dom.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(withQueryClient(client, <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}><CommitPanel sale={factsOf().sale!} walletAddress={WALLET_ADDRESS} viewer={factsOf().viewer} blockers={[]} nowMs={ALON_NOW} onBlast={async () => ({ ok: true })} onDeposit={() => undefined} inline purchase compact draft={{ coinType: TSUI.coinType, amount: "10.000000001", why: "" }} /></SocialViewerProvider>)));
  const amount = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  const heading = container.querySelector(".allocationHeading")!;
  const estimate = heading.textContent;
  assert.equal(container.querySelector("details"), null, "optional content cannot expand the carousel");
  assert.match(container.querySelector(".purchaseBody")!.textContent!, /Unallocated payment is refunded at claim/);
  const buttons = [...container.querySelectorAll<HTMLButtonElement>('[aria-haspopup="dialog"]:not([aria-label^="Pay with"])')];
  const open = async (button: HTMLButtonElement) => act(async () => { button.focus(); button.click(); });
  const close = async () => {
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
    await act(async () => motion.finishAll());
  };
  await open(buttons[0]);
  assert.match(container.querySelector('[role="dialog"]')!.textContent!, /Allocation details.*Payment allocated.*Tokens unlock.*Presale details/s);
  await close();
  assert.ok(dom.document.activeElement === buttons[0], "focus returns to Allocation details");
  await open(buttons[1]);
  const message = container.querySelector<HTMLTextAreaElement>("textarea")!;
  assert.ok(dom.document.activeElement === message, "message field takes focus");
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(message, "Still composing");
    message.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  await close();
  assert.match(buttons[1].textContent!, /Edit message/);
  for (let round = 0; round < 2; round++) {
    await open(buttons[0]); await close();
    assert.ok(container.querySelector('input[inputmode="decimal"]') === amount, "amount input remains mounted");
    assert.equal(amount.value, "10.000000001");
    assert.equal(heading.textContent, estimate);
    assert.ok(container.querySelector('[aria-label="Pay with TSUI"]'));
    await open(buttons[1]);
    assert.equal(container.querySelector<HTMLTextAreaElement>("textarea")!.value, "Still composing");
    await close();
  }
  await open(buttons[1]);
  await act(async () => {
    const field = container.querySelector<HTMLTextAreaElement>("textarea")!;
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "value")!.set!.call(field, "https://example.com");
    field.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  assert.equal(container.querySelector("textarea")!.getAttribute("aria-invalid"), "true");
  assert.equal(container.querySelector<HTMLButtonElement>('[data-ui-variant="primary"]')!.disabled, true);
});

test("ALON with nullable USD valuations and TSUI 10 reaches an actionable exact-atom payment form", async (t) => {
  const client = createTestQueryClient();
  const sent: Parameters<CommitKit["send"]>[1][] = [];
  const quotes = createCommitQuotes<CommitFacts>({ client, read: async () => factsOf() });
  const kit: CommitKit = { quotes, quotePayment: async () => assert.fail("unexpected swap quote"), signedIn: true, signIn: () => undefined, deposit: () => undefined,
    send: async (_facts, input) => { sent.push(input); return { status: "sent", digest: "mock" }; } };
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); quotes.dispose(); client.clear(); container.remove(); });
  await act(async () => root.render(withQueryClient(client, <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}>
    <InlineCommit kit={kit} presaleId={ALON_ID} purchase={{ initialPayCoin: TSUI.coinType }} fallback={<p>Loading presale terms…</p>} />
  </SocialViewerProvider>)));
  await typeAmount(container, "10.000000001");
  const amount = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]');
  assert.equal(amount?.value, "10.000000001");
  const buy = container.querySelector<HTMLButtonElement>('[data-ui-variant="primary"]');
  assert.ok(buy && !buy.disabled);
  assert.doesNotMatch(container.textContent!, /Loading presale terms|USDC|\$/);
  await act(async () => buy.click());
  assert.equal(sent[0]?.payWith, "TSUI");
  assert.equal(sent[0]?.quoteAtoms, "10000000001");
  assert.equal(sent[0]?.swapQuoteId, undefined);
});

test("closed, missing, unpriced terms and failed reads resolve to explicit recoverable states", async (t) => {
  const cases = [
    { read: async () => factsOf({ ...ALON_READ, presale: { ...ALON_READ.presale, phase: "cancelled" } }), state: "unavailable", text: /not open/ },
    { read: async () => factsOf({ ...ALON_READ, terms: null }), state: "unavailable", text: /terms are unavailable/ },
    { read: async () => factsOf({ ...ALON_READ, terms: { ...ALON_READ.terms!, presale_price_quote: null } }), state: "unavailable", text: /pricing terms are unavailable/ },
    { read: async (): Promise<CommitFacts> => { throw new QueryRefusal("not_found"); }, state: "unavailable", text: /no longer available/ },
    { read: (): Promise<CommitFacts> => new Promise(() => {}), state: "error", text: /too long/ },
    { read: async (): Promise<CommitFacts> => { throw new Error("offline"); }, state: "error", text: /could not load/ },
  ];
  for (const scenario of cases) await t.test(scenario.state + String(scenario.text), async (sub) => {
    sub.mock.timers.enable({ apis: ["setTimeout"] });
    const client = createTestQueryClient();
    const quotes = createCommitQuotes<CommitFacts>({ client, read: scenario.read });
    const kit: CommitKit = { quotes, quotePayment: async () => assert.fail("unexpected swap quote"), signedIn: true, signIn: () => undefined, deposit: () => undefined, send: async () => assert.fail("unavailable sales cannot be sent") };
    const container = dom.document.createElement("div"); dom.document.body.append(container);
    const root = createRoot(container);
    sub.after(async () => { await act(async () => root.unmount()); quotes.dispose(); client.clear(); container.remove(); });
    await act(async () => root.render(withQueryClient(client, <InlineCommit kit={kit} presaleId={ALON_ID} purchase={{}} fallback={<p>Loading presale terms…</p>} />)));
    await act(async () => { sub.mock.timers.tick(15_000); });
    assert.ok(container.querySelector(`[data-presale-state="${scenario.state}"]`));
    assert.match(container.textContent!, scenario.text);
    assert.doesNotMatch(container.textContent!, /Loading presale terms/);
    assert.equal(container.querySelector('input[inputmode="decimal"]'), null);
    assert.match(container.textContent!, /Retry/);
    assert.equal(container.querySelector<HTMLButtonElement>(".purchaseFooter button")?.disabled, true);
  });
});

test("a late response for an earlier selection cannot display that presale or its payment amount", async (t) => {
  const client = createTestQueryClient();
  const late = Promise.withResolvers<CommitFacts>();
  const newer = { ...ALON_READ, presale: { ...ALON_READ.presale, presale_id: `0x${"ff".repeat(32)}`, name: "Next", symbol: "NEXT" } };
  const quotes = createCommitQuotes<CommitFacts>({ client, read: (id) => id === ALON_ID ? late.promise : Promise.resolve(factsOf(newer)) });
  const kit: CommitKit = { quotes, quotePayment: async () => assert.fail("unexpected swap quote"), signedIn: true, signIn: () => undefined, deposit: () => undefined, send: async () => ({ status: "sent", digest: "mock" }) };
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); quotes.dispose(); client.clear(); container.remove(); });
  const render = (id: string) => withQueryClient(client, <InlineCommit kit={kit} presaleId={id} purchase={{ initialPayCoin: TSUI.coinType }} fallback={<p>Loading presale terms…</p>} />);
  await act(async () => root.render(render(ALON_ID)));
  assert.ok(container.querySelector('[aria-busy="true"]'));
  await act(async () => root.render(render(newer.presale.presale_id)));
  await act(async () => { late.resolve(factsOf()); });
  assert.equal(container.querySelector('[data-kind="commit"]')?.getAttribute("data-key"), newer.presale.presale_id);
  assert.doesNotMatch(container.textContent!, /ALON|Loading presale terms/);
});

test("a completed malformed HTTP 200 sale read leaves loading and can be retried", async (t) => {
  let valid = false;
  const client = createTestQueryClient();
  const quotes = createCommitQuotes<CommitFacts>({ client, read: async (id) => {
    const result = await fetchCommitSale({ getAccessToken: async () => null, fetch: async () => Response.json(valid ? ALON_READ : { presale: {} }) }, id);
    if (result.status !== "ok") return null;
    const sale = commitSaleOf(result.body, { suiUsd: null });
    return { detail: result.body, sale, viewer: { ...commitViewerOf({ sale, wallet: null, entry: null, allowlist: null }), quoteBalance: 50 }, wallet: WALLET_FACTS, blockers: [], proof: null };
  } });
  const kit: CommitKit = { quotes, quotePayment: async () => assert.fail("unexpected swap quote"), signedIn: true, signIn: () => undefined, deposit: () => undefined, send: async () => ({ status: "sent", digest: "mock" }) };
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); quotes.dispose(); client.clear(); container.remove(); });
  await act(async () => root.render(withQueryClient(client, <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}>
    <InlineCommit kit={kit} presaleId={ALON_ID} purchase={{ initialPayCoin: TSUI.coinType }} fallback={<p>Loading presale terms…</p>} />
  </SocialViewerProvider>)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.equal(quotes.peek(ALON_ID).failed, true);
  assert.doesNotMatch(container.textContent!, /Loading presale terms/);
  assert.match(container.textContent!, /could not|couldn’t/i);
  const retry = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Retry");
  assert.ok(retry);
  valid = true;
  await act(async () => { retry.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
  assert.ok(container.querySelector('input[inputmode="decimal"]'));
  assert.match(container.textContent!, /TSUI/);
  assert.doesNotMatch(container.textContent!, /Loading presale terms|USDC/);
});

test("an unavailable restored payment stays selected with its amount until the user chooses another coin", async (t) => {
  const client = createTestQueryClient();
  const sui = { ...TSUI, key: SUI_COIN_TYPE, coinType: SUI_COIN_TYPE, symbol: "SUI", name: "Sui" };
  const detail = { ...ALON_READ, presale: { ...ALON_READ.presale, quote_type: sui.coinType, quote_symbol: sui.symbol } };
  const quotes = createCommitQuotes<CommitFacts>({ client, read: async () => factsOf(detail) });
  const kit: CommitKit = { quotes, quotePayment: async () => assert.fail("unexpected swap quote"), signedIn: true, signIn: () => undefined, deposit: () => undefined, send: async () => assert.fail("no amount") };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = walletReads([sui]).wrap(originalFetch);
  t.after(() => { globalThis.fetch = originalFetch; });
  const container = dom.document.createElement("div"); container.setAttribute("data-blast-ui", ""); dom.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); quotes.dispose(); client.clear(); container.remove(); });
  await act(async () => root.render(withQueryClient(client, <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}>
    <InlineCommit kit={kit} presaleId={ALON_ID} purchase={{ initialPayCoin: `0x${"a".repeat(64)}::wal::WAL`, draft: { coinType: `0x${"a".repeat(64)}::wal::WAL`, amount: "10", why: "" } }} fallback={<p>Loading presale terms…</p>} />
  </SocialViewerProvider>)));
  assert.equal(container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value, "10");
  assert.equal(container.querySelector("select"), null);
  assert.ok(container.querySelector('[aria-label="Pay with WAL"]'));
  assert.match(container.textContent!, /Payment coin unavailable.*Choose another coin/);
  assert.equal(container.querySelector<HTMLButtonElement>('[data-ui-variant="primary"]')?.disabled, true);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Pay with WAL"]')!.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
  const direct = [...container.querySelectorAll<HTMLElement>('[aria-label="Quick choices"] button')].find(option => option.textContent === sui.symbol);
  assert.ok(direct);
  await act(async () => direct.click());
  await act(async () => motion.finishAll());
  assert.equal(container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value, "", "an explicit token change requires an amount in the new units");
  const preset = [...container.querySelectorAll("button")].find(button => button.textContent === "25")!;
  await act(async () => preset.click());
  assert.equal(container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value, "25");
  assert.doesNotMatch(container.textContent!, /Payment coin unavailable|enter an amount/);
  assert.equal(container.querySelector<HTMLButtonElement>('[data-ui-variant="primary"]')?.disabled, false);
});

test("Buy keeps untouched estimates empty, discloses its terms, and sends exact atoms with an explicit action", async (t) => {
  const client = createTestQueryClient();
  const quotes = createCommitQuotes<CommitFacts>({ client, read: async () => factsOf() });
  const sent: Parameters<CommitKit["send"]>[1][] = [];
  const kit: CommitKit = { quotes, quotePayment: async () => assert.fail("unexpected swap quote"), signedIn: true, signIn: () => undefined, deposit: () => undefined,
    send: async (_facts, input) => { sent.push(input); return { status: "sent", digest: "mock" }; } };
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); quotes.dispose(); client.clear(); container.remove(); });
  await act(async () => root.render(withQueryClient(client, <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}>
    <InlineCommit kit={kit} presaleId={ALON_ID} purchase={{ initialPayCoin: TSUI.coinType }} fallback={<p>Loading presale terms…</p>} />
  </SocialViewerProvider>)));
  assert.match(container.textContent!, /Enter an amount to see your estimate/);
  assert.doesNotMatch(container.textContent!, /≈ 0 ALON|<0.01%|100% at current funding/);
  const disclosures = [...container.querySelectorAll("details")];
  assert.equal(disclosures.length, 2);
  assert.ok(disclosures.every((details) => !details.open));
  assert.match(disclosures[0]!.textContent!, /Unused payment is refunded.*target is missed/s);
  const amount = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(amount, "10.000000001");
    amount.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  const buy = container.querySelector<HTMLButtonElement>('[data-ui-variant="primary"]')!;
  assert.equal(buy.textContent, "Buy allocation · 10.000000001 TSUI");
  assert.equal(buy.disabled, false);
  assert.match(container.querySelector(".allocation")!.textContent!, /≈ 90,000 ALON.*100% at current funding/s);
  assert.ok(container.querySelector(".purchaseFooter")!.contains(buy));
  await act(async () => buy.click());
  assert.equal(sent[0]?.quoteAtoms, "10000000001");
});

test("a purchase hands its receipt only to its still-visible submitting surface", async (t) => {
  const client = createTestQueryClient();
  const quotes = createCommitQuotes<CommitFacts>({ client, read: async () => factsOf() });
  let confirm: NonNullable<Parameters<CommitKit["send"]>[2]>["onConfirmed"];
  let received = 0;
  const pending = Promise.withResolvers<Awaited<ReturnType<CommitKit["send"]>>>();
  const kit: CommitKit = { quotes, quotePayment: async () => assert.fail("unexpected swap quote"), signedIn: true, signIn() {}, deposit() {}, send: (_facts, _input, options) => { confirm = options?.onConfirmed; return pending.promise; } };
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); quotes.dispose(); client.clear(); });
  const render = (active: boolean) => withQueryClient(client, <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}>
    <InlineCommit purchase={{ active, onConfirmed: () => { received++; }, initialPayCoin: TSUI.coinType }} kit={kit} presaleId={ALON_ID}
      fallback={<p>Loading</p>} />
  </SocialViewerProvider>);
  await act(async () => root.render(render(true)));
  await typeAmount(container, "10");
  await act(async () => container.querySelector<HTMLButtonElement>('[data-ui-variant="primary"]')!.click());
  assert.ok(confirm);
  const receipt = { presaleId: ALON_ID, symbol: "ALON", amount: "10", currency: "TSUI", digest: "mock", href: null };
  await act(async () => { confirm!(receipt); });
  assert.equal(received, 1);
  await act(async () => root.render(render(false)));
  confirm(receipt);
  assert.equal(received, 1, "closing the sheet during signing leaves confirmation to the host toast");
  await act(async () => root.render(<p>Another purchase</p>));
  confirm(receipt);
  assert.equal(received, 1, "an unmounted form cannot overwrite its replacement");
  await act(async () => { pending.resolve({ status: "sent", digest: "mock" }); });
});

test("a loaded wallet can choose other payment coins without a wallet listing", async (t) => {
  const client = createTestQueryClient();
  const quotes = createCommitQuotes<CommitFacts>({ client, read: async () => ({ ...factsOf(), wallet: {
    address: `0x${"aa".repeat(32)}`, signer: "privy", fee: "sponsored", coins: null, as_of_ms: ALON_NOW,
  } }) });
  const kit: CommitKit = { quotes, quotePayment: async () => assert.fail("unexpected swap quote"), signedIn: true, signIn: () => undefined, deposit: () => undefined, send: async () => assert.fail("preview only") };
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); quotes.dispose(); client.clear(); container.remove(); });
  await act(async () => root.render(withQueryClient(client, <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}>
    <InlineCommit kit={kit} presaleId={ALON_ID} purchase={{}} fallback={<p>Loading presale terms…</p>} />
  </SocialViewerProvider>)));
  assert.equal(container.querySelector("select"), null);
  assert.ok(container.querySelector('button[aria-label^="Pay with"]'));
  assert.doesNotMatch(container.textContent!, /Coins unavailable/);
  assert.doesNotMatch(container.textContent!, /check a swap route|Pay directly/);
});

test("the buy box closes within a second of the sale's end, with no clock from the page around it", async (t) => {
  let now = ALON_NOW;
  t.mock.method(Date, "now", () => now);
  t.mock.timers.enable({ apis: ["setInterval"] });
  const client = createTestQueryClient();
  const ending = { ...ALON_READ, presale: { ...ALON_READ.presale, end_ms: ALON_NOW + 1_500 } };
  const quotes = createCommitQuotes<CommitFacts>({ client, read: async () => factsOf(ending) });
  const kit: CommitKit = { quotes, quotePayment: async () => assert.fail("unexpected swap"), signedIn: false, signIn() {}, deposit() {}, send: async () => assert.fail("preview only") };
  const container = dom.document.createElement("div"); container.setAttribute("data-blast-ui", ""); dom.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); quotes.dispose(); client.clear(); container.remove(); });
  await act(async () => root.render(withQueryClient(client, <InlineCommit kit={kit} presaleId={ALON_ID} purchase={{}} fallback={<p>Loading presale terms…</p>} />)));
  await settle();
  const pass = (ms: number) => act(async () => { now += ms; t.mock.timers.tick(ms); });
  await pass(1_000);
  assert.ok(container.querySelector('input[inputmode="decimal"]'), "still open half a second before the end");
  await pass(1_000);
  assert.ok(!container.querySelector('input[inputmode="decimal"]'), "closed half a second after the end");
  assert.match(container.textContent!, /This presale is not open for purchases\./);
});
