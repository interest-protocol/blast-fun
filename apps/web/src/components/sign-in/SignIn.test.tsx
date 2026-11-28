import assert from "node:assert/strict";
import test from "node:test";
import { getOrCreateUiWalletForStandardWallet } from "@wallet-standard/ui-registry";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";

import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { Sheet, SheetClose } from "#web/components/blast-ui/Sheet.tsx";

import { SignInCard, SignInContent } from "./SignIn";
import { SIGN_IN_IDLE, type SuiSignInMethod } from "./sign-in-flow";

/** Social UI-08 (FEATURE-MAP §8.2): the sign-in sheet's markup in each state, and the `/sign-in` fallback card. */

const router = { push: () => undefined, replace: () => undefined, prefetch: () => undefined } as unknown as AppRouterInstance;
const render = (node: React.ReactNode) => renderToStaticMarkup(<AppRouterContext value={router}>{node}</AppRouterContext>);
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) => match[0]);
const text = (html: string) => html.replace(/<[^>]+>/g, "");

function walletChoice(name: string): SuiSignInMethod {
  return {
    id: name,
    wallet: getOrCreateUiWalletForStandardWallet({
      name,
      version: "1.0.0",
      icon: "data:image/svg+xml;base64,PHN2Zy8+",
      chains: ["sui:mainnet"],
      features: {},
      accounts: [],
    }),
  };
}

const okx = walletChoice("OKX Wallet");
const slush = walletChoice("Slush");
const wallets = [okx, slush];

test("the sheet places detected Sui wallets between social sign-in and Ethereum and Solana wallets", () => {
  const html = render(<SignInContent state={SIGN_IN_IDLE} suiWallets={wallets} walletAvailable />);
  const document = new JSDOM(html).window.document;
  assert.equal(document.querySelector("h2")?.textContent, "Join Blast");
  const sui = document.querySelector('[role="group"][aria-labelledby]');
  assert.equal(document.getElementById(sui!.getAttribute("aria-labelledby")!)?.textContent, "Sui wallets");
  assert.deepEqual([...sui!.querySelectorAll("button")].map((button) => button.getAttribute("aria-label")), ["Sign in with OKX Wallet", "Sign in with Slush"]);
  assert.equal(sui!.querySelector('img[alt=""]')?.getAttribute("src"), okx.wallet.icon);
  const methods = [...document.querySelectorAll("button")];
  assert.deepEqual(methods.map((button) => button.textContent), ["Continue with X", "Continue with Google", "OKX Wallet", "Slush", "Ethereum & Solana wallets"]);
  assert.equal(methods[0]?.dataset.uiVariant, "ink");
  assert.ok(methods.slice(1).every((button) => button.dataset.uiVariant === "secondary"));
  assert.ok(methods.every((button) => !button.disabled));
  assert.equal(text(html.match(/<p class="fine">.*?<\/p>/)![0]), "By continuing you agree to the Terms and the Privacy Policy.");
  assert.match(html, /href="\/terms"/);
  assert.match(html, /href="\/privacy"/);
  assert.doesNotMatch(html, /role="(alert|status)"/);
});

test("a long Sui wallet list keeps its first four choices visible and provides a disclosure for the rest", () => {
  const more = [walletChoice("Nightly"), walletChoice("Scallop Wallet"), walletChoice("Suiet")];
  const html = render(<SignInContent state={SIGN_IN_IDLE} suiWallets={[okx, ...more, slush]} walletAvailable />);
  const document = new JSDOM(html).window.document;
  const disclosure = [...document.querySelectorAll("button")].find((button) => button.textContent === "See all Sui wallets");
  assert.equal(disclosure?.getAttribute("aria-expanded"), "false");
  const extras = disclosure && document.getElementById(disclosure.getAttribute("aria-controls")!);
  assert.equal(extras?.hidden, true);
  assert.equal(disclosure?.nextElementSibling, extras, "Tab from the disclosure can reach the extra wallets when opened");
  assert.deepEqual([...document.querySelectorAll('[role="group"] button[data-sign-in-method]')].filter((button) => !button.closest("[hidden]")).map((button) => button.textContent), ["OKX Wallet", "Nightly", "Scallop Wallet", "Suiet"]);
});

test("pending wallet discovery reserves a wallet row without disabling other methods", () => {
  const html = render(<SignInContent state={SIGN_IN_IDLE} walletAvailable />);
  const document = new JSDOM(html).window.document;
  const pending = document.querySelector('[role="status"][aria-label="Finding Sui wallets"]');
  assert.equal(pending?.getAttribute("aria-busy"), "true");
  assert.equal(pending?.querySelectorAll(".walletSkeleton[aria-hidden=true]").length, 2);
  assert.equal(document.querySelector<HTMLButtonElement>('[data-sign-in-method="wallet"]')?.disabled, false);
});

test("wallet discovery failure offers an in-place retry", () => {
  const html = render(<SignInContent onRetryWallets={() => undefined} state={SIGN_IN_IDLE} suiWallets="unavailable" walletAvailable />);
  const document = new JSDOM(html).window.document;
  const error = document.querySelector('[role="alert"]');
  assert.match(error?.textContent ?? "", /Sui wallets could not load/);
  assert.equal(error?.querySelector(".err-code")?.textContent, "Code: authentication_unavailable.");
  assert.equal(error?.querySelector("button")?.textContent, "Try again");
});

test("UI-08: without Sui wallet sign-in configured the sheet drops Sui wallets", () => {
  const html = render(<SignInContent state={SIGN_IN_IDLE} walletAvailable={false} />);
  assert.deepEqual(buttons(html).map(text), ["Continue with X", "Continue with Google", "Ethereum &amp; Solana wallets"]);
});

test("UI-08: pressing a method disables all methods and shows a spinner with Waiting for <method>", () => {
  for (const [method, label] of [
    ["x", "Waiting for X"],
    ["google", "Waiting for Google"],
    [okx, "Waiting for OKX Wallet"],
    ["wallet", "Waiting for your wallet"],
  ] as const) {
    const html = render(<SignInContent state={{ status: "waiting", method }} suiWallets={wallets} walletAvailable />);
    const methods = buttons(html);
    assert.ok(methods.every((button) => /disabled=""/.test(button)), label);
    const waiting = methods.find((button) => text(button) === label);
    assert.ok(waiting, label);
    assert.match(waiting, /aria-busy="true"/);
    assert.match(waiting, /<span aria-hidden="true" class="spin"><\/span>/);
    assert.equal(methods.filter((button) => /aria-busy/.test(button)).length, 1);
  }
});

test("UI-08: a cancel is a polite status; a failure is an alert; the methods work again", () => {
  const cancelled = render(<SignInContent state={{ status: "cancelled", method: "x" }} suiWallets={wallets} walletAvailable />);
  assert.match(cancelled, /<p class="message" role="status">Sign-in was cancelled\. You are still signed out\. Code: request_cancelled\.<\/p>/);
  assert.ok(buttons(cancelled).every((button) => !/disabled/.test(button)));
  const failed = render(<SignInContent state={{ status: "failed", method: okx }} suiWallets={wallets} walletAvailable />);
  assert.match(failed, /role="alert">Sign-in did not finish\. You are still signed out\. Try again\. Code: authentication_unavailable\.<\/p>/);
});

test("UI-08: as a sheet it is a labelled modal dialog with a Close button", () => {
  const html = render(
    <Sheet labelledBy="blast-sign-in-title" onRequestClose={() => undefined} open>
      <SheetClose onClick={() => undefined} />
      <SignInContent state={SIGN_IN_IDLE} walletAvailable />
    </Sheet>,
  );
  assert.match(html, /<div class="scrim" data-sheet-scrim=""><dialog aria-labelledby="blast-sign-in-title" aria-modal="true" class="sheet" open="" tabindex="-1">/);
  assert.ok(new JSDOM(html).window.document.querySelector('dialog button.close[aria-label="Close"][type="button"]'));
  assert.equal(render(<Sheet labelledBy="x" onRequestClose={() => undefined} open={false}><p>hidden</p></Sheet>), "");
});

test("UI-08: /sign-in without a Privy session shows the card, says sign-in is unavailable, and keeps Back", () => {
  const html = render(<SignInCard returnTo="/@kai" />);
  assert.match(html, /<section aria-labelledby="blast-sign-in-page-title" class="card">/);
  assert.match(html, />Join Blast</);
  assert.match(html, /role="status">Sign-in is not available right now\. You can keep reading as a visitor\.<\/p>/);
  assert.match(html, /<a class="back" href="\/@kai">Back<\/a>/);
  assert.deepEqual(buttons(html).map(text), ["Continue with X", "Continue with Google", "Ethereum &amp; Solana wallets"]);
  assert.ok(buttons(html).every((button) => /disabled=""/.test(button)));
});

test("a browser without an extension can sign in with Slush Web", () => {
  const html = render(<SignInContent state={SIGN_IN_IDLE} suiWallets={[slush]} walletAvailable />);
  assert.deepEqual(buttons(html).map(text), ["Continue with X", "Continue with Google", "Slush", "Ethereum &amp; Solana wallets"]);
});
