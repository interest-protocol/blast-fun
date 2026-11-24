import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom, setInputValue, waitFor } from "../../../../test/fixtures/social/test-dom.ts";
import { ALON_NOW, ALON_READ, TSUI } from "../../../../test/fixtures/social/commit/alon.ts";
import { FIXTURE_COINS } from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";
import { ACCESS_TOKEN, WALLET_ADDRESS, installWalletReads } from "../../../../test/fixtures/social/commit/wallet-reads.ts";
import { commitSaleOf } from "./commit-view";
import type { CommitPanelProps } from "./CommitPanel";
import { PUBLIC_PREFERRED_COINS } from "../coins/coin-model";

const dom = installTestDom();
Object.assign(dom.document, { oninput: null });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, settleQueries, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { queryKeys } = await import("#web/lib/query/keys.ts");
const { SocialViewerProvider } = await import("../SignInGate");
const { CommitPanel } = await import("./CommitPanel");
const sale = commitSaleOf(ALON_READ, { suiUsd: null })!;
const usdc = FIXTURE_COINS[0]!;
const wallet = installWalletReads([TSUI, usdc]);
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 40)); });
const props: CommitPanelProps = {
  sale, viewer: { usdc: 0, sui: 0, suiUsd: null, committed: 0, allowlist: null, quoteCoin: "TSUI", quoteBalance: 50 },
  walletCoins: [TSUI], walletAddress: WALLET_ADDRESS, blockers: [], nowMs: ALON_NOW,
  onBlast: async () => assert.fail("preview interactions must not submit"), onDeposit: () => assert.fail("preview must not deposit"), inline: true,
};

test("presale payments can select each zero-balance preferred coin without enabling purchase", async (t) => {
  const container = dom.document.createElement("div"); container.setAttribute("data-blast-ui", ""); dom.document.body.append(container);
  const root = createRoot(container); const client = createTestQueryClient();
  wallet.state.coins = PUBLIC_PREFERRED_COINS;
  t.after(async () => { wallet.state.coins = [TSUI, usdc]; await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(withQueryClient(client,
    <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}><CommitPanel {...props} walletCoins={PUBLIC_PREFERRED_COINS} compact purchase /></SocialViewerProvider>)));
  for (const coin of PUBLIC_PREFERRED_COINS) {
    await act(async () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"][aria-label^="Pay with"]')!.click());
    const row = [...dom.document.querySelectorAll<HTMLElement>('[role="option"]')].find(row => row.querySelector("b")?.textContent === coin.symbol);
    assert.ok(row, `${coin.symbol} remains available at zero`);
    assert.notEqual(row.getAttribute("aria-disabled"), "true");
    await act(async () => row.click());
    await settle();
    assert.ok(container.querySelector(`[aria-label="Pay with ${coin.symbol}"]`));
    assert.match(container.querySelector(".balance")?.textContent ?? "", /Balance 0/);
    const amount = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
    await act(async () => { setInputValue(amount, "10"); amount.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
    assert.equal(container.querySelector<HTMLButtonElement>('[data-ui-variant="primary"]')?.disabled, true);
  }
});

test("wallet setup guidance requires a settled signed-in session without hiding sale blockers", async (t) => {
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container); const client = createTestQueryClient();
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  const render = async (signedIn: boolean, sessionPending = false, blockers: CommitPanelProps["blockers"] = ["wallet_missing"]) => { await act(async () => root.render(withQueryClient(client,
    <SocialViewerProvider signedIn={signedIn} sessionPending={sessionPending} callsign="kai" getAccessToken={ACCESS_TOKEN}><CommitPanel {...props} draft={{ coinType: TSUI.coinType, amount: "10", why: "" }} blockers={blockers} compact purchase /></SocialViewerProvider>))); await settle(); };
  const primary = () => container.querySelector<HTMLButtonElement>('[data-ui-variant="primary"]')!;
  const amount = () => container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  await render(false);
  assert.equal(amount().value, "10");
  assert.doesNotMatch(container.textContent!, /wallet is still being set up/);
  assert.equal(primary().textContent, "Sign in to buy allocation");
  assert.equal(primary().disabled, false);
  assert.equal(amount().getAttribute("aria-describedby"), null);
  await render(false, true);
  assert.doesNotMatch(container.textContent!, /wallet is still being set up/);
  assert.equal(primary().disabled, true);
  await render(true, true);
  assert.doesNotMatch(container.textContent!, /wallet is still being set up/);
  assert.equal(primary().disabled, true);
  await render(true);
  assert.match(container.textContent!, /wallet is still being set up/);
  assert.equal(primary().disabled, true);
  const note = container.querySelector(".note")!;
  assert.equal(amount().getAttribute("aria-describedby"), note.id);
  await render(false);
  assert.doesNotMatch(container.textContent!, /wallet is still being set up/);
  assert.equal(amount().getAttribute("aria-describedby"), null);
  await render(false, false, ["wallet_missing", "allowlist_unavailable"]);
  assert.match(container.textContent!, /allowlist could not be read/);
  assert.doesNotMatch(container.textContent!, /wallet is still being set up/);
  await render(false, false, ["presale_not_deployed", "wallet_missing"]);
  assert.match(container.textContent!, /sale contract is live/);
  await render(true, false, []);
  assert.doesNotMatch(container.textContent!, /wallet is still being set up/);
  assert.equal(primary().disabled, false);
});

test("featured purchase uses the existing allocation and commit checks with terms still accessible", async (t) => {
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container); const client = createTestQueryClient();
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  let submitted: Parameters<CommitPanelProps["onBlast"]>[0] | undefined;
  await act(async () => root.render(withQueryClient(client,
    <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}><CommitPanel {...props} compact purchase onBlast={async (input) => { submitted = input; return { ok: true }; }} /></SocialViewerProvider>)));
  const amount = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  const action = container.querySelector<HTMLButtonElement>('[data-ui-variant="primary"]')!;
  assert.equal(amount.value, "");
  assert.equal(action.disabled, true);
  assert.match(container.textContent!, /Estimated allocation.*Allocation details.*Add a message/s);
  assert.match(container.textContent!, /Locked until close\. Full refund if the target is missed/);
  await act(async () => { setInputValue(amount, "1"); amount.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  assert.equal(action.disabled, true, "the existing minimum still applies");
  await act(async () => { setInputValue(amount, "25"); amount.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  assert.equal(action.disabled, false);
  assert.match(container.textContent!, /≈.*ALON/);
  await act(async () => action.click());
  assert.equal(submitted?.quoteAtoms, "25000000000");
  assert.equal(submitted?.payWith, "TSUI");
});

test("every payment selector opens the shared modal and remains honest about unavailable holdings", async (t) => {
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container); const client = createTestQueryClient();
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  const render = (patch: Partial<CommitPanelProps> = {}) => act(async () => root.render(withQueryClient(client,
    <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}><CommitPanel {...props} {...patch} /></SocialViewerProvider>)));
  await render();
  assert.equal(container.querySelector("select"), null);
  const badge = container.querySelector('[aria-label="Pay with TSUI"]');
  assert.match(badge?.textContent ?? "", /TSUI/);
  assert.equal(badge?.getAttribute("aria-haspopup"), "dialog");
  assert.equal(badge?.closest(".amtRow")?.querySelector("input")?.id, container.querySelector("label")?.htmlFor);
  assert.doesNotMatch(container.textContent!, /Paid in|swap route|This presale accepts|Pay directly/);
  assert.equal(container.querySelector("details")?.open, false, "the optional message starts collapsed");
  assert.match(container.textContent!, /Locked until close/);
  assert.doesNotMatch(container.textContent!, /Your share of the raise/);
  await render({ walletCoins: [TSUI, usdc] });
  const selector = container.querySelector<HTMLButtonElement>('button[aria-label="Pay with TSUI"]')!;
  assert.ok(selector && !selector.disabled);
  assert.equal(selector.getAttribute("aria-haspopup"), "dialog");
  assert.equal(container.querySelector("select"), null);
  assert.ok(selector.closest(".amtRow")?.querySelector("input"));
  assert.doesNotMatch(container.textContent!, /This presale accepts|check a swap route/);
  const amount = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  await act(async () => { setInputValue(amount, "60"); amount.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  assert.match(container.textContent!, /Choose another coin or add TSUI\./);
  await act(async () => { setInputValue(amount, ""); amount.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  for (const unavailable of [{ ...usdc, metadataAvailable: false }, { ...usdc, atoms: 0n }]) {
    await render({ walletCoins: [TSUI, unavailable] });
    assert.equal(container.querySelector("select"), null);
    assert.doesNotMatch(container.textContent!, /swap route/);
  }
  await render({ walletCoins: [TSUI, { ...usdc, metadataAvailable: false }] });
  assert.ok(container.querySelector('button[aria-label="Pay with TSUI"][aria-haspopup="dialog"]'));
  await render({ walletCoinsState: "loading" });
  assert.match(container.querySelector('.amtTop [role="status"]')?.textContent ?? "", /Loading coins/);
  await render({ walletCoinsState: "unavailable" });
  assert.match(container.querySelector('.amtTop [role="status"]')?.textContent ?? "", /Coins unavailable\. Refresh\./);
  assert.doesNotMatch(container.textContent!, /swap route/);
  await render({ active: false });
  assert.equal(container.querySelector<HTMLButtonElement>('[data-ui-variant="primary"]')?.disabled, true, "a dismissing modal cannot submit");
  await render({ purchase: true });
  assert.equal(container.querySelector("select"), null, "inline Buy uses the same single-coin control");
  assert.doesNotMatch(container.textContent!, /You’re buying an allocation/);
});

test("presets, Max, decimal precision, estimates and empty/minimum safeguards survive the combined amount control", async (t) => {
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container); const client = createTestQueryClient();
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(withQueryClient(client,
    <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}><CommitPanel {...props} /></SocialViewerProvider>)));
  await settle();
  const input = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  const primary = () => container.querySelector<HTMLButtonElement>('[data-ui-variant="primary"]')!;
  const type = (value: string) => act(async () => { setInputValue(input, value); input.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  assert.equal(input.value, ""); assert.equal(primary().disabled, true);
  const presets = [...container.querySelectorAll<HTMLButtonElement>('.presets button')];
  await act(async () => presets[0]!.click());
  assert.equal(input.value, "10"); assert.equal(primary().disabled, false);
  assert.match(container.textContent!, /≈ 90,000 ALON/);
  await act(async () => presets[3]!.click());
  assert.equal(input.value, "50");
  await type("10.0000000019");
  assert.equal(input.value, "10.000000001");
  await type("1");
  assert.equal(input.getAttribute("aria-invalid"), "true"); assert.equal(primary().disabled, true);
  await type("60");
  assert.equal(input.getAttribute("aria-invalid"), "true"); assert.equal(primary().textContent, "Add TSUI");
  assert.doesNotMatch(container.textContent!, /Choose another coin/);
  await type("invalid");
  assert.equal(input.value, ""); assert.equal(primary().disabled, true);
  await type("0"); assert.equal(primary().disabled, true);
});

test("USDsui checkout can add funds after a verified shortfall with no holdings list", async (t) => {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  const client = createTestQueryClient();
  const usdsui = PUBLIC_PREFERRED_COINS.find((coin) => coin.symbol === "USDsui")!;
  wallet.state.coins = [{ ...usdsui, atoms: 95_240_600n }];
  let deposits = 0;
  t.after(async () => { wallet.state.coins = [TSUI, usdc]; await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(withQueryClient(client,
    <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}>
      <CommitPanel {...props}
        sale={{ ...sale, quoteType: usdsui.coinType, quoteCoin: usdsui.symbol, quoteDecimals: usdsui.decimals, quoteUsd: 1 }}
        walletCoins={[]}
        walletFee="sponsored"
        draft={{ coinType: usdsui.coinType, amount: "100", why: "" }}
        onDeposit={() => deposits++}
      />
    </SocialViewerProvider>)));
  const add = await waitFor(() => [...container.querySelectorAll("button")].find((button) => button.textContent === "Add USDsui"), "the exact USDsui shortfall enables Add funds");
  await act(async () => add.click());
  assert.equal(deposits, 1);
});

test("Max pays the exact spendable SUI for the current fee mode and requires sign-in", async (t) => {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  const client = createTestQueryClient();
  const sui = { ...FIXTURE_COINS.find((coin) => coin.key === "sui")!, atoms: 25_123_456_789n };
  wallet.state.coins = [sui];
  t.after(async () => {
    wallet.state.coins = [TSUI, usdc];
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });
  const render = (signedIn: boolean, walletFee: CommitPanelProps["walletFee"]) => act(async () => {
    root.render(withQueryClient(client,
      <SocialViewerProvider signedIn={signedIn} callsign="kai" getAccessToken={ACCESS_TOKEN}>
        <CommitPanel {...props} sale={{ ...sale, quoteCoin: "SUI", quoteType: sui.coinType, quoteDecimals: 9 }} walletCoins={[sui]} walletFee={walletFee} />
      </SocialViewerProvider>));
  });
  const max = () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Max")!;
  const amount = () => container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!.value;

  await render(false, "wallet");
  assert.equal(max().disabled, true);

  await render(true, "wallet");
  await act(async () => { await settleQueries(client); });
  await act(async () => max().click());
  assert.equal(amount(), "25.103456789");
  assert.equal(max().getAttribute("aria-pressed"), "true");

  await render(true, "sponsored");
  assert.equal(max().getAttribute("aria-pressed"), "false");
  await act(async () => max().click());
  assert.equal(amount(), "25.123456789");
  assert.equal(max().getAttribute("aria-pressed"), "true");
  const field = container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  await act(async () => { setInputValue(field, "25.123456790"); field.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  assert.equal(field.getAttribute("aria-invalid"), "true", "one atom above the exact balance is insufficient");
  assert.equal(container.querySelector('[data-ui-variant="primary"]')?.textContent, "Add SUI");
});

test("an invalid restored message opens its modal and keeps purchase disabled", async (t) => {
  const container = dom.document.createElement("div"); container.setAttribute("data-blast-ui", ""); dom.document.body.append(container);
  const root = createRoot(container); const client = createTestQueryClient();
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(withQueryClient(client,
    <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}><CommitPanel {...props} compact purchase draft={{coinType: TSUI.coinType, amount: "10", why: "https://example.com"}} /></SocialViewerProvider>)));
  const message = container.querySelector<HTMLTextAreaElement>("textarea")!;
  assert.ok(message.closest('[role="dialog"]'));
  assert.match(container.querySelector('[role="dialog"]')!.textContent!, /Add a message/);
  assert.equal(container.querySelectorAll("details:not(.balance)").length, 0);
  assert.equal(message.getAttribute("aria-invalid"), "true");
  assert.equal(container.querySelector<HTMLButtonElement>('[data-ui-variant="primary"]')?.disabled, true);
});

test("a hundred payment coins use a searchable picker and preserve the chosen coin", async (t) => {
  const container = dom.document.createElement("div"); container.setAttribute("data-blast-ui", ""); dom.document.body.append(container);
  const root = createRoot(container); const client = createTestQueryClient();
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  const coins = Array.from({ length: 100 }, (_, index) => ({ ...usdc, key: `payment-${index}`, coinType: `0x${String(index + 100).padStart(64, "0")}::coin::C${index}`, name: `Payment coin ${index}`, symbol: `PAY${index}`, atoms: 100000000n, amount: 100, value: index }));
  wallet.state.coins = [TSUI, ...coins];
  t.after(() => { wallet.state.coins = [TSUI, usdc]; });
  await act(async () => root.render(withQueryClient(client, <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}><CommitPanel {...props} walletCoins={[TSUI, ...coins]} /></SocialViewerProvider>)));
  assert.equal(container.querySelector("select"), null);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Pay with TSUI"]')!.click());
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 100)); });
  const search = dom.document.querySelector<HTMLInputElement>('[aria-label="Search coins"]')!;
  assert.ok(search);
  const pickerText = dom.document.querySelector('[role="dialog"]')?.textContent ?? "";
  assert.match(pickerText, /SUI.*USDC.*USDsui/);
  assert.equal(dom.document.querySelectorAll('[role="option"]').length <= 23, true);
  await act(async () => { setInputValue(search, "PAY99"); search.dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)); });
  const option = [...dom.document.querySelectorAll<HTMLElement>('[role="option"]')].find(row => row.textContent?.includes("PAY99"))!;
  assert.ok(option, "search finds a coin outside the first twenty");
  await act(async () => option.click());
  assert.match(container.querySelector('[aria-label="Pay with PAY99"]')?.textContent ?? "", /PAY99/);
});


test("balance stays compact without a disclosure and preserves the payment currency", async (t) => {
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container); const client = createTestQueryClient();
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  const atoms = 123456789123456789n;
  const heldNow = async (held: typeof TSUI[]) => { wallet.state.coins = held; await client.invalidateQueries({ queryKey: queryKeys.me.wallet() }); await settle(); };
  t.after(() => { wallet.state.coins = [TSUI, usdc]; });
  wallet.state.coins = [{ ...TSUI, atoms }];
  await act(async () => root.render(withQueryClient(client, <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}><CommitPanel {...props} walletCoins={[{ ...TSUI, atoms }]} compact purchase /></SocialViewerProvider>)));
  await settle();
  const disclosure = container.querySelector(".balance")!;
  assert.match(disclosure.textContent!, /Balance ≈ 123,456,789\.1234 TSUI/);
  assert.equal(disclosure.tagName, "SPAN");
  assert.doesNotMatch(disclosure.textContent!, /Exact balance/);
  assert.doesNotMatch(disclosure.textContent!, /\$/);
  await act(async () => root.render(withQueryClient(client, <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}><CommitPanel {...props} walletCoins={[{ ...TSUI, atoms: 1n }]} compact purchase /></SocialViewerProvider>)));
  await heldNow([{ ...TSUI, atoms: 1n }]);
  assert.match(container.querySelector(".balance")!.textContent!, /Balance <0\.0001 TSUI/);
  assert.doesNotMatch(container.querySelector(".balance")!.textContent!, /Exact balance/);
  await act(async () => root.render(withQueryClient(client, <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}><CommitPanel {...props} sale={{ ...props.sale, raised: 1100, target: 1000 }} walletCoins={[TSUI]} compact purchase /></SocialViewerProvider>)));
  await heldNow([TSUI]);
  const consequence = [...container.querySelectorAll("p")].find((item) => item.textContent?.startsWith("Allocation is proportional."));
  assert.ok(consequence);
  assert.equal(consequence.closest("details"), null, "allocation consequences stay outside collapsed estimates");
  assert.match(consequence.textContent!, /Unallocated payment is refunded at claim/);
  assert.equal(container.textContent!.match(/Unallocated payment/gi)?.length, 1, "refund timing has one reading path");

});

test("#1012: a fresh commit box starts empty, holds exactly what is typed, and never refills itself", async (t) => {
  const container = dom.document.createElement("div"); dom.document.body.append(container);
  const root = createRoot(container); const client = createTestQueryClient();
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  const render = (quoteUsd: number | null) => act(async () => root.render(withQueryClient(client,
    <SocialViewerProvider signedIn callsign="kai" getAccessToken={ACCESS_TOKEN}><CommitPanel {...props} inline={false} viewer={{ ...props.viewer, quoteBalance: 5_000, quoteUsd }} /></SocialViewerProvider>)));
  const amount = () => container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')!;
  const type = (value: string) => act(async () => { setInputValue(amount(), value); amount().dispatchEvent(new dom.window.Event("input", { bubbles: true })); });
  await render(null);
  assert.equal(amount().value, "", "no amount the person did not type");
  await render(0.7);
  assert.equal(amount().value, "", "a price arriving late fills nothing in");
  await type("3000");
  assert.equal(amount().value, "3000");
  await type("");
  await render(0.71);
  assert.equal(amount().value, "", "a cleared box stays empty");
});
