import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { queryKeys } from "#web/lib/query/keys.ts";
import { SocialViewerProvider } from "#web/components/social/SignInGate.tsx";
import { walletCoinViews } from "#web/components/social/coins/coin-model.ts";
import { ACCESS_TOKEN, walletReads } from "../../../../../../test/fixtures/social/commit/wallet-reads.ts";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";
import { createWorkspaceStore } from "../model";
import { CoinPanel, type CoinPanelProps } from "./CoinPanel";
import { PresalePanel, type PresalePanelProps } from "./PresalePanel";
import { createCommitQuotes } from "#web/components/social/commit/commit-quote.ts";
import { presaleAsset, presaleDetail, presaleFacts } from "../../../../../../test/fixtures/workspace/presale-fixtures.ts";
import { fixtureTradeQuote, fixtureWallet, fixtureCoinType } from "../../../../../../test/fixtures/social/trade/trade-fixtures.ts";

test("returning to a coin waits for an invalidated exact wallet balance and a new executable quote before enabling Buy", async (t) => {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', { url: "https://blast.test" });
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("mount")!);
  const client = createTestQueryClient();
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", chain: "sui", network: "mainnet", coin_type: fixtureCoinType("KSTL"), presale_id: null });
  const original = store.getSnapshot().panels.A!;
  const setup = { ...original.coin, trade: { ...original.coin.trade, buy: { typed: "100", mode: "typed" as const } } };
  const wallet = fixtureWallet();
  assert.ok(wallet.address);
  const route = walletReads(walletCoinViews(wallet), wallet.address).wrap(globalThis.fetch);
  const releaseBalance: (() => void)[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input), "https://blast.test");
    if (path.pathname === "/api/social/me/wallet" && path.searchParams.has("balance_coin")) {
      await new Promise<void>((resolve) => releaseBalance.push(resolve));
    }
    return route(input, init);
  });
  let quotes = 0;
  const kit: NonNullable<CoinPanelProps["actions"]["trade"]> = {
    signedIn: true,
    signIn() {},
    wallet: async () => wallet,
    quote: async (request) => { quotes++; return { status: "ok", quote: fixtureTradeQuote(request, { signedIn: true, fee: "blast", nowMs: Date.now(), wallet: fixtureWallet() }) }; },
    send: async () => { throw new Error("No implicit send"); },
  };
  const reads: CoinPanelProps["reads"] = { coin: async () => ({ coin_type: original.coin_type, symbol: "KSTL", name: "Kestrel", decimals: 9, price_usd: "0.0021" }), chart: async () => null, holders: async () => null, activity: async () => null };
  const render = async (visible: boolean) => { await act(async () => root.render(<QueryProvider client={client}><SocialViewerProvider signedIn getAccessToken={ACCESS_TOKEN}><CoinPanel panel_id="A" asset={original} coin_setup={setup} onSetupChange={() => {}} effective_visibility={visible} actions={{ trade: kit, authenticated: true, actor_key: "account:A", confirmation: { status: "ready", enabled: false }, signIn() {} }} reads={reads} /></SocialViewerProvider></QueryProvider>)); };
  const submit = () => document.querySelector<HTMLButtonElement>("[data-coin-submit]")!;
  const debounce = async () => { await act(async () => new Promise((resolve) => setTimeout(resolve, 350))); };
  try {
    await render(true);
    assert.equal(releaseBalance.length, 1);
    await act(async () => releaseBalance[0]!());
    await debounce();
    assert.equal(submit().disabled, false);
    assert.equal(quotes, 1);
    await render(false);
    await client.invalidateQueries({ queryKey: queryKeys.me.walletBalances, refetchType: "none" });
    await render(true);
    await debounce();
    assert.equal(releaseBalance.length, 2);
    assert.equal(submit().disabled, true, "an old wallet and cached quote cannot authorize a returned panel");
    await act(async () => releaseBalance[1]!());
    await debounce();
    assert.equal(submit().disabled, false);
    assert.equal(quotes, 2, "a return obtains a new executable quote");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    dom.window.close();
  }
});

test("a hidden presale consumes no shared quote updates and return waits for refreshed commitment facts", async () => {
  const dom = new JSDOM('<div data-blast-ui><div id="mount"></div></div>', { url: "https://blast.test" });
  Object.assign(globalThis, { window: dom.window, self: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("mount")!);
  const client = createTestQueryClient();
  const store = createWorkspaceStore();
  store.add({ panel_id: "P", ...presaleAsset });
  const panel = store.getSnapshot().panels.P!;
  const setup = { ...panel.presale, commitment: { ...panel.presale.commitment, amount: "25", payment_coin_type: presaleDetail().presale.quote_type } };
  const answers: ((facts: ReturnType<typeof presaleFacts>) => void)[] = [];
  const source = createCommitQuotes({ client, read: () => new Promise<ReturnType<typeof presaleFacts>>((resolve) => answers.push(resolve)) });
  const kit: NonNullable<PresalePanelProps["actions"]["commit"]> = { signedIn: true, signIn() {}, deposit() {}, quotes: source, quotePayment: async () => ({ status: "error" }), send: async () => { throw new Error("No implicit send"); } };
  const reads: PresalePanelProps["reads"] = { detail: async () => presaleDetail(), viewer: async () => null };
  const render = async (visible: boolean) => { await act(async () => root.render(<QueryProvider client={client}><PresalePanel panel_id="P" asset={panel} presale_setup={setup} onSetupChange={() => {}} effective_visibility={visible} actions={{ commit: kit, authenticated: true, actor_key: "account:A", confirmation: { status: "ready", enabled: false }, signIn() {} }} reads={reads} /></QueryProvider>)); };
  const submit = () => document.querySelector<HTMLButtonElement>("[data-presale-submit]")!;
  try {
    await render(true);
    await act(async () => answers[0]!(presaleFacts()));
    assert.equal(submit().disabled, false);
    await render(false);
    const hidden = document.querySelector('[aria-label="Commit facts"]')!.textContent;
    let external: Promise<unknown>;
    await act(async () => { external = source.refresh(presaleAsset.presale_id); });
    const initial = presaleFacts();
    const changed = { ...initial, viewer: { ...initial.viewer!, usdc: 999 } };
    await act(async () => { answers[1]!(changed); await external; });
    assert.equal(document.querySelector('[aria-label="Commit facts"]')!.textContent, hidden, "a shell-owned shared refresh does not flow into a hidden renderer");
    await render(true);
    assert.equal(submit().disabled, true, "a cached commitment snapshot is insufficient on return");
    assert.equal(answers.length, 3);
    await act(async () => answers[2]!(presaleFacts()));
    assert.equal(submit().disabled, false);
  } finally {
    await act(async () => root.unmount());
    source.dispose();
    client.clear();
    dom.window.close();
  }
});
