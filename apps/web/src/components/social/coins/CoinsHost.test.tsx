import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { queryKeys } from "#web/lib/query/keys.ts";
import { installTestDom, recordAnimations, setInputValue, testEvent, waitFor } from "../../../../test/fixtures/social/test-dom.ts";

const { document, window } = installTestDom();
window.reducedMotion = true;
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ShellActionsProvider, useShellActions } = await import("#web/components/blast-ui/shell-actions.tsx");
const { SocialViewerProvider } = await import("../SignInGate.tsx");
const { FeedOverlaysProvider } = await import("../feed-ui/shell-bridge.tsx");
const { SettingsWalletCard } = await import("../settings/WalletCard.tsx");
const { createTestQueryClient, settleQueries, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { TrendingCoinStripView } = await import("../happening/TrendingCoinStrip.tsx");
const { fixtureDetail } = await import("../../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts");
const { CoinsHost, DEPOSIT_POLL_MS } = await import("./CoinsHost.tsx");
const { CoinsOverlay } = await import("./CoinsOverlay.tsx");
const { FIXTURE_COINS, FIXTURE_WALLET_ADDRESS, DEFAULT_SWAP_MODE } = await import("../../../../test/fixtures/social/coins/coins-fixture-model.ts");
const { fixtureQuote } = await import("../../../../test/fixtures/social/coins/swap-fixture.ts");
const { SWAP_SUCCESS_MS } = await import("./SwapForm.tsx");

const detail = fixtureDetail("kstl");
const sale = detail.presale;
const trending = { coin_type: sale.sale_token, presale_id: sale.presale_id, name: sale.name, symbol: sale.symbol, icon_url: sale.icon_url, price_usd: sale.price_usd ?? "0.0021", change_24h_bps: 1200, buyers_24h: 50, holders: 100 };

const WAL = { coin_type: "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL", symbol: "WAL", name: "Walrus", decimals: 9, icon_url: null, usd_price: null, presale_id: null };

const graduated = { side: "buy" as const, coin: { coin_type: "0x123::graduated::GRAD", name: "Graduated", symbol: "GRAD", decimals: 9, icon_url: null, usd_price: null, presale_id: null } };

function EntryPoints({ inline = false, showWalletCard = false }: Readonly<{ inline?: boolean | "graduated"; showWalletCard?: boolean }>) {
  const run = useShellActions();
  return <><button onClick={() => run("openFund")} type="button">Header Fund</button><button onClick={() => run("openTrade")} type="button">Header Swap</button><button onClick={() => run("openCoin", WAL.coin_type)} type="button">Search WAL</button><TrendingCoinStripView coins={[trending]} onOpen={(key) => run("openCoin", key)} />{showWalletCard ? <SettingsWalletCard /> : null}<CoinsOverlay />{inline ? <section data-inline-trade=""><CoinsHost {...(inline === "graduated" ? { inlineTrade: graduated } : { inlineSale: sale })} /></section> : null}</>;
}

function walletResponse(walletCardCoins: typeof FIXTURE_COINS | undefined, getInputAtoms: () => bigint | undefined) {
  const wallet = { address: FIXTURE_WALLET_ADDRESS, signer: "wallet", fee: "wallet", as_of_ms: Date.now(), coins: (walletCardCoins ?? FIXTURE_COINS.slice(0, 2)).map((coin) => ({ coin_type: coin.coinType, name: coin.name, symbol: coin.symbol, decimals: coin.decimals, atoms: coin.atoms.toString(), usd_price: String(coin.price), value_usd: "0.00", icon_url: coin.iconUrl, presale: null })) };
  return (path: string) => {
    const inputAtoms = getInputAtoms();
    const params = new URL(path, "https://blast.test").searchParams;
    if (params.has("identity")) return Response.json({ ...wallet, coins: null });
    const coinType = params.get("balance_coin");
    if (coinType !== null) {
      const coin = wallet.coins.find((coin) => coin.coin_type === coinType);
      const atoms = coinType === FIXTURE_COINS[0]!.coinType ? inputAtoms?.toString() ?? coin?.atoms : coin?.atoms;
      return Response.json({ address: wallet.address, coin_type: coinType, atoms: atoms ?? "0", as_of_ms: Date.now() });
    }
    if (inputAtoms !== undefined) return Response.json({}, { status: 503 });
    const rows = walletCardCoins === undefined ? [] : wallet.coins;
    return Response.json(path.includes("?") ? { ...wallet, coins: rows, listing: { page: 1, page_size: 20, total: rows.length, value_usd: "0.00", extra_coins: wallet.coins } } : wallet);
  };
}

async function mount(t: TestContext, {
  failCoin = false, tradeStatus = "traded", inline = false, walletCardCoins, inputAtoms,
}: Readonly<{
  failCoin?: boolean;
  tradeStatus?: "traded" | "pending";
  inline?: boolean | "graduated";
  walletCardCoins?: typeof FIXTURE_COINS;
  inputAtoms?: bigint;
}> = {}) {
  const motion = recordAnimations();
  const originalFetch = globalThis.fetch;
  let walletReads = 0;
  const showWalletCard = walletCardCoins !== undefined;
  const answerWallet = walletResponse(walletCardCoins, () => inputAtoms);
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    if (path.startsWith("/api/social/me/wallet")) {
      walletReads += 1;
      return answerWallet(path);
    }
    if (path === `/api/social/presales/${sale.presale_id}`) return failCoin ? Response.json({}, { status: 503 }) : Response.json(detail);
    if (path.startsWith("/api/social/trades/coins?")) return Response.json({ coins: new URL(path, "https://blast.test").searchParams.get("q") === WAL.coin_type ? [WAL] : [], next_cursor: null });
    if (path === "/api/social/trades/quote") return Response.json(fixtureQuote(JSON.parse(String(init?.body)), FIXTURE_COINS, DEFAULT_SWAP_MODE, Date.now()));
    return Response.json({}, { status: 404 });
  };
  const client = createTestQueryClient();
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  });
  const tradeKit = { signedIn: true, signIn: () => undefined, wallet: async () => null, quote: async () => ({ status: "error" as const }), send: async () => ({ status: tradeStatus, title: "Trade result" }) };
  await act(async () => root.render(withQueryClient(client, <ShellActionsProvider><SocialViewerProvider signedIn getAccessToken={async () => "test-access-token"}><FeedOverlaysProvider value={{ tradeKit }}><EntryPoints inline={inline} showWalletCard={showWalletCard} /></FeedOverlaysProvider></SocialViewerProvider></ShellActionsProvider>)));
  const click = async (label: string, selector = "button") => {
    const button = [...document.querySelectorAll<HTMLButtonElement>(selector)].find((element) => element.textContent.startsWith(label) || element.getAttribute("aria-label")?.startsWith(label));
    assert.ok(button, `${label} is available`);
    await act(async () => button.click());
    await act(async () => settleQueries(client));
  };
  return { motion, click, recover: () => { failCoin = false; }, walletReads: () => walletReads, client, setInputAtoms: (atoms: bigint) => { inputAtoms = atoms; } };
}

test("an unheld trending coin opens its trade without a balance", async (t) => {
  const { click } = await mount(t);
  await click(sale.symbol);
  assert.equal(document.querySelector("h2")?.textContent, sale.name);
  assert.match(document.body.textContent, new RegExp(`0\u00a0${sale.symbol}`));
  await click("Trade");
  const trade = document.querySelector('[role="dialog"]')!;
  assert.match(trade.textContent ?? "", new RegExp(`PayBalance 0\u00a0${sale.symbol}.*ReceiveBalance [\\d,.]+\u00a0USDC`));
  assert.match(trade.querySelector('[data-coin-pick="in"]')?.textContent ?? "", new RegExp(sale.symbol));
  assert.match(trade.querySelector('[data-coin-pick="out"]')?.textContent ?? "", /USDC/);
});

test("Swap uses the selected coin's exact balance when the wallet list fails", async (t) => {
  const { click, client, setInputAtoms } = await mount(t, { inputAtoms: 95_240_600n });
  await click("Header Swap");
  const dialog = document.querySelector('[role="dialog"]')!;
  const amount = dialog.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  await click("Max", '[role="dialog"] button');
  assert.equal(amount.value, "95.2406");
  setInputAtoms(80_000_000n);
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.me.wallet() }); });
  await waitFor(() => dialog.textContent?.includes("Balance 80\u00a0USDC"), "balance falls after selecting Max");
  assert.equal(amount.value, "95.2406");
  assert.equal(dialog.querySelector<HTMLButtonElement>("[data-trade]")?.disabled, true);
  await act(async () => { setInputValue(amount, "100"); amount.dispatchEvent(testEvent("input")); });
  assert.match(dialog.textContent!, /Not enough USDC for this amount/);
  assert.equal(dialog.querySelector<HTMLButtonElement>("[data-trade]")?.disabled, true);
});

for (const status of ["traded", "pending"] as const) {
  test(`the home Swap sheet handles ${status} after confirmation`, async (t) => {
    const h = await mount(t, { tradeStatus: status });
    await h.click("Header Swap");
    const input = document.querySelector<HTMLInputElement>('[data-coin-focus]')!;
    await act(async () => { setInputValue(input, "100"); input.dispatchEvent(testEvent("input")); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 320)); });
    const button = document.querySelector<HTMLButtonElement>("[data-trade]")!;
    assert.equal(button.disabled, false);
    await act(async () => button.click());
    await act(async () => settleQueries(h.client));
    if (status === "traded") {
      assert.equal(document.querySelector('[data-trade]')?.textContent, "Successful");
      assert.ok(document.querySelector('[role="dialog"]'), "confirmation keeps the sheet open");
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, SWAP_SUCCESS_MS + 100)); });
    }
    await act(async () => h.motion.finishAll());
    if (status === "traded") {
      assert.ok(document.querySelector('[role="dialog"]'), "confirmed swaps leave the sheet open");
      assert.equal(input.value, "");
      assert.equal(input.disabled, false);
      assert.equal(document.querySelector("[data-out]")!.textContent, "—");
      assert.doesNotMatch(button.textContent!, /Successful/);
      assert.equal(button.disabled, true, "an empty form cannot repeat the previous swap");
      await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
      await act(async () => h.motion.finishAll());
    }
    assert.equal(document.querySelector('[role="dialog"]'), null, "pending or manual dismissal closes the sheet");
  });
}

test("an unheld ecosystem coin from search opens by its coin type, not as a sale", async (t) => {
  const { click } = await mount(t);
  await click("Search WAL");
  assert.equal(document.querySelector("h2")?.textContent, "Walrus");
  assert.equal(document.querySelector('[role="alert"]'), null, "the coin loads instead of the sale read's error");
  assert.match(document.body.textContent, /0\u00a0WAL/);
});

test("An unheld coin read failure can be retried without falling back to USDC and SUI", async (t) => {
  const { click, recover } = await mount(t, { failCoin: true });
  await click(sale.symbol);
  assert.ok(document.querySelector('[role="alert"]'));
  recover();
  await click("Try again");
  assert.equal(document.querySelector("h2")?.textContent, sale.name);
  assert.equal(document.querySelector('[role="alert"]'), null);
});

test("Fund opens the Sui address and polls only while the address is visible", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const h = await mount(t);
  const tick = async () => {
    await act(async () => t.mock.timers.tick(DEPOSIT_POLL_MS));
    await act(async () => settleQueries(h.client));
  };
  await h.click("Header Fund");
  assert.equal(document.querySelector("h2")?.textContent, "Fund");
  assert.equal(document.querySelector('[role="dialog"] b.mono')?.textContent, FIXTURE_WALLET_ADDRESS);
  assert.ok(document.querySelector('[role="dialog"] button[aria-label="Copy address"]'));
  assert.equal(document.querySelector('[aria-label="Search your coins"]'), null);

  const addressReads = h.walletReads();
  await tick();
  assert.equal(h.walletReads(), addressReads + 1);

  await h.click("Withdraw");
  assert.equal(document.querySelector("h2")?.textContent, "Withdraw");
  assert.ok(document.querySelector('[aria-label="Search your coins"]'));
  const pickerReads = h.walletReads();
  await tick();
  assert.equal(h.walletReads(), pickerReads);

  await h.click("Back");
  assert.equal(document.querySelector("h2")?.textContent, "Fund");
  const returnReads = h.walletReads();
  await tick();
  assert.equal(h.walletReads(), returnReads + 1);
});

test("Fund and the settings wallet both fill Max with the selected coin's exact precision", async (t) => {
  const walletCardCoins = FIXTURE_COINS.slice(0, 2).map((coin) => ({ ...coin, atoms: coin.atoms + 1n }));
  const { click, motion } = await mount(t, { walletCardCoins });
  const dialogButton = '[role="dialog"] button';
  const amount = () => document.querySelector<HTMLInputElement>('[role="dialog"] input[inputmode="decimal"]')!;
  const pick = async (name: string) => {
    await waitFor(() => [...document.querySelectorAll(dialogButton)].some((button) => button.textContent.startsWith(name)), `${name} in the withdrawal picker`, 3_000);
    await click(name, dialogButton);
  };

  await click("Header Fund");
  await click("Withdraw", dialogButton);
  await pick("USDC");
  await click("Max", dialogButton);
  assert.equal(amount().value, "860.000001");
  await click("Close", dialogButton);
  await act(async () => motion.finishAll());

  await click("Withdraw", "#sideWallet button");
  await pick("USDC");
  await click("Max", dialogButton);
  assert.equal(amount().value, "860.000001");
  await click("Back", dialogButton);
  await pick("SUI");
  await click("Max", dialogButton);
  assert.equal(amount().value, "412.360000001", "keep the SUI fee reserve and all nine decimal places");
  const input = amount();
  await act(async () => { setInputValue(input, "1.000000009"); input.dispatchEvent(testEvent("input")); });
  assert.equal(input.value, "1.000000009");
});


test("an inline sale form keeps the global sheet actions and does not steal focus", async (t) => {
  const { click, motion } = await mount(t, { inline: true });
  const panel = document.querySelector("[data-inline-trade]")!;
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
  // The Coin board's ticket: the card around the form shows "Buy {name}", so the form's own title is for assistive technology only, and it pays.
  assert.equal(panel.querySelector("h2")?.closest(".sr-only") !== null, true, "the form's title is not shown twice");
  assert.match(panel.textContent!, /You payBalance [\d,.]+\u00a0USDC.*You getBalance —/);
  assert.match(panel.querySelector('[data-coin-pick="in"]')?.textContent ?? "", /USDC/);
  assert.match(panel.querySelector('[data-coin-pick="out"]')?.textContent ?? "", new RegExp(sale.symbol));
  assert.equal(panel.querySelector('[role="dialog"], dialog'), null);
  assert.equal(panel.contains(document.activeElement), false, "page load leaves keyboard focus in place");
  const input = panel.querySelector<HTMLInputElement>("input")!;
  await act(async () => { setInputValue(input, "12"); input.dispatchEvent(testEvent("input")); });
  await act(async () => {
    const picker = panel.querySelector<HTMLButtonElement>('[data-coin-pick="in"]')!;
    picker.focus();
    picker.click();
  });
  assert.equal(document.activeElement, panel.querySelector('[aria-label="Search coins"]'), "the page picker focuses search");
  await act(async () => panel.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click());
  assert.equal(document.activeElement, panel.querySelector('[data-coin-pick="in"]'), "Back restores focus in the page form");
  assert.equal(panel.querySelector<HTMLInputElement>("input")!.value, "12", "the page picker preserves the amount");
  await click("Header Fund");
  assert.equal(document.querySelector('[role="dialog"] h2')?.textContent, "Fund");
  assert.equal(panel.querySelector<HTMLInputElement>("input")!.value, "12", "opening another shell flow preserves the page draft");
  await act(async () => document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="Close"]')!.click());
  await act(async () => motion.finishAll());
  await click("Header Swap");
  const dialog = document.querySelector('[role="dialog"]')!;
  assert.equal(document.activeElement, dialog.querySelector('[data-coin-focus]'), "sheet focus stays inside its own form");
  const picker = dialog.querySelector<HTMLButtonElement>('[data-coin-pick="in"]')!;
  await act(async () => { picker.focus(); picker.click(); });
  await act(async () => motion.finishAll());
  await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="Back"]')!.click());
  await act(async () => motion.finishAll());
  assert.equal(document.activeElement, dialog.querySelector('[data-coin-pick="in"]'), "picker Back restores focus in the sheet");
});


test("a graduated page uses the shared swap with both coin pickers, flip and independent shell actions", async (t) => {
  const { click } = await mount(t, { inline: "graduated" });
  const panel = document.querySelector("[data-inline-trade]")!;
  assert.match(panel.querySelector('[data-coin-pick="in"]')?.textContent ?? "", /USDC/);
  assert.match(panel.querySelector('[data-coin-pick="out"]')?.textContent ?? "", /GRAD/);
  assert.equal(panel.querySelector('[role="dialog"]'), null);
  assert.equal(panel.contains(document.activeElement), false);
  await act(async () => panel.querySelector<HTMLButtonElement>('[data-coin-pick="in"]')!.click());
  assert.match(panel.textContent!, /Select payment coin/);
  const sui = [...panel.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent.includes("SUI") && !button.textContent.includes("USDC"));
  assert.ok(sui, "the common picker offers another payment coin");
  await act(async () => sui.click());
  assert.match(panel.querySelector('[data-coin-pick="in"]')?.textContent ?? "", /SUI/);
  assert.match(panel.querySelector('[data-coin-pick="out"]')?.textContent ?? "", /GRAD/);
  const flip = panel.querySelector<HTMLButtonElement>('[data-flip]');
  assert.ok(flip);
  await act(async () => flip.click());
  assert.match(panel.querySelector('[data-coin-pick="in"]')?.textContent ?? "", /GRAD/);
  await click("Header Swap");
  assert.ok(document.querySelector('[role="dialog"]'), "page form leaves the shell swap action intact");
  assert.match(panel.querySelector('[data-coin-pick="in"]')?.textContent ?? "", /GRAD/);
});
