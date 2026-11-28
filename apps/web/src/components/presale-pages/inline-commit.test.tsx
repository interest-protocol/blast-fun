import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import assert from "node:assert/strict";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import test, { mock, type TestContext } from "node:test";

import { installTestDom, setInputValue, TestElement } from "../../../test/fixtures/social/test-dom.ts";
import { fixtureQuote } from "../../../test/fixtures/social/coins/swap-fixture.ts";
import { walletCoinViews } from "#web/components/social/coins/coin-model.ts";
import { normalizeStructTag } from "@mysten/sui/utils";
import type { SocialTradeQuoteRequest } from "@blast/core/modules/social/contracts/trades.ts";
import { ACCESS_TOKEN, installWalletReads } from "../../../test/fixtures/social/commit/wallet-reads.ts";

/**
 * OA-43: an open sale's side box (the right column, ≥1220 px, where the shell
 * draws it) is the commit form itself — the gate's `panelHTML('commit', id,
 * null, true, 'side')` — not a "Blast in" button that opens the dialog.
 *
 * The form is the dialog's own `CommitPanel`, quoted and sent through the
 * commit host's kit (`CommitKit.quotes` / `CommitKit.send`, which is the
 * dialog's `blastWith`), so both entry points run one flow. These mount the
 * real side box over a kit that records what it is asked.
 */

const { document } = installTestDom();
// The panel puts the caret at the end of its prefilled amount (the gate's); this DOM has no selection to move.
Object.assign(TestElement.prototype, { setSelectionRange: () => undefined });

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SocialViewerProvider } = await import("#web/components/social/SignInGate.tsx");
const { coinView } = await import("#web/components/social/coins/coin-model.ts");
const { createCommitQuotes } = await import("#web/components/social/commit/commit-quote.ts");
const { commitSaleOf, commitViewerOf } = await import("#web/components/social/commit/commit-view.ts");
const { SideBox } = await import("./SaleAside");
const { FIXTURE_NOW, fixtureDetail, fixtureId, fixtureViewer } = await import("../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts");

type CommitKit = import("#web/components/social/commit/commit-kit.ts").CommitKit;
type CommitFacts = import("#web/components/social/commit/commit-kit.ts").CommitFacts;
type CommitSendResult = import("#web/components/social/commit/commit-kit.ts").CommitSendResult;
type Send = Readonly<{ facts: CommitFacts; input: unknown; options: Parameters<CommitKit["send"]>[2] }>;

const MRDN = fixtureId("mrdn");
const WALLET = {
  address: `0x${"ad".repeat(32)}`,
  signer: "privy",
  fee: "sponsored",
  coins: [
    { coin_type: "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC", symbol: "USDC", name: "USDC", decimals: 6, atoms: "860000000", usd_price: "1", value_usd: "860.00", icon_url: null, presale: null },
    { coin_type: SUI_COIN_TYPE, symbol: "SUI", name: "SUI", decimals: 9, atoms: "412380000000", usd_price: "3.42", value_usd: "1410.34", icon_url: null, presale: null },
  ],
  as_of_ms: FIXTURE_NOW,
} as const;

// The fixture sale is open at FIXTURE_NOW; the panel reads the time itself.
mock.method(Date, "now", () => FIXTURE_NOW);
// The panel reads its payment balance fresh from the wallet read, as in the app; the kit carries every other request.
const wallet = installWalletReads(WALLET.coins.map((coin) => coinView(coin as never)), WALLET.address);

/** A kit like the host's: its quotes read the sample sale (counted); its send records each call and answers `answer`. */
function recordingKit(answer: () => Promise<CommitSendResult>, allowlist: CommitFacts["viewer"]["allowlist"] = null) {
  const reads: string[] = [];
  const sends: Send[] = [];
  const fixture = fixtureDetail("mrdn");
  const detail = allowlist ? { ...fixture, presale: { ...fixture.presale, allowlisted: true } } : fixture;
  const quotes = createCommitQuotes<CommitFacts>({
    client: createTestQueryClient(),
    read: async (saleId) => {
      reads.push(saleId);
      const sale = commitSaleOf(detail, { suiUsd: 3.42 });
      const entry = fixtureViewer()[MRDN];
      const mine = { ...entry.mine!, claim_wallet_commitment_atoms: "100000000" };
      return {
        detail,
        sale,
        viewer: commitViewerOf({ wallet: WALLET as never, sale, entry: { ...entry, mine }, allowlist }),
        blockers: [],
        proof: null,
        wallet: WALLET as never,
      };
    },
  });
  const kit: CommitKit = {
    quotePayment: async () => assert.fail("unexpected swap quote"),
    signedIn: true,
    signIn: () => undefined,
    deposit: () => undefined,
    quotes,
    send: async (facts, input, options) => {
      sends.push({ facts, input, options });
      return answer();
    },
  };
  return { kit, reads, sends };
}

async function mount(t: TestContext, kit: CommitKit | null, options: Readonly<{ signedIn?: boolean; onCommitted?: () => void }> = {}) {
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const signedIn = options.signedIn ?? true;
  await act(async () =>
    root.render(
      <SocialViewerProvider callsign={signedIn ? "kaimoreno" : null} signedIn={signedIn} getAccessToken={signedIn ? ACCESS_TOKEN : undefined}>
        <SideBox detail={fixtureDetail("mrdn")} entry={fixtureViewer()[MRDN]} kit={kit} now={FIXTURE_NOW} onCommitted={options.onCommitted} />
      </SocialViewerProvider>,
    ),
  );
  await settle();
  t.after(async () => {
    await act(async () => root.unmount());
    container.parentNode?.removeChild(container);
  });
  return container;
}

async function settle(ms = 10) {
  await act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
}

const buttons = (root: TestElement) => [...root.querySelectorAll("button")] as unknown as TestElement[];
const button = (root: TestElement, label: RegExp) => buttons(root).find((element) => label.test(element.textContent ?? ""));
const primary = (root: TestElement) => root.querySelector<HTMLElement>('[data-kind="commit"] [data-ui-variant="primary"]') as TestElement | null;

test("OA-43: signed in under the commit host, the open sale's box is the dialog's commit panel, read through the kit", async (t) => {
  const { kit, reads } = recordingKit(async () => ({ status: "sent", digest: "d" }));
  const root = await mount(t, kit);
  const panel = root.querySelector<HTMLElement>('.side-box [data-inline-commit] [data-kind="commit"]');
  assert.ok(panel, "the commit panel is drawn in the side box");
  assert.equal(panel?.getAttribute("data-key"), MRDN);
  assert.equal(reads.length, 1, "one quote read on arrival");
  assert.equal(primary(root)?.textContent, "Enter an amount", "a fresh box is empty: no default amount to type into (#1012)");
  for (const label of ["You pay", "Why are you in?", "Estimated tokens", "if closed now", "Tokens unlock"]) assert.ok(root.textContent?.includes(label), label);
  assert.ok(root.textContent?.includes("You've committed 100 USDC"), "the viewer's position stays under it, in the sale's coin");
  assert.equal(button(root, /Blast in$/), undefined, "no Blast in button beside it");
  // In a column, not a sheet: the button sits in the panel, as the gate's.
  assert.equal(primary(root)?.parentNode, panel);
});

test("the presale page explains an exhausted wallet allocation before entering an amount", async (t) => {
  const { kit, sends } = recordingKit(async () => assert.fail("an exhausted allocation must never submit"), { on: true, cap: 100 });
  const root = await mount(t, kit);
  assert.equal(primary(root)?.textContent, "Wallet limit reached");
  assert.equal(primary(root)?.hasAttribute("disabled"), true);
  const status = root.querySelector(`[id="${primary(root)?.getAttribute("aria-describedby")}"]`);
  assert.equal(status?.textContent, "You’ve already committed your full allocation.");
  const panel = root.querySelector('[data-kind="commit"]');
  assert.equal(panel?.querySelector("input, textarea, [aria-label='Amount presets']"), null);
  assert.doesNotMatch(panel?.textContent ?? "", /Estimated tokens|Add a message/);
  assert.match(root.textContent ?? "", /You've committed 100 USDC/);
  await act(async () => primary(root)!.click());
  assert.equal(sends.length, 0);
});

test("OA-43: one write per press, through the kit's send (the dialog's blastWith), with the panel's own input", async (t) => {
  const network = t.mock.fn(async () => new Response(null, { status: 503 }));
  t.mock.method(globalThis, "fetch", wallet.wrap(network as typeof fetch));
  const previousWalletReads = wallet.state.reads.length;
  let release: (result: CommitSendResult) => void = () => undefined;
  const { kit, sends } = recordingKit(() => new Promise((resolve) => (release = resolve)));
  let committed = 0;
  const root = await mount(t, kit, { onCommitted: () => (committed += 1) });
  await act(async () => button(root, /^\$100$/)!.click());
  assert.equal(primary(root)?.textContent, "Blast $100");
  // Each press is its own event, as in a browser (React renders a discrete event's update before the next one).
  await act(async () => primary(root)!.click());
  await act(async () => primary(root)!.click());
  await act(async () => primary(root)!.click());
  assert.equal(sends.length, 1, "a second press while it runs writes nothing");
  assert.deepEqual(sends[0].input, { payWith: "USDC", pay: 100, usd: 100, quote: 100, quoteAtoms: "100000000", why: "" });
  assert.equal(sends[0].facts, kit.quotes.peek(MRDN).facts, "the facts the panel was drawn from");
  // The sale page credits the post a shared link came through (`?via=`), and names nobody: there is no post in hand.
  assert.deepEqual(sends[0].options?.source, { entryId: null, through: null });
  const onPhase = sends[0].options?.onPhase;
  assert.ok(onPhase, "the existing transaction phases reach the shared panel");
  assert.equal(primary(root)?.getAttribute("aria-busy"), "true");
  assert.equal(primary(root)?.textContent, "Preparing commitment");
  for (const [phase, label] of [["signing", "Confirm in your wallet"], ["executing", "Blasting"]] as const) {
    await act(async () => onPhase(phase));
    assert.equal(primary(root)?.textContent, label);
    assert.equal(root.querySelector('[role="status"]')?.textContent, label, "progress is announced");
    assert.equal(primary(root)?.getAttribute("disabled"), "", "the transaction stays locked through every phase");
  }
  await act(async () => release({ status: "sent", digest: "d" }));
  await settle();
  // Done: the gate draws a fresh, empty panel, and the page reads the position again.
  assert.equal(primary(root)?.textContent, "Enter an amount");
  assert.equal(root.querySelector('[role="status"]')?.textContent, "");
  assert.equal(committed, 1);
  assert.equal(network.mock.callCount(), 0, "the panel leaves network requests to the kit");
  assert.ok(wallet.state.reads.length - previousWalletReads <= 2, "the panel reads the wallet on open and after the commit, not a stream");
});

test("the coin the person picked stays picked after a commit lands: only the amount resets", async (t) => {
  // The pay leg's quote comes from the trade quote route; the sale is priced in USDC.
  t.mock.method(globalThis, "fetch", wallet.wrap((async (_url: string, init: RequestInit) => {
    const request = JSON.parse(String(init.body)) as SocialTradeQuoteRequest;
    const quote = fixtureQuote(request, walletCoinViews(WALLET as never), { quote: "ok", trade: "ok", signedIn: true, fee: "sponsored" }, Date.now());
    // The route answers in long-form coin types and a well-formed quote id.
    return Response.json({ ...quote, in_coin: normalizeStructTag(quote.in_coin), quote_id: "q1.fixture_sui_to_usdc" });
  }) as typeof fetch));
  const { kit, sends } = recordingKit(async () => ({ status: "sent", digest: "d" }));
  const root = await mount(t, kit);
  const trigger = () => root.querySelector<HTMLElement>('button[aria-label^="Pay with"]');
  await act(async () => trigger()!.click());
  await settle(80);
  const sui = [...document.querySelectorAll('[role="option"]')].find((option) => option.textContent?.includes("SUI")) as unknown as HTMLElement;
  await act(async () => sui.click());
  assert.equal(trigger()?.getAttribute("aria-label"), "Pay with SUI");
  assert.equal(trigger()?.textContent?.trim(), "SUI", "the field names the coin once: its symbol");
  const field = () => root.querySelector<HTMLInputElement>('[data-kind="commit"] input')!;
  await act(async () => { setInputValue(field() as unknown as HTMLElement, "10"); field().dispatchEvent(new (globalThis as unknown as { Event: typeof Event }).Event("input", { bubbles: true })); });
  await settle(350);
  assert.equal(primary(root)?.textContent, "Swap & contribute", root.textContent ?? "");
  await act(async () => primary(root)!.click());
  await settle();
  assert.equal(sends.length, 1);
  assert.equal(trigger()?.getAttribute("aria-label"), "Pay with SUI", "the fresh panel keeps SUI");
  assert.equal(field().value, "");
  assert.doesNotMatch(root.textContent ?? "", /Choose another coin|Enter an amount for a swap quote/);
});

test("a refusal stays in an announced error, with a stable action label and no position refresh", async (t) => {
  const { kit, sends } = recordingKit(async () => ({ status: "refused", message: "You didn’t confirm it. Nothing was sent." }));
  let committed = 0;
  const root = await mount(t, kit, { onCommitted: () => (committed += 1) });
  await act(async () => button(root, /^\$100$/)!.click());
  await act(async () => primary(root)!.click());
  await settle();
  assert.equal(sends.length, 1);
  assert.equal(primary(root)?.textContent, "Blast $100");
  assert.equal(root.querySelector('[role="alert"]')?.textContent, "You didn’t confirm it. Nothing was sent.");
  await settle(2_700);
  assert.equal(root.querySelector('[role="alert"]')?.textContent, "You didn’t confirm it. Nothing was sent.", "the error outlasts the former 2.6s timeout");
  assert.equal(committed, 0);
  // The blocked wall (no sentence) answers the panel's own fallback, as the dialog's does.
  const blocked = recordingKit(async () => ({ status: "refused", message: null }));
  const other = await mount(t, blocked.kit);
  await act(async () => button(other, /^\$100$/)!.click());
  await act(async () => primary(other)!.click());
  await settle();
  assert.equal(primary(other)?.textContent, "Blast $100");
  assert.equal(other.querySelector('[role="alert"]')?.textContent, "That didn’t go through. Nothing was sent. Code: request_refused.");
});

test("an unconfirmed transaction keeps wallet recovery instructions until a retry starts", async (t) => {
  let attempts = 0;
  let release: (result: CommitSendResult) => void = () => undefined;
  const { kit } = recordingKit(async () => {
    if (++attempts === 1) throw new Error("connection lost");
    return new Promise((resolve) => { release = resolve; });
  });
  const root = await mount(t, kit);
  await act(async () => button(root, /^\$100$/)!.click());
  await act(async () => primary(root)!.click());
  assert.equal(root.querySelector('[role="alert"]')?.textContent, "This commitment could not be confirmed. Check your wallet before retrying. Code: execution_unconfirmed.");
  assert.equal(primary(root)?.textContent, "Blast $100");
  await act(async () => primary(root)!.click());
  assert.equal(root.querySelector('[role="alert"]'), null);
  assert.equal(primary(root)?.textContent, "Preparing commitment");
  await act(async () => release({ status: "refused", message: "Your wallet could not sign it. Nothing was sent." }));
  assert.equal(root.querySelector('[role="alert"]')?.textContent, "Your wallet could not sign it. Nothing was sent.");
});

test("OA-43: a visitor gets the full commit form and public quote; no kit keeps the commitment button", async (t) => {
  const { kit, reads } = recordingKit(async () => ({ status: "sent", digest: "d" }));
  const visitor = await mount(t, kit, { signedIn: false });
  assert.ok(visitor.querySelector<HTMLElement>('[data-kind="commit"]'));
  assert.match(visitor.textContent ?? "", /Sign in to blast/);
  assert.equal(reads.length, 1, "the public sale is quoted");
  const none = await mount(t, null);
  assert.equal(none.querySelector<HTMLElement>('[data-kind="commit"]'), null);
  assert.ok(button(none, /^Commit USDC$/), "the page's own button, as before the host is mounted");
});
