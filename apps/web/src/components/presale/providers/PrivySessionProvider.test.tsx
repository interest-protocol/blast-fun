import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { waitFor } from "#web/test/fixtures/social/test-dom.ts";

// The SDK stands in for Privy: it counts mounts and starts signed in as principal-A.
// While `fail` is set, its chunk does not load.
const sdk = { mounts: 0, fail: false };
Object.assign(globalThis, { privySessionSdk: sdk });
const reactUrl = import.meta.resolve("react");
let attempts = 0;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./PrivySessionRuntime.tsx") {
      // A fresh URL per import, so a retry loads the chunk again.
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(`
          import { useEffect } from ${JSON.stringify(reactUrl)};
          // attempt ${++attempts}
          if (globalThis.privySessionSdk.fail) throw new Error("chunk failed");
          export default function Runtime({ onChange }) {
            useEffect(() => {
              globalThis.privySessionSdk.mounts++;
              onChange({ authenticated: true, user: { id: "principal-A" }, getAccessToken: async () => "token-A" });
              return () => onChange(null);
            }, [onChange]);
            return null;
          }
        `)}`,
      };
    }
    return nextResolve(specifier, context);
  },
});
// next/dynamic decides at import whether it runs in a browser.
Object.assign(globalThis, { window: new JSDOM("").window });
const { PrivySessionProvider } = await import("./PrivySessionProvider.tsx");
const { usePrivySession } = await import("#web/components/auth/privy-session.ts");

type Session = ReturnType<typeof usePrivySession>;

async function mount(url: string, storage: Record<string, string>, sessionCookie = false) {
  const dom = new JSDOM('<div id="mount"></div>', { url });
  for (const [key, value] of Object.entries(storage)) dom.window.localStorage.setItem(key, value);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("mount")!);
  const seen: Session[] = [];
  function Reader() {
    seen.push(usePrivySession());
    return null;
  }
  await act(async () => root.render(<PrivySessionProvider appId="app" nonce={null} sessionCookie={sessionCookie}><Reader /></PrivySessionProvider>));
  const close = async () => {
    await act(async () => root.unmount());
    dom.window.close();
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
  };
  return { seen, current: () => seen.at(-1)!, close };
}

// First: the page's first chunk load is the one that fails.
test("a chunk that fails to load rejects the waiting sign-in at once, and the next sign-in loads it again", async () => {
  sdk.fail = true;
  const page = await mount("https://blast.test/feed", {});
  try {
    let failure: unknown = null;
    await act(async () => {
      page.current().load().catch((error: unknown) => (failure = error));
    });
    await waitFor(() => failure, "the failed load to reject");
    assert.match(String(failure), /Privy did not start/);
    assert.equal(page.current().ready, true);
    assert.equal(page.current().authenticated, false);

    sdk.fail = false;
    let second!: ReturnType<Session["load"]>;
    await act(async () => {
      second = page.current().load();
    });
    await waitFor(() => page.current().runtime, "the SDK to start");
    assert.equal((await second).authenticated, true);
    assert.equal(page.current().authenticated, true);
  } finally {
    sdk.fail = false;
    await page.close();
  }
});

test("a signed-out visitor reads ready and signed out without loading Privy, until a sign-in asks for it", async () => {
  const mounts = sdk.mounts;
  const page = await mount("https://blast.test/feed", {});
  try {
    assert.equal(page.current().ready, true);
    assert.equal(page.current().authenticated, false);
    assert.equal(await page.current().getAccessToken(), null);
    assert.equal(sdk.mounts, mounts);

    // Privy's start commits outside this act, so the load is awaited after it.
    let started!: ReturnType<Session["load"]>;
    await act(async () => {
      started = page.current().load();
    });
    await waitFor(() => page.current().runtime, "the SDK to start");
    assert.equal((await started).authenticated, true);
    assert.equal(sdk.mounts, mounts + 1);
    assert.equal(page.current().authenticated, true);
    assert.equal(await page.current().getAccessToken(), "token-A");
  } finally {
    await page.close();
  }
});


for (const [name, url, storage, cookie] of [
  ["a stored Privy session", "https://blast.test/feed", { "privy:refresh_token": "\"r\"" }, false],
  ["a session cookie on the request", "https://blast.test/feed", {}, true],
  ["an OAuth sign-in returning", "https://blast.test/feed?privy_oauth_code=c&privy_oauth_state=s", {}, false],
  ["a mobile wallet sign-in returning", "https://blast.test/feed?privy_connector=solana_adapter&privy_wallet_client=phantom&privy_connect_only=false", {}, false],
] as const) {
  test(`${name} restores the session: pending, never signed out, until Privy starts`, async () => {
    const page = await mount(url, storage, cookie);
    try {
      await waitFor(() => page.current().runtime, "the SDK to start");
      const before = page.seen.filter((session) => !session.runtime);
      assert.ok(before.length > 0);
      assert.ok(before.every((session) => !session.ready), "no signed-out reading before Privy answers");
      assert.equal(page.current().authenticated, true);
    } finally {
      await page.close();
    }
  });
}
