import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { AppRouterContext, type AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

import { PrivySessionProvider } from "#web/components/presale/providers/PrivySessionProvider.tsx";

const { generateMetadata: settingsMetadata, default: SettingsPage } = await import("../settings/page");
const { default: SignInPage, generateMetadata: signInMetadata } = await import("./page");


function withEnvironment(t: TestContext, values: Record<string, string | undefined>): void {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function backHref(next?: string | string[]): Promise<string> {
  const searchParams = Promise.resolve(next === undefined ? {} : { next });
  const html = renderToStaticMarkup((await SignInPage({ searchParams })) as ReactElement);
  assert.match(html, /<h1 class="sr">Sign in<\/h1>/);
  const hrefs = [...html.matchAll(/<a class="back" href="([^"]*)"/g)].map((match) => match[1]!.replaceAll("&amp;", "&"));
  assert.equal(hrefs.length, 1);
  return hrefs[0]!;
}

test("T-042-AC-1: the sign-in page keeps an allowed next as its return path", async () => {
  assert.equal(await backHref("/"), "/");
  assert.equal(await backHref("/crew/kai"), "/crew/kai");
  assert.equal(await backHref("/presale/0xabc"), "/presale/0xabc");
  assert.equal(await backHref("/settings"), "/settings");
});

test("T-042-AC-1: the sign-in page refuses //evil.example, /admin and a missing next", async () => {
  for (const next of ["//evil.example", "/admin", "https://evil.example/", "/%2Fevil.example", ["/crew/kai", "/admin"], undefined]) {
    assert.equal(await backHref(next), "/", String(next));
  }
});

test("UI-08 (OA-2): inside the Privy session the page is the sign-in sheet's card: Join Blast, X, Google and Other wallets, then Back to next", async () => {
  const page = (await SignInPage({ searchParams: Promise.resolve({ next: "/crew/kai" }) })) as ReactElement;
  const router = { replace: () => undefined, push: () => undefined, prefetch: () => undefined } as unknown as AppRouterInstance;
  const html = renderToStaticMarkup(
    <AppRouterContext value={router}>
      <PrivySessionProvider appId="clsigninfixture0000000000" nonce={null}>
        {page}
      </PrivySessionProvider>
    </AppRouterContext>,
  );
  assert.match(html, /<h1 class="sr">Sign in<\/h1><div class="page"><section aria-labelledby="blast-sign-in-page-title" class="card">/);
  assert.match(html, /<h2 class="title" id="blast-sign-in-page-title">Join Blast<\/h2>/);
  const methods = [...html.matchAll(/<button[^>]*data-sign-in-method="(\w+)"[^>]*>/g)];
  // Wallet sign-in is offered only once the layout says it is configured (a WalletSessionProvider above).
  assert.deepEqual(methods.map((match) => match[1]), ["x", "google", "wallet"]);
  assert.ok(methods.every((match) => !/disabled/.test(match[0])));
  assert.match(html, /<\/section><a class="back" href="\/crew\/kai">Back<\/a><\/div>/);
});

test("UI-99: with the feed on, /sign-in and /settings carry the social title form; off, the site default stays", async () => {
  const before = process.env.BLAST_SOCIAL_ENABLED;
  try {
    process.env.BLAST_SOCIAL_ENABLED = "true";
    assert.deepEqual(await signInMetadata(), { title: { absolute: "Sign in · Blast" } });
    assert.deepEqual(await settingsMetadata(), { title: { absolute: "Settings · Blast" } });
    delete process.env.BLAST_SOCIAL_ENABLED;
    assert.deepEqual(await signInMetadata(), {});
    assert.deepEqual(await settingsMetadata(), {});
  } finally {
    if (before === undefined) delete process.env.BLAST_SOCIAL_ENABLED;
    else process.env.BLAST_SOCIAL_ENABLED = before;
  }
});

/** What `/sign-in` and `/settings` render for the current request: metadata and markup. */
async function pages() {
  const signIn = renderToStaticMarkup((await SignInPage({ searchParams: Promise.resolve({}) })) as ReactElement);
  const settings = await SettingsPage();
  return {
    signInMetadata: await signInMetadata(),
    settingsMetadata: await settingsMetadata(),
    // The root element only: the card itself needs a session provider.
    signInRoot: /^<(main|div)>/.exec(signIn)?.[1],
    // Off, the placeholder `<main>`; on, the canonical UI's screen (not rendered here: it needs the shell).
    settingsPlaceholder: (settings as ReactElement).type === "main",
  };
}

test("launched: BLAST_SOCIAL_ENABLED=team renders the pages as on", async (t) => {
  withEnvironment(t, { BLAST_SOCIAL_ENABLED: "true" });
  const on = await pages();
  delete process.env.BLAST_SOCIAL_ENABLED;
  assert.notDeepEqual(await pages(), on);

  process.env.BLAST_SOCIAL_ENABLED = "team";
  assert.deepEqual(await pages(), on);
});
