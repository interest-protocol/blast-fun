import assert from "node:assert/strict";
import { readFileSync } from "#web/test/css-design-px.ts";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DEFAULT_NOTIFICATION_PREFERENCES, type SocialSettingsResponse } from "@blast/core/modules/social/contracts/settings.ts";

import { LinkWalletSheet } from "./LinkWalletSheet";
import { SettingsView, type SettingsViewProps } from "./SettingsView";

import { FIXTURE_COINS } from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";
import { WalletCardView } from "./WalletCard";

const SETTINGS: SocialSettingsResponse = {
  privacy: "public",
  sharing_since_ms: 1,
  commit_too_coin_type: null,
  public_portfolio: false,
  explorer: "suiscan",
  sound: true,
  blast_mode_confirm_actions: false,
  notifications: { ...DEFAULT_NOTIFICATION_PREFERENCES, unlocks: false },
};
const WALLETS = [
  { address: "0x88e1d0a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c35c907af", kind: "slush" as const, linked_at_ms: Date.UTC(2026, 9, 2, 12) },
  { address: "0x3f9a8c21d04b7e91a2c5f6e8b3d0794c1e2a5b6f8d9c0e1f2a3b4c5d6e7b1c21d", kind: "embedded" as const, linked_at_ms: Date.UTC(2026, 9, 1, 12) },
];
const noop = () => undefined;

function view(props: Partial<SettingsViewProps> = {}): string {
  return renderToStaticMarkup(
    <SettingsView
      callsign="kaimoreno"
      celebrate
      explorer="suiscan"
      mode="account"
      onCelebrate={noop}
      onCopy={noop}
      onExplorer={noop}
      onLinkWallet={noop}
      onLogOut={noop}
      onNotification={noop}
      onPrivate={noop}
      onPublicPortfolio={noop}
      onRetry={noop}
      onSignIn={noop}
      onBlastConfirmation={noop}
      settings={SETTINGS}
      wallets={WALLETS}
      {...props}
    />,
  );
}

const headings = (html: string) => [...html.matchAll(/<h2 class="label" id="[^"]+">([^<]+)<\/h2>/g)].map((match) => match[1]);
const ORDER = ["Appearance", "Notifications", "Transactions", "Privacy", "Wallets", "Account"];
const switches = (html: string) =>
  [...html.matchAll(/<button aria-checked="(true|false)" aria-label="([^"]+)"[^>]*role="switch"/g)].map((match) => [match[2], match[1]]);

test("UI-07 (§7): a signed-in account sees every group, in the Settings board's order, with its rows and switch states", () => {
  const html = view();
  assert.deepEqual(headings(html), ORDER);
  assert.deepEqual(switches(html), [
    ["Opens soon", "true"],
    ["80% filled", "true"],
    ["Last hour", "true"],
    ["Funded", "true"],
    ["Claims open", "true"],
    ["Unlocks", "false"],
    ["People you follow", "true"],
    ["Up since your call", "true"],
    ["Celebrations", "true"],
    ["Confirm Blast mode trades", "false"],
    ["Public portfolio", "false"],
    ["Private account", "false"],
  ]);
  // The board's Theme row: its label, then the shared segmented control.
  assert.match(html, /<b>Theme<\/b><\/span><div aria-label="Theme" class="seg" role="group">/);
  assert.match(html, /<b>Confirm Blast mode trades<\/b><span>Review before every buy and sell<\/span>/);
  assert.match(html, /<b>Public portfolio<\/b><span>Only you can see it<\/span>/);
  assert.match(html, /<b>Private account<\/b><span>Your blasts and claims appear to followers<\/span>/);
  assert.match(html, /<p class="note">Onchain data is public\. A private account can still appear by wallet address in big-move posts, without your name\.<\/p>/);
  // The explorer is the shared select (2026-10-27 redesign), not a segmented control.
  assert.match(html, /<select aria-label="Explorer"[^>]*><option value="suiscan" selected="">Suiscan<\/option><option value="suivision">SuiVision<\/option><\/select>/);
  // Wallets: the Blast wallet first, short addresses, dates, copy labels; then the link row.
  const wallets = html.slice(html.indexOf(">Wallets<"), html.indexOf(">Account<"));
  assert.deepEqual([...wallets.matchAll(/<b>([^<]+)<\/b>/g)].map((match) => match[1]), ["Blast wallet", "Slush", "Link a Sui wallet"]);
  assert.match(wallets, /0x3f9a8c21…e7b1c21d/);
  assert.match(wallets, /0x88e1d0a4…35c907af/);
  assert.match(wallets, /Created Oct 1/);
  assert.match(wallets, /Linked Oct 2/);
  assert.match(wallets, /aria-label="Copy Blast wallet address"/);
  assert.match(wallets, /aria-label="Copy Slush address"/);
  assert.match(wallets, /<b>Link a Sui wallet<\/b>/);
  assert.doesNotMatch(html, /Welcome tour/);
  // The board's "Log out", in red; the account it signs out stays in its accessible name.
  assert.match(html, /aria-label="Log out @kaimoreno"[^>]*><span class="text"><b class="danger">Log out<\/b><\/span><\/button>/);
  assert.equal(html.includes("aria-busy"), false);
});

test("UI-07 (§7): the switches' lines follow their state; privacy is available with a callsign", () => {
  const on = view({ settings: { ...SETTINGS, privacy: "private", public_portfolio: true } });
  assert.match(on, /Blast never shows your name on your actions/);
  assert.match(on, /Anyone can see your balances and holdings/);
  assert.deepEqual(switches(on).slice(-3), [["Confirm Blast mode trades", "false"], ["Public portfolio", "true"], ["Private account", "true"]]);
  const early = view({ callsign: null });
  assert.match(early, /aria-label="Private account" class="switch" disabled=""/);
  assert.match(early, /aria-label="Public portfolio" class="switch" disabled=""/);
});

test("UI-07: loading keeps the groups' shape (aria-busy, placeholders); an error offers a retry; device settings stay usable", () => {
  const loading = view({ mode: "loading", settings: null });
  assert.match(loading, /^<div aria-busy="true" class="set" data-shell-aside="settings" data-surface="">/);
  assert.deepEqual(headings(loading), ORDER);
  assert.deepEqual(switches(loading), [["Celebrations", "true"]]);
  assert.equal((loading.match(/aria-hidden="true" class="text"/g) ?? []).length, 10);
  assert.match(loading, /skeleton fieldSize/);
  const error = view({ mode: "error", settings: null });
  assert.match(error, /role="alert"><p class="title">Your settings couldn’t load<\/p><p class="body">Nothing was changed\. Check your connection, then try again\. Code: request_failed\.<\/p><div class="action"><button type="button"[^>]*>Try again<\/button>/);
  assert.deepEqual(headings(error), ORDER);
  assert.match(error, /Log out @kaimoreno/);
});

test("UI-07: a visitor sees all settings groups while account actions require sign-in", () => {
  const html = view({ mode: "visitor", explorer: "suivision", celebrate: false });
  assert.deepEqual(headings(html), ORDER);
  assert.equal(switches(html).length, 11);
  assert.ok(switches(html).some(([name]) => name === "Private account"));
  assert.match(html, /<option value="suiscan">Suiscan<\/option><option value="suivision" selected="">SuiVision<\/option>/);
  assert.match(html, /<b>Sign in<\/b>/);
  assert.doesNotMatch(html, /Log out|0x3f9a8c21/);
  assert.match(html, /Wallets|Private account/);
  const noAccount = view({ mode: "no-account" });
  assert.match(noAccount, /<b class="danger">Log out<\/b>/);
  assert.doesNotMatch(noAccount, /kaimoreno|0x3f9a8c21|0x88e1d0a4/);
});

test("UI-07 (§14.3): the link sheet is a named modal dialog with the supported Sui wallets", () => {
  const pick = async () => ({ status: "cancelled" as const, message: "x" });
  const idle = renderToStaticMarkup(<LinkWalletSheet onClose={noop} onLinked={noop} onPick={pick} />);
  assert.match(idle, /<dialog aria-labelledby="([^"]+)" aria-modal="true" class="sheet" open="" tabindex="-1"><button aria-label="Close"[^>]*data-ui-icon=""[^>]*>/);
  const titleId = /aria-labelledby="([^"]+)"/.exec(idle)![1];
  // OA-28 M2: the shared `Sheet`'s heading (`SheetHeading`), as every other sheet's.
  assert.match(idle, new RegExp(`<h2 class="title" id="${titleId}">Link a Sui wallet</h2><p class="lead">You&#x27;ll sign one message\\. Nothing is sent and it costs no gas\\.</p>`));
  assert.deepEqual([...idle.matchAll(/<button class="btn btn-line wallet" type="button">.*?(?:<\/span>|<img[^>]+\/>)([A-Za-z]+)<\/button>/g)].map((match) => match[1]), ["Slush", "Suiet", "Phantom", "Nightly", "Scallop", "Mahalo"]);
  // Wallets use their own marks, with neutral monograms when no logo is supplied.
  assert.deepEqual([...idle.matchAll(/<span aria-hidden="true" class="mono">([A-Z])<\/span>([A-Za-z]+)<\/button>/g)].map((match) => `${match[1]} ${match[2]}`), ["S Suiet", "P Phantom"]);
  for (const wallet of ["slush.svg", "nightly.png", "scallop.png", "mahalo.png"]) assert.ok(idle.includes(`src="/blast-ui/wallets/${wallet}"`));
  assert.doesNotMatch(idle.slice(idle.indexOf('<div class="wallets">')), /<svg|<image|sui\.svg/);

});

test("R3-33-AC-11 (Settings board): Your wallet — the total, two tonal coin rows, then Deposit and Withdraw; hidden amounts; loading; a failed read", () => {
  const card = (props: Partial<Parameters<typeof WalletCardView>[0]>) =>
    renderToStaticMarkup(
      <WalletCardView coins={FIXTURE_COINS} hidden={false} onDeposit={noop} onOpen={noop} onWithdraw={noop} pins={[]} value={12480.22} {...props} />,
    );
  const html = card({});
  assert.match(html, /<h2 class="title">Your wallet<\/h2><span class="num total">\$12,480\.22<\/span><div class="rows">/);
  // The address row and the rows' editorial notes are gone (FEATURE-MAP-R3 §14.2).
  assert.doesNotMatch(html, /Blast wallet on Sui|0x3f9a8c21|Ready to commit|Swapped to USDC when you blast|Copy address/);
  // Two coin rows only — USDC and SUI, the coins you blast with — each the shared coin row that opens its sheet.
  const rows = [...html.matchAll(/<button aria-haspopup="dialog" aria-label="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rows, ["USDC, 860\u00a0USDC: deposit, withdraw or trade", "SUI, 412.38\u00a0SUI: deposit, withdraw or trade"]);
  const words = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  assert.equal(words, "Your wallet $12,480.22 USDC Stablecoin $860.00 860 USDC SUI Sui ecosystem $1,410.34 412.38 SUI Deposit Withdraw", "the name over its category, the value over the amount");
  // The board's actions: the shared primary Deposit and secondary Withdraw, each with its icon.
  assert.match(html, /data-ui-variant="primary"[^>]*><svg[^>]*>.*?<\/svg>Deposit<\/button><button[^>]*data-ui-variant="secondary"[^>]*><svg[^>]*>.*?<\/svg>Withdraw<\/button>/);
  // A wallet without a price for every holding shows no total (never an estimate).
  assert.doesNotMatch(card({ value: null }), /class="num total"/);
  // A favourite leads, as in every list of your coins.
  assert.match(card({ pins: ["sui"] }), /aria-label="SUI, [^"]+".*aria-label="USDC, /);
  assert.equal((card({ hidden: true }).match(/••••/g) ?? []).length, 7, "the total, every amount and value masked, the labels too");
  const loading = card({ coins: null });
  assert.match(loading, /aria-busy="true"/);
  assert.equal((loading.match(/class="pulse"/g) ?? []).length, 2);
  assert.doesNotMatch(loading, /class="num total"/);
  assert.match(card({ coins: null, failed: true, onRetry: noop }), /Your wallet could not load\. Nothing changed\. Code: service_unavailable\..*Try again/);
});

test("Settings board: the wallet card's geometry and the shared coin row's tonal fill (no border)", () => {
  const card = readFileSync(new URL("./WalletCard.module.css", import.meta.url), "utf8");
  assert.match(card, /\.card \{ display: flex; flex-direction: column; gap: 12px; padding: 18px; \}/);
  assert.match(card, /\.title \{ margin: 0; font-size: 15px; font-weight: 650;/);
  assert.match(card, /\.total \{ font-family: var\(--display\); font-size: 30px; font-weight: 650;[^}]*letter-spacing: -\.03em; font-variant-numeric: tabular-nums;/);
  assert.match(card, /\.rows \{ display: flex; flex-direction: column; gap: 6px; \}/);
  assert.match(card, /\.actions \{ display: grid; grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\); gap: 8px; \}/);
  const row = readFileSync(new URL("../coins/CoinRow.module.css", import.meta.url), "utf8");
  assert.match(row, /--control-radius: 12px;[^}]*gap: 10px;[^}]*background: var\(--control-field\);/);
  assert.doesNotMatch(row, /border:|box-shadow:/);
  assert.match(row, /grid-template-columns: 30px minmax\(0, 1fr\) auto;[^}]*gap: 10px;[^}]*min-height: 44px;/);
});

test("OA-24: the link sheet's monogram is the gate's `.wmono`: 24px, radius 7, chip on ink-2, 12px bold", () => {
  const css = readFileSync(new URL("./LinkWalletSheet.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /\.mono \{ flex: none; width: 24px; height: 24px; border-radius: var\(--r-inner\); background: var\(--chip\); color: var\(--ink-2\); display: grid; place-items: center; font-size: 12px; font-weight: 700; \}/);
  assert.doesNotMatch(css, /\.mark\b/, "no coin-mark box is left");
});

test("account Settings offers optional Blast Mode confirmation and never shows an unknown read as off", () => {
  assert.match(view(), /aria-checked="false" aria-label="Confirm Blast mode trades"/);
  assert.match(view({ settings: { ...SETTINGS, blast_mode_confirm_actions: true } }), /aria-checked="true" aria-label="Confirm Blast mode trades"/);
  assert.doesNotMatch(view({ mode: "loading", settings: null }), /aria-label="Confirm Blast mode trades"/);
  assert.doesNotMatch(view({ mode: "error", settings: null }), /aria-label="Confirm Blast mode trades"/);
});

test("Hold pays with: the stored coin once the wallet is read, a placeholder while it reads, never a guess when it fails", () => {
  const sui = "0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI";
  const lp = `0x${"a".repeat(64)}::lp::LP<0x2::sui::SUI>`;
  const ready = view({ settings: { ...SETTINGS, commit_too_coin_type: lp }, holdCoins: [{ coinType: sui, symbol: "SUI" }] });
  assert.match(ready, /aria-label="Hold-to-commit coin"/);
  assert.match(ready, /<option value="">Each sale’s coin<\/option><option value="0x0+2::sui::SUI">SUI<\/option><option value="0xa+::lp::LP&lt;0x2::sui::SUI&gt;" selected="">LP<\/option>/);
  for (const holdCoins of ["pending", "error"] as const) assert.doesNotMatch(view({ holdCoins }), /aria-label="Hold-to-commit coin"/);
});

test("failed account settings never invent notification or privacy switch values", () => {
  const html = view({ mode: "error", settings: null });
  const states = switches(html).map(([name]) => name);
  assert.deepEqual(states, ["Celebrations"]);
  assert.match(html, /Your privacy preference could not load/);
  assert.match(html, /Your portfolio visibility could not load/);
  assert.ok((html.match(/Unavailable/g) ?? []).length >= 9);
  assert.match(html, /Inspect full Blast wallet address/);
});
