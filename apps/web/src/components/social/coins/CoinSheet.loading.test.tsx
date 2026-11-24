import { PublicError } from "#web/lib/errors.ts";

import assert from "node:assert/strict";
import test from "node:test";
import { SuiGrpcClient } from "@mysten/sui/grpc";

import { installTestDom, setInputValue, waitFor } from "../../../../test/fixtures/social/test-dom.ts";
import { ACCESS_TOKEN, WALLET_FACTS, installWalletReads, walletReads } from "../../../../test/fixtures/social/commit/wallet-reads.ts";

const { document, window } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CoinSheet } = await import("./CoinSheet");
const { TokenPickerBody } = await import("./TokenPicker");
const { FIXTURE_COINS, FIXTURE_WALLET_ADDRESS } = await import("../../../../test/fixtures/social/coins/coins-fixture-model.ts");

const noop = () => undefined;
const trading = {
  signedIn: true,
  onSignIn: noop,
  requestQuote: () => new Promise<never>(() => undefined),
  listCoins: async () => [],
  trade: async () => ({ status: "traded" as const }),
};

test("a rejected withdrawal clears Sending and lets the same request be checked again", async (t) => {
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  let attempts = 0;
  const onWithdraw = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("connection lost");
    return true;
  };
  await act(async () => root.render(<CoinSheet first={{ kind: "wd", key: "usdc" }} onClose={noop} onCopy={noop} onRetry={noop} onWithdraw={onWithdraw} open session={1} trading={trading} wallet={{ status: "ready", address: FIXTURE_WALLET_ADDRESS, fee: "sponsored", coins: FIXTURE_COINS }} />));
  await act(async () => {
    for (const [input, value] of [[container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!, "10"], [container.querySelector<HTMLInputElement>('input[aria-describedby$="-msg"]')!, `0x${"a3".repeat(32)}`]] as const) {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    }
  });
  const send = [...document.querySelectorAll("button")].find((button) => button.textContent === "Withdraw 10\u00a0USDC");
  assert.ok(send);
  await act(async () => send.click());
  assert.equal(send.hasAttribute("disabled"), false);
  assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /could not be confirmed/);
  await act(async () => send.click());
  assert.equal(attempts, 2);
  assert.equal(document.querySelector('[role="alert"]'), null);
  assert.equal(send.hasAttribute("disabled"), true, "a completed send stays blocked until the host closes");
});

test("a pending withdrawal stays checkable after its exact balance falls to zero", async (t) => {
  const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
  const { SocialViewerProvider } = await import("../SignInGate");
  const { queryKeys } = await import("#web/lib/query/keys.ts");
  const reads = walletReads(FIXTURE_COINS);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = reads.wrap(originalFetch);
  const client = createTestQueryClient();
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    client.clear();
    container.remove();
  });
  const requests: Parameters<Parameters<typeof CoinSheet>[0]["onWithdraw"]>[0][] = [];
  const onWithdraw: Parameters<typeof CoinSheet>[0]["onWithdraw"] = async (request) => {
    requests.push(request);
    return requests.length === 1 ? "pending" : true;
  };
  await act(async () => root.render(withQueryClient(client, <SocialViewerProvider signedIn getAccessToken={ACCESS_TOKEN}>
    <CoinSheet first={{ kind: "wd", key: "usdc" }} onClose={noop} onCopy={noop} onRetry={noop} onWithdraw={onWithdraw} open session={1} trading={{ ...trading, walletAddress: FIXTURE_WALLET_ADDRESS }} wallet={{ status: "ready", address: FIXTURE_WALLET_ADDRESS, fee: "sponsored", coins: FIXTURE_COINS }} />
  </SocialViewerProvider>)));
  const button = (text: string) => [...container.querySelectorAll("button")].find((each) => each.textContent === text);
  const amount = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  const destination = container.querySelector<HTMLInputElement>('input[aria-describedby$="-msg"]')!;
  await act(async () => {
    for (const [input, value] of [[amount, "10"], [destination, `0x${"a3".repeat(32)}`]] as const) {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new window.Event("input", { bubbles: true }));
    }
  });
  const ready = await waitFor(() => button("Withdraw 10\u00a0USDC"), "withdrawal is funded");
  await act(async () => ready.click());
  reads.state.coins = [];
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.me.wallet() }); });
  await waitFor(() => container.textContent?.includes("Available 0\u00a0USDC"), "withdrawal balance has updated");
  assert.equal(amount.disabled, true);
  assert.equal(destination.disabled, true);
  const check = button("Check withdrawal")!;
  assert.equal(check.disabled, false);
  await act(async () => check.click());
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1], requests[0]);
});

test("a withdrawal uses the current SuiNS destination and ignores a late result for an edited name", async (t) => {
  const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
  const { SocialViewerProvider } = await import("../SignInGate");
  const reads = walletReads(FIXTURE_COINS);
  t.mock.method(globalThis, "fetch", reads.wrap(globalThis.fetch));
  const client = createTestQueryClient();
  const stale = Promise.withResolvers<{ address: string }>();
  const recipient = `0x${"a3".repeat(32)}`;
  const typedAddress = `0x${"b4".repeat(32)}`;
  t.mock.method(SuiGrpcClient.prototype, "resolveNameServiceAddress", async ({ name }: { name: string }) =>
    name === "first.sui" ? stale.promise : { address: name === "kotaro.sui" ? recipient : null }
  );
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });
  const sent: string[] = [];
  const onWithdraw: Parameters<typeof CoinSheet>[0]["onWithdraw"] = async ({ recipient }) => {
    sent.push(recipient);
    return true;
  };
  await act(async () => root.render(withQueryClient(client, <SocialViewerProvider signedIn getAccessToken={ACCESS_TOKEN}>
    <CoinSheet first={{ kind: "wd", key: "usdc" }} onClose={noop} onCopy={noop} onRetry={noop} onWithdraw={onWithdraw} open session={1} trading={{ ...trading, walletAddress: FIXTURE_WALLET_ADDRESS }} wallet={{ status: "ready", address: FIXTURE_WALLET_ADDRESS, fee: "sponsored", coins: [] }} />
  </SocialViewerProvider>)));
  const to = container.querySelector<HTMLInputElement>('input[aria-describedby$="-msg"]')!;
  const amount = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  const edit = (input: HTMLInputElement, value: string) => {
    setInputValue(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  };
  await act(async () => {
    edit(amount, "10");
    to.focus();
    edit(to, "first.sui");
    to.blur();
  });
  const withdrawButton = () => [...container.querySelectorAll("button")].find((button) => /Withdraw 10/.test(button.textContent ?? ""));
  assert.ok(container.querySelector('[aria-label="Looking up SuiNS name…"]'));
  assert.equal(withdrawButton(), undefined, "an unresolved name cannot be submitted");

  await act(async () => {
    to.focus();
    edit(to, typedAddress);
    stale.resolve({ address: `0x${"c5".repeat(32)}` });
  });
  assert.equal(to.value, typedAddress);

  await act(async () => {
    edit(to, "KOTARO.SUI");
    to.blur();
  });
  assert.equal(to.value, recipient);
  assert.equal(container.querySelector('.sr-only[role="status"]')?.textContent, `SuiNS name resolved to ${recipient}.`);
  const send = await waitFor(() => {
    const button = withdrawButton();
    return button && !button.disabled ? button : null;
  }, "exact balance and resolved recipient make the withdrawal actionable");
  await act(async () => send.click());
  assert.deepEqual(sent, [recipient]);
});

test("Fund keeps its layout mounted as the wallet loads and balances refresh", async (t) => {
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  const render = (wallet: Parameters<typeof CoinSheet>[0]["wallet"]) => <CoinSheet first={{ kind: "fund" }} onClose={noop} onCopy={noop} onRetry={noop} onWithdraw={async () => false} open session={1} trading={trading} wallet={wallet} />;
  await act(async () => root.render(render({ status: "loading" })));
  const pendingContent = document.querySelector("[data-coin-ready]");
  assert.ok(pendingContent);
  assert.ok(document.querySelector(".qrSkeleton"));
  const copy = document.querySelector('button[aria-label="Copy address"]');
  assert.equal(copy?.hasAttribute("disabled"), true);
  const ready = { status: "ready" as const, address: FIXTURE_WALLET_ADDRESS, fee: "sponsored" as const, coins: FIXTURE_COINS };
  await act(async () => root.render(render(ready)));
  const content = document.querySelector("[data-coin-ready]");
  assert.equal(content, pendingContent, "authentication updates the mounted layout");
  assert.equal(document.querySelector(".qrSkeleton"), null);
  assert.equal(document.querySelector('[aria-label="Loading your Blast wallet"]'), null);
  assert.equal(document.querySelector('button[aria-label="Copy address"]')?.hasAttribute("disabled"), false);
  await act(async () => root.render(render({ ...ready, coins: [...FIXTURE_COINS] })));
  assert.equal(document.querySelector("[data-coin-ready]"), content, "polling must not restart the entrance or reset focus");
});

test("coin search keeps skeletons until the answer arrives, then shows empty or failure copy", async (t) => {
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  t.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  for (const fail of [false, true]) {
    const answer = Promise.withResolvers<readonly typeof FIXTURE_COINS[number][] | null>();
    await act(async () => root.render(<TokenPickerBody current={FIXTURE_COINS[0]!} hidden={false} key={String(fail)} listCoins={() => answer.promise} onPick={noop} pins={[]} wallet={FIXTURE_COINS} />));
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>("input[role=combobox]")!;
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, "xyz");
      input.dispatchEvent(new window.Event("input", {bubbles: true}));
    });
    assert.ok(container.querySelector('[aria-label="Loading more coins"]'));
    assert.doesNotMatch(container.textContent, /No coins match/);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
    await act(async () => { if (fail) answer.reject(new Error("offline")); else answer.resolve([]); });
    assert.equal(container.querySelector('[aria-label="Loading more coins"]'), null);
    assert.match(container.textContent, fail ? /More coins could not load\. Try searching again\. Code: service_unavailable\./ : /No coins match “xyz”/);
  }
});

test("picker keeps resolved coins, search, chips and known balances when a refresh fails", async (t) => {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const coin = { ...FIXTURE_COINS[0]!, key: "remote", coinType: "remote", symbol: "REMOTE", name: "Remote coin" };
  const first = async () => [coin];
  const next = Promise.withResolvers<readonly typeof coin[] | null>();
  const second = () => next.promise;
  const render = (listCoins: typeof first | typeof second) => <TokenPickerBody current={FIXTURE_COINS[0]!} hidden={false} listCoins={listCoins} onPick={noop} pins={[]} wallet={FIXTURE_COINS} />;
  await act(async () => root.render(render(first)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  const input = container.querySelector("input");
  const chips = container.querySelector('[aria-label="Common coins"]');
  const results = container.querySelector(".tpResults");
  assert.match(results!.textContent!, /Remote coin/);
  await act(async () => root.render(render(second)));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  await act(async () => { next.reject(new PublicError("More coins could not load. Try searching again.", { code: "service_unavailable", requestId: "more-coins-reference" })); });
  assert.equal(container.querySelector("input"), input);
  assert.equal(container.querySelector('[aria-label="Common coins"]'), chips);
  assert.equal(container.querySelector(".tpResults"), results);
  assert.match(results!.textContent!, /Remote coin/);
  assert.match(container.textContent, /More coins could not load\. Try searching again\. Code: service_unavailable\. Reference: more-coins-reference\./);
  assert.match(container.querySelector('[aria-label="Coins"]')!.textContent!, /USDC/);
});

test("a presale Buy replaces its form with a receipt that survives failed quote and wallet refreshes", async (t) => {
  const { ALON_ID, ALON_NOW, ALON_READ, TSUI } = await import("../../../../test/fixtures/social/commit/alon.ts");
  t.mock.method(Date, "now", () => ALON_NOW);
  const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
  const { SocialViewerProvider } = await import("../SignInGate");
  const { FeedOverlaysProvider } = await import("../feed-ui/shell-bridge");
  const { createCommitQuotes } = await import("../commit/commit-quote");
  const { commitSaleOf, commitViewerOf } = await import("../commit/commit-view");
  const { contributionReceipt } = await import("../commit/commit-receipt");
  const wallet = installWalletReads([TSUI], FIXTURE_WALLET_ADDRESS);
  const client = createTestQueryClient();
  const sale = commitSaleOf(ALON_READ, { suiUsd: null })!;
  let refreshFailed = false;
  const facts = { detail: ALON_READ, sale, viewer: { ...commitViewerOf({ sale, wallet: null, entry: null, allowlist: null }), quoteBalance: 50 }, wallet: WALLET_FACTS, blockers: [], proof: null };
  const quotes = createCommitQuotes({ client, read: async () => { if (refreshFailed) throw new Error("offline"); return facts; } });
  const kit: import("../commit/commit-kit").CommitKit = { signedIn: true, quotes, quotePayment: async () => assert.fail("unexpected swap quote"), signIn: noop, deposit: noop,
    send: async (_facts, input, options) => {
      refreshFailed = true;
      assert.equal(options?.onConfirmed?.(contributionReceipt(sale, input.quoteAtoms!, "mock", "https://suiscan.xyz/mainnet/tx/mock")), true);
      return { status: "sent", digest: "mock" };
    } };
  const coin: import("./coin-model").WalletCoinView = { ...TSUI, key: ALON_ID, coinType: ALON_READ.presale.sale_token, name: "alon", symbol: "ALON", atoms: 0n, amount: 0,
    presale: { presaleId: ALON_ID, inPresale: true, trading: false, venue: "bluefin", multiple: null, quoteType: TSUI.coinType, quoteSymbol: "TSUI" } };
  const container = document.createElement("div"); container.setAttribute("data-blast-ui", ""); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); quotes.dispose(); client.clear(); });
  let dismissed = 0;
  const render = (wallet: Parameters<typeof CoinSheet>[0]["wallet"]) => withQueryClient(client,
    <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}><FeedOverlaysProvider value={{ commitKit: kit }}>
      <CoinSheet first={{ kind: "trade", key: TSUI.key, out: ALON_ID, focus: "buy" }} extraCoins={[TSUI, coin]} onClose={() => { dismissed++; }}
        onCopy={noop} onRetry={noop} onWithdraw={async () => false} open session={1} trading={trading} wallet={wallet} />
    </FeedOverlaysProvider></SocialViewerProvider>);
  await act(async () => root.render(render({ status: "ready", address: FIXTURE_WALLET_ADDRESS, fee: "wallet", coins: [TSUI] })));
  const amount = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  await waitFor(() => wallet.state.reads.length > 0 && client.isFetching() === 0, "the payment balance was read");
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(amount, "10.000000001");
    amount.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLButtonElement>('[data-kind="commit"] [data-ui-variant="primary"]')!.click());
  assert.equal(dismissed, 0, "confirmed Buy stays open");
  await act(async () => root.render(render({ status: "error" })));
  assert.match(container.textContent!, /You’re in!.*10.000000001 TSUI.*ALON.*confirmed/s);
  assert.equal(container.querySelector('input[inputmode="decimal"]'), null);
  assert.doesNotMatch(container.textContent!, /could not load|could not be confirmed|Choose another coin/);
  const done = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Done")!;
  await act(async () => done.click());
  assert.equal(dismissed, 1);
});

test("a searched holding outside the initial wallet page opens its withdrawal form", async (t) => {
  Object.assign(window, { reducedMotion: true });
  t.after(() => Reflect.deleteProperty(window, "reducedMotion"));
  const container = document.createElement("div"); container.setAttribute("data-blast-ui", ""); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const coin = { ...FIXTURE_COINS[0]!, key: "unseen", coinType: "unseen", symbol: "UNSEEN", name: "Unseen coin" };
  await act(async () => root.render(<CoinSheet first={{ kind: "pick", mode: "withdraw" }} listHoldings={async () => ({ coins: [coin], total: 1, page: 1 })} onClose={noop} onCopy={noop} onRetry={noop} onWithdraw={async () => false} open session={1} trading={trading} wallet={{ status: "ready", address: FIXTURE_WALLET_ADDRESS, fee: "sponsored", coins: FIXTURE_COINS }} />));
  await act(async () => new Promise(resolve => setTimeout(resolve, 30)));
  const row = [...container.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent?.includes("Unseen coin"))!;
  assert.ok(row);
  await act(async () => row.click());
  assert.match(container.textContent!, /Withdraw UNSEEN/);
  assert.ok(container.querySelector('input[aria-describedby$="-msg"]'), "the selected row remains available before a fresh wallet read");
});

test("a catalog miss waits for the same query in wallet holdings", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  type Loader = NonNullable<Parameters<typeof TokenPickerBody>[0]["listHoldings"]>;
  const holdings = Promise.withResolvers<Awaited<ReturnType<Loader>>>();
  const listHoldings: Loader = () => holdings.promise;
  await act(async () => root.render(<TokenPickerBody current={FIXTURE_COINS[0]!} hidden={false} listCoins={async () => []} listHoldings={listHoldings} onPick={noop} pins={[]} wallet={[]} />));
  const input = container.querySelector<HTMLInputElement>("input[role=combobox]")!;
  const type = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await type("xyz");
  await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
  assert.ok(container.querySelector('[aria-label="Loading your coins"]'));
  assert.doesNotMatch(container.textContent, /No coins match/);
  await act(async () => holdings.resolve({ coins: [], total: 0, page: 1 }));
  assert.match(container.textContent, /No coins match/);
  await type("other");
  await type("xyz");
  assert.doesNotMatch(container.textContent, /No coins match/, "returning to a query must wait for its new reads");
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Clear coin search"]')!.click());
  assert.equal(input.value, "");

});
