import assert from "node:assert/strict";
import test from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { GatedAction, SignInLink, SocialViewerProvider } from "./SignInGate";
import { signInHref } from "./sign-in-gate";
import { SocialShell } from "./SocialShell";
import { SocialAccountContext } from "./use-social-account";

const router = { push: () => undefined, replace: () => undefined, prefetch: () => undefined } as unknown as AppRouterInstance;

/** Renders the shell (it needs the app router) at `pathname`. */
function shellAt(pathname: string, node: ReactNode): string {
  return renderToStaticMarkup(
    <AppRouterContext value={router}>
      <PathnameContext value={pathname}><SocialAccountContext value={{ status: "signed_out", account: null, refresh: () => undefined }}>{node}</SocialAccountContext></PathnameContext>
    </AppRouterContext>,
  );
}

/** Renders `node` as the app router would at `pathname`. */
function at(pathname: string, node: ReactNode): string {
  return renderToStaticMarkup(<PathnameContext value={pathname}>{node}</PathnameContext>);
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&"));
}

test("T-006-AC-3: signInHref names /sign-in with the current path URL-encoded as next", () => {
  assert.equal(signInHref("/"), "/sign-in?next=%2F");
  // The server renders a profile at its rewrite target: it links like the browser's `/@kai` (OA-4).
  assert.equal(signInHref("/crew/kai"), "/sign-in?next=%2F%40kai");
  assert.equal(signInHref("/@kai"), "/sign-in?next=%2F%40kai");
  assert.equal(signInHref("/crew/k ai&x=1"), "/sign-in?next=%2F%40k%20ai%26x%3D1");
  assert.equal(signInHref("/crew/kai/x"), "/sign-in?next=%2Fcrew%2Fkai%2Fx");
  // Never another origin: anything that is not a same-origin path returns to `/`.
  for (const path of [null, undefined, "", "crew/kai", "//evil.example", "/\\evil.example", "https://evil.example/"]) {
    assert.equal(signInHref(path), "/sign-in?next=%2F", String(path));
  }
  // The server renders the feed at its rewrite target: it links like the browser's `/`, so hydration matches.
  assert.equal(signInHref("/feed"), "/sign-in?next=%2F");
  assert.equal(signInHref("/feed/x"), "/sign-in?next=%2Ffeed%2Fx");
  assert.equal(signInHref("/feed/"), "/sign-in?next=%2Ffeed%2F");
  assert.equal(signInHref("/crew/kai/"), "/sign-in?next=%2Fcrew%2Fkai%2F");
  assert.equal(signInHref("/@kai/"), "/sign-in?next=%2F%40kai%2F");
});

test("T-006-AC-3: a visitor's gated control on a profile path links to sign-in with next=%2F%40kai", () => {
  const html = at("/crew/kai", <GatedAction>Follow</GatedAction>);
  assert.match(html, /^<a /);
  assert.deepEqual(hrefs(html), ["/sign-in?next=%2F%40kai"]);
  assert.match(html, />Follow<\/a>$/);
  assert.match(html, /data-gated="sign-in"/);
});

test("T-006-AC-3: a visitor's gated control on the home page sends them to /sign-in?next=%2F", () => {
  const html = at("/", <GatedAction>Follow</GatedAction>);
  assert.deepEqual(hrefs(html), ["/sign-in?next=%2F"]);
});

test("a signed-in viewer gets a button that acts instead of a sign-in link", () => {
  const html = at(
    "/crew/kai",
    <SocialViewerProvider signedIn>
      <GatedAction>Follow</GatedAction>
      <SignInLink />
    </SocialViewerProvider>,
  );
  assert.equal(html, '<button type="button">Follow</button>');
  // Explicitly a visitor: the gate again.
  const visitor = at("/crew/kai", <SocialViewerProvider signedIn={false}><GatedAction>Follow</GatedAction></SocialViewerProvider>);
  assert.deepEqual(hrefs(visitor), ["/sign-in?next=%2F%40kai"]);
});

test("the shell: a visitor gets the top bar's Sign in, the page in <main>, the tab bar, and an empty right column", () => {
  const html = shellAt("/crew/kai", <SocialShell rail={null}>main content</SocialShell>);
  assert.match(html, /<nav aria-label="Primary"/);
  assert.match(html, /<main[^>]*id="main"[^>]*>.*main content.*<\/main>/s);
  assert.match(html, /<nav aria-label="Tabs"/);
  assert.equal(hrefs(html).filter((href) => href === "/sign-in?next=%2F%40kai").length, 1, "the top bar's Sign in");
  assert.match(html, /<nav aria-label="Tabs"[^>]*>.*href="\/portfolio"[^>]*>.*Portfolio.*<\/nav>/s);
  assert.match(html, /<a[^>]*href="\/sign-in\?next=%2F%40kai"[^>]*>Sign in<\/a>/);
  assert.match(html, /<aside aria-label="What&#x27;s happening"[^>]*><div[^>]*><\/div><\/aside>/);
  assert.ok(!html.includes("Log out"));
  // Home draws no right column (the coin-centred Home takes the width); other routes retain their right column.
  const home = shellAt("/feed", <SocialShell banner={<p>Notice</p>} rail={<p>Rail</p>}>main</SocialShell>);
  assert.match(home, /<p>Notice<\/p><div[^>]*id="view"/);
  assert.match(home, /<div class="shell"[^>]*data-no-aside="true"/);
  assert.ok(!home.includes("What&#x27;s happening") && !home.includes("<p>Rail</p>"));
  const filled = shellAt("/crew/kai", <SocialShell banner={<p>Notice</p>} rail={<p>Rail</p>}>main</SocialShell>);
  assert.match(filled, /<p>Notice<\/p><div[^>]*id="view"/);
  assert.match(filled, /<aside aria-label="What&#x27;s happening".*<p>Rail<\/p>/s);
});

const signOutNoop = () => Promise.resolve();

test("OA-2: a signed-in viewer's shell offers no Sign in (the account menu holds Log out once the account loads)", () => {
  const html = shellAt(
    "/crew/kai",
    <SocialViewerProvider signedIn signOut={signOutNoop}>
      <SocialShell>main</SocialShell>
    </SocialViewerProvider>,
  );
  assert.ok(!hrefs(html).some((href) => href.startsWith("/sign-in?") && href !== "/sign-in?next=%2F%40kai"));
  assert.ok(!html.includes(">Sign in<"));
  // The account menu (base-ui, OA-28 M2b) is not in the server's HTML: it renders once its chip opens it.
  assert.doesNotMatch(html, /role="menu"/);
  const visitor = shellAt("/crew/kai", <SocialShell>main</SocialShell>);
  assert.ok(!visitor.includes("Log out"));
  assert.match(visitor, />Sign in<\/a>/);
});
