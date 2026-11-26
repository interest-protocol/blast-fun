import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { waitFor } from "#web/test/fixtures/social/test-dom.ts";

// The SDK stands in for Privy: it counts loads and starts signed in as principal-A.
const sdk = { loads: 0 };
Object.assign(globalThis, { privySessionSdk: sdk });
const reactUrl = import.meta.resolve("react");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./PrivySessionRuntime.tsx") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(`
          import { useEffect } from ${JSON.stringify(reactUrl)};
          globalThis.privySessionSdk.loads++;
          export default function Runtime({ onChange }) {
            useEffect(() => {
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

test("a signed-out visitor reads ready and signed out without loading Privy, until a sign-in asks for it", async () => {
  const page = await mount("https://blast.test/feed", {});
  try {
    assert.equal(page.current().ready, true);
    assert.equal(page.current().authenticated, false);
    assert.equal(await page.current().getAccessToken(), null);
    assert.equal(sdk.loads, 0);

    await act(async () => page.current().load());
    await waitFor(() => page.current().runtime, "the SDK to start");
    assert.equal(sdk.loads, 1);
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
