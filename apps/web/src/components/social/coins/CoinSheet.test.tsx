import assert from "node:assert/strict";
import { readFileSync } from "#web/test/css-design-px.ts";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { CoinSheet, type CoinSheetTrading, type CoinSheetWallet } from "./CoinSheet";
import type { CoinScreen } from "./coin-model";
import { FIXTURE_WALLET_ADDRESS } from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";
import { FIXTURE_COINS } from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";

/** No quote is asked on the server (effects do not run): a screen shows what it has before any answer. */
const TRADING: CoinSheetTrading = {
  signedIn: true,
  onSignIn: () => undefined,
  requestQuote: () => new Promise(() => undefined),
  listCoins: async () => [],
  trade: async () => ({ status: "failed", message: "That didn’t go through", code: null }),
};

/** Social UI-14: the coins sheet's markup on each screen (the live design's copy), and the states it adds (OA-13, OA-14). */

const READY: CoinSheetWallet = { status: "ready", address: FIXTURE_WALLET_ADDRESS, fee: "sponsored", coins: FIXTURE_COINS };
const text = (html: string) => html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) => text(match[1]!));

function render(
  stack: readonly CoinScreen[],
  options: Readonly<{
    wallet?: CoinSheetWallet;
    trading?: CoinSheetTrading;
    inline?: boolean;
  }> = {},
) {
  return renderToStaticMarkup(
    <CoinSheet
      first={stack.at(-1)!}
      inline={options.inline}
      onClose={() => undefined}
      onCopy={() => undefined}
      onRetry={() => undefined}
      onWithdraw={async () => false}
      open
      session={1}
      trading={options.trading ?? TRADING}
      wallet={options.wallet ?? READY}
    />,
  );
}

test("withdraw picker lists holdings with their balances", () => {
  const withdraw = render([{ kind: "pick", mode: "withdraw" }], {
    wallet: { ...READY, coins: FIXTURE_COINS.map((coin) => (coin.key === "lumn" ? { ...coin, atoms: 0n, amount: 0 } : coin)) } as CoinSheetWallet,
  });
  assert.match(text(withdraw), /Withdraw/);
  assert.deepEqual(buttons(withdraw).slice(1).map((label) => label.split(" ")[0]), ["SUI", "Kestrel", "USDC", "USDsui"]);
});

test("R3-10: the All-coins screen is one of the sheet's screens, with its own head and a way back", () => {
  const html = render([{ kind: "all" }]);
  assert.match(html, /<dialog[^>]*open=""/);
  // The head names the screen and counts what is in it.
  assert.match(text(html), /^Your coins 5 coins · \$3,660 All coins/);
  assert.doesNotMatch(html, /aria-label="Back"/, "the first screen has no back button");
  // Every coin is listed with its star, and the stars are buttons, not decoration.
  assert.equal(html.match(/aria-label="Pin [^"]+ to favourites" aria-pressed="false"/g)?.length, 5);
  assert.doesNotMatch(html, /disabled/, "nothing is starred yet, so no star is at the limit");
});

test("R3-33-AC-10 (§14.2): a coin is its header and one big balance; Trade is the one primary; the price line has no venue; USDC trades too; deeper screens get a back button", () => {
  const sui = render([{ kind: "coin", key: "sui" }]);
  assert.match(text(sui), /^SUI \$3\.42 412\.38 SUI \$1,410\.34 Trade Deposit Withdraw$/);
  assert.match(sui, /<div class="coinTop">.*<h2 id="[^"]+">SUI<\/h2>/, "the name is the sheet's title, in the coin header");
  assert.match(sui, /<div class="coinBal"><b class="num">412\.38\u00a0SUI<\/b><span class="num">\$1,410\.34<\/span><\/div>/);
  const kstl = render([{ kind: "coin", key: "kstl" }]);
  assert.match(text(kstl), /^Kestrel \$0\.0021 · 4\.2× since the presale 600,000 KSTL \$1,260\.00 Trade Deposit Withdraw$/);
  assert.doesNotMatch(kstl, /trades on|Cetus/);
  assert.doesNotMatch(kstl, /aria-label="Back"/, "opening a coin directly starts at the root");
  // USDC is tradable (the old exclusion is gone).
  assert.deepEqual(buttons(render([{ kind: "coin", key: "usdc" }])).slice(1), ["Trade", "Deposit", "Withdraw"]);
  assert.match(text(render([{ kind: "coin", key: "usdc" }])), /Always worth \$1\.00/);
  // Hidden amounts mask the balance; a sale coin whose sale does not trade cannot be traded.
  assert.equal((text(render([{ kind: "coin", key: "sui" }], {})).match(/••••/g) ?? []).length, 0);
  const notTrading = { ...READY, coins: FIXTURE_COINS.map((coin) => (coin.key === "lumn" ? { ...coin, presale: { ...coin.presale!, trading: false } } : coin)) } as CoinSheetWallet;
  assert.match(render([{ kind: "coin", key: "lumn" }], { wallet: notTrading }), /<button[^>]*disabled=""[^>]*>(?:(?!<\/button>).)*Trade<\/button>/);
});

test("Deposit shows the full Sui address and the desktop QR code", () => {
  const deposit = render([{ kind: "dep" }]);
  assert.ok(text(deposit).includes(FIXTURE_WALLET_ADDRESS));
  assert.match(text(deposit), /Sui network/);
  assert.match(deposit, /viewBox="0 0 37 37"/);
  assert.match(deposit, /<button [^>]*aria-label="Copy address"[^>]*data-ui-icon=""/);
  assert.doesNotMatch(deposit, /aria-label="Search your coins"/);
});

test("withdraw: the amount box, the To field and its hint, the terms, the button's states; a wallet the server answers wallet-pays pays its own fee", () => {
  const empty = render([{ kind: "pick", mode: "withdraw" }, { kind: "wd", key: "usdc" }]);
  assert.match(text(empty), /Withdraw USDC Amount Max \$ USDC Available 860 USDC To/);
  assert.match(empty, /placeholder="0x… or name\.sui"/);
  assert.match(text(empty), /Double-check it\. Transfers can’t be reversed\. Network fee Free Arrives In a few seconds Enter an amount/);
  assert.match(text(render([{ kind: "wd", key: "usdc" }], { wallet: { ...READY, fee: "wallet" } as CoinSheetWallet })), /Network fee Free/);
  assert.match(text(render([{ kind: "wd", key: "sui" }])), /Network fee Paid by Blast/);
  assert.match(text(render([{ kind: "wd", key: "sui" }], { wallet: { ...READY, fee: "wallet" } as CoinSheetWallet })), /Network fee Paid from your SUI/);
});

test("R3-33 (Swap board): the trade screen is the universal swap — You sell / You get, the flip, the presets, the detail, the button", () => {
  const html = render([{ kind: "coin", key: "sui" }, { kind: "trade", key: "sui" }]);
  // The board's boxes: the label and balance over the amount and its coin, the dollar value under it.
  // USD estimates stay unavailable until a quote arrives; the button comes before the detail, whose rows start hidden.
  // The ecosystem market link follows the detail (#765).
  assert.match(
    text(html),
    /^Swap Pay Balance 412\.38 SUI SUI — Receive Balance 860 USDC — USDC 25% 50% 75% Max Enter an amount\. Swap$/,
  );
  // The Buy/Sell segmented control and the old labels are gone.
  assert.doesNotMatch(html, /role="tablist"|You pay|Buy or sell|Trading opens soon/);
  assert.match(html, /aria-label="Change sell token \(SUI\)"/);
  assert.match(html, /aria-label="Change receive token \(USDC\)"/);
  assert.match(html, /aria-label="Flip: sell USDC for SUI instead" class="swapFlip" data-flip="" title="Flip"/);
  assert.doesNotMatch(html, /class="[^"]*txSum[^"]*"/, "no quote details before an amount is entered");
  assert.match(html, /<p[^>]* id="([^"]+-cost)">Enter an amount\.<\/p>.*?<button(?=[^>]* aria-describedby="\1")(?=[^>]* data-trade="")(?=[^>]* disabled="")[^>]*>Swap<\/button>/, "the off button keeps its verb and names its reason line");
  // USDC is selectable on the sell side too (R3-33-AC-10).
  assert.match(render([{ kind: "coin", key: "usdc" }, { kind: "trade", key: "usdc" }]), /aria-label="Change sell token \(USDC\)"/);
});

test("Swap refinements stay on the dialog and its coin picker", () => {
  assert.match(render([{ kind: "trade", key: "usdc" }]), /class="[^"]*swapDialog/);
  assert.match(render([{ kind: "pickt", side: "in" }]), /class="[^"]*swapDialog/);
  for (const screen of [{ kind: "fund" }, { kind: "wd", key: "usdc" }, { kind: "dep" }] as const) {
    assert.doesNotMatch(render([screen]), /swapDialog/);
  }
  const inline = render([{ kind: "trade", key: "usdc" }], { inline: true });
  assert.match(inline, /swapDialog/, "inline swaps use the same spacing and typography as the Blast swap sheet");
  assert.doesNotMatch(text(inline), /Price impact|Max slippage|Network fee Paid by Blast/);
  const walletPaid = render([{ kind: "trade", key: "usdc" }], { wallet: { ...READY, fee: "wallet" } });
  assert.doesNotMatch(walletPaid, /Network fee covered/);
  assert.match(text(walletPaid), /Paid from your SUI/);
});

test("wallet loading, setup, errors and visitors keep the forms visible with unavailable balances", () => {
  for (const status of ["loading", "creating", "error", "visitor"] as const) {
    const guest = render([{ kind: "wd", key: "usdc" }], { wallet: { status }, trading: { ...TRADING, signedIn: false } });
    assert.match(guest, /inputMode="decimal"/);
  assert.match(guest, /placeholder="0x… or name\.sui"/);
    assert.match(text(guest), /Available —/);
    assert.match(text(guest), /Sign in to withdraw/);
    assert.doesNotMatch(guest, /860|412\.38/);
  }
  const error = render([{ kind: "pick", mode: "withdraw" }], { wallet: { status: "error" } });
  assert.match(text(error), /Your wallet could not load\. Code: service_unavailable\. Try again/);
});

test("an unavailable coin falls back to the appropriate coin list", () => {
  assert.match(text(render([{ kind: "coin", key: "not-held" }])), /^Your coins/);
  assert.match(text(render([{ kind: "wd", key: "not-held" }])), /^Withdraw/);
});

test("OA-24: All coins has no chevron before the star; the star is each row's one trailing control", () => {
  const html = render([{ kind: "all" }]);
  const rows = [...html.matchAll(/<div class="coinPinrow[^"]*">(.*?)<\/div>(?=<div class="coinPinrow|<\/div>)/g)].map((match) => match[1]!);
  assert.equal(rows.length, 5);
  for (const row of rows) {
    const [main, star] = row.split(/(?=<button aria-label="Pin )/);
    assert.ok(star, "a star after the row's button");
    // The row's button ends with its value: no chevron (or any icon) after it.
    assert.match(main!, /<span class="v"><b class="num">[^<]+<\/b><\/span><\/button>$/);
  }
});

test("UI-14 / visual check 2026-10-05 (COIN-1): the coins sheet is 460px wide at every width, so 760 gets the gate's centred card", () => {
  // The gate's `.sheet.trade { width: min(460px, 100%) }` sits outside its ≤760 rule; on a phone min() is the full width.
  const css = readFileSync(new URL("./coins.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  const top = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  assert.match(top, /\[data-blast-ui\] \.sheet\.sheet \{[^}]*width: min\(460px, 100%\);/);
  assert.ok(![...css.matchAll(/@media[^{]*\{((?:[^{}]*\{[^{}]*\})*)[^{}]*\}/g)].some(([, inner]) => /\.sheet\.sheet[^{]*\{[^}]*width/.test(inner!)), "no width rule for the sheet inside a media query");
});

test("withdraw: USDC goes to a Sui address only, no other chain", () => {
  assert.doesNotMatch(render([{ kind: "wd", key: "usdc" }]), /another chain|To a Sui address/);
});

test("empty wallets show preferred coins at zero and cannot withdraw them", () => {
  const wallet: CoinSheetWallet = { status: "ready", address: FIXTURE_WALLET_ADDRESS, fee: "sponsored", coins: [] };
  const withdraw = render([{ kind: "pick", mode: "withdraw" }], { wallet });
  assert.equal(withdraw.match(/disabled=""/g)?.length, 3);
});
