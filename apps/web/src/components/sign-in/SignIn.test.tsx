import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { renderToStaticMarkup } from "react-dom/server";

import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { Sheet, SheetClose } from "#web/components/blast-ui/Sheet.tsx";

import { SignInCard, SignInContent } from "./SignIn";
import { SIGN_IN_IDLE } from "./sign-in-flow";

/** Social UI-08 (FEATURE-MAP §8.2): the sign-in sheet's markup in each state, and the `/sign-in` fallback card. */

const router = { push: () => undefined, replace: () => undefined, prefetch: () => undefined } as unknown as AppRouterInstance;
const render = (node: React.ReactNode) => renderToStaticMarkup(<AppRouterContext value={router}>{node}</AppRouterContext>);
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) => match[0]);
const text = (html: string) => html.replace(/<[^>]+>/g, "");

test("UI-08 (OA-12): the sheet shows the helmet, Join Blast, Sui wallet methods, Other wallets, and the fine print", () => {
  const html = render(<SignInContent state={SIGN_IN_IDLE} walletAvailable />);
  assert.match(html, /<h2[^>]*id="blast-sign-in-title"[^>]*>Join Blast<\/h2>/);
  assert.doesNotMatch(html, /See which presales people back/);
  assert.match(html, />Sui wallets<\/p>/);
  assert.match(html, /aria-label="Sui wallets" class="walletGroup" role="group"/);
  for (const name of ["Slush", "Nightly", "Scallop", "Mahalo"]) assert.ok(html.includes(`aria-label="Connect ${name} wallet"`));
  for (const wallet of ["slush.svg", "nightly.png", "scallop.png", "mahalo.png"]) {
    assert.ok(html.includes(`src="/blast-ui/wallets/${wallet}"`));
    assert.match(html, /<img alt="" aria-hidden="true"/);
  }
  const methods = buttons(html);
  assert.deepEqual(methods.map(text), ["Continue with X", "Continue with Google", "Slush", "Nightly", "Scallop", "Mahalo", "Other wallets"]);
  assert.match(methods[0]!, /data-ui-size="lg" data-ui-variant="ink"/, "X keeps the approved ink emphasis through the shared Button");
  for (const row of methods.slice(1)) assert.match(row, /data-ui-size="lg" data-ui-variant="secondary"/, "every other method is a shared secondary row");
  assert.ok(methods.every((button) => !/disabled/.test(button) && /<svg|<img/.test(button)));
  assert.equal(text(html.match(/<p class="fine">.*?<\/p>/)![0]), "By continuing you agree to the Terms and the Privacy Policy.");
  assert.match(html, /href="\/terms"/);
  assert.match(html, /href="\/privacy"/);
  assert.doesNotMatch(html, /role="(alert|status)"/);
});

test("UI-08: without Sui wallet sign-in configured the sheet drops Sui wallets", () => {
  const html = render(<SignInContent state={SIGN_IN_IDLE} walletAvailable={false} />);
  assert.deepEqual(buttons(html).map(text), ["Continue with X", "Continue with Google", "Other wallets"]);
});

test("UI-08: pressing a method disables all methods and shows a spinner with Waiting for <method>", () => {
  for (const [method, label] of [
    ["x", "Waiting for X"],
    ["google", "Waiting for Google"],
    ["slush", "Waiting for Slush"],
    ["nightly", "Waiting for Nightly"],
    ["scallop", "Waiting for Scallop"],
    ["mahalo", "Waiting for Mahalo"],
    ["wallet", "Waiting for your wallet"],
  ] as const) {
    const html = render(<SignInContent state={{ status: "waiting", method }} walletAvailable />);
    const methods = buttons(html);
    assert.ok(methods.every((button) => /disabled=""/.test(button)), method);
    const waiting = methods.find((button) => text(button) === label);
    assert.ok(waiting, label);
    assert.match(waiting, /aria-busy="true"/);
    assert.match(waiting, /<span aria-hidden="true" class="spin"><\/span>/);
    assert.equal(methods.filter((button) => /aria-busy/.test(button)).length, 1);
  }
});

test("UI-08: a cancel is a polite status; a failure is an alert; the methods work again", () => {
  const cancelled = render(<SignInContent state={{ status: "cancelled", method: "x" }} walletAvailable />);
  assert.match(cancelled, /<p class="message" role="status">Sign-in was cancelled\. You are still signed out\. Code: request_cancelled\.<\/p>/);
  assert.ok(buttons(cancelled).every((button) => !/disabled/.test(button)));
  const failed = render(<SignInContent state={{ status: "failed", method: "slush" }} walletAvailable />);
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
  assert.deepEqual(buttons(html).map(text), ["Continue with X", "Continue with Google", "Other wallets"]);
  assert.ok(buttons(html).every((button) => /disabled=""/.test(button)));
});

test("failed extension sign-in offers the selected wallet's install link", () => {
  for (const [method, url] of [
    ["nightly", "https://nightly.app/download"],
    ["scallop", "https://chromewebstore.google.com/detail/scallop-wallet/cofjeilfnmicgcolcdjljnnmonmknfbb"],
    ["mahalo", "https://chromewebstore.google.com/detail/mahalo/glahhddncffoeohapgmkadbiabknoieb"],
  ] as const) {
    const html = render(<SignInContent state={{ status: "failed", method }} walletAvailable />);
    assert.ok(html.includes(`href="${url}"`));
    assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  }
});
