import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test, { mock } from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { waitFor } from "#web/test/fixtures/social/test-dom.ts";

// The SDK stands in for Privy: it counts mounts and starts signed in as principal-A.
// While `fail` is set, its chunk does not load. `start` is how a mounted SDK ends:
// ready, a reported error, or no answer yet (`live` lets the test answer later).
type Start = Readonly<{ publish: (runtime: unknown) => void }>;
const sdk = { mounts: 0, fail: false, start: "ready" as "ready" | "error" | "hang", live: null as Start | null };
const signedIn = { authenticated: true, user: { id: "principal-A" }, getAccessToken: async () => "token-A" };
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
          export default function Runtime({ start }) {
            useEffect(() => {
              globalThis.privySessionSdk.mounts++;
              globalThis.privySessionSdk.live = start;
              const outcome = globalThis.privySessionSdk.start;
              if (outcome === "error") start.fail();
              if (outcome === "ready") start.publish({ authenticated: true, user: { id: "principal-A" }, getAccessToken: async () => "token-A" });
              return () => start.publish(null);
            }, [start]);
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
const { PRIVY_CLICK_TIMEOUT_MS, startPrivy, usePrivySession } = await import("#web/components/auth/privy-session.ts");

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

/** Flushes React and pending promises without timers, for tests that mock `setTimeout`. */
async function settle(condition: () => unknown, description: string) {
  for (let round = 0; round < 1000; round++) {
    if (condition()) return;
    await act(async () => new Promise((resolve) => setImmediate(resolve)));
  }
  assert.fail(`timed out waiting for ${description}`);
}

/** Lets every pending render and promise run. */
async function flush() {
  for (let round = 0; round < 20; round++) await act(async () => new Promise((resolve) => setImmediate(resolve)));
}

test("a Privy that reports an error rejects the waiting sign-in, and the next sign-in mounts a fresh one", async () => {
  sdk.start = "error";
  const page = await mount("https://blast.test/feed", {});
  try {
    const mounts = sdk.mounts;
    let failure: unknown = null;
    await act(async () => {
      page.current().load().catch((error: unknown) => (failure = error));
    });
    await waitFor(() => failure, "the start to fail");
    assert.match(String(failure), /Privy did not start/);
    assert.equal(page.current().ready, true);
    assert.equal(page.current().authenticated, false);

    sdk.start = "ready";
    let second!: ReturnType<Session["load"]>;
    await act(async () => {
      second = page.current().load();
    });
    await waitFor(() => page.current().runtime, "the SDK to start");
    assert.equal((await second).authenticated, true);
    assert.equal(sdk.mounts, mounts + 2);
  } finally {
    sdk.start = "ready";
    await page.close();
  }
});

test("a click gives up after 15 s, but Privy keeps starting and the page ends signed in", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  sdk.start = "hang";
  const page = await mount("https://blast.test/feed", {});
  try {
    const mounts = sdk.mounts;
    let failure: unknown = null;
    await act(async () => {
      startPrivy(page.current().load).catch((error: unknown) => (failure = error));
    });
    await settle(() => sdk.mounts > mounts, "the SDK to mount");
    await act(async () => mock.timers.tick(PRIVY_CLICK_TIMEOUT_MS - 1));
    await flush();
    assert.equal(failure, null);
    await act(async () => mock.timers.tick(1));
    await settle(() => failure, "the click to time out");
    assert.match(String(failure), /taking too long/);

    // The SDK was not unmounted or marked failed: its late answer signs the page in.
    await act(async () => sdk.live!.publish(signedIn));
    assert.equal(page.current().authenticated, true);
    assert.equal(sdk.mounts, mounts + 1);
  } finally {
    sdk.start = "ready";
    mock.timers.reset();
    await page.close();
  }
});

test("a restored session whose Privy takes over 15 s stays pending, then ends signed in", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  sdk.start = "hang";
  const mounts = sdk.mounts;
  const page = await mount("https://blast.test/feed", {}, true);
  try {
    await settle(() => sdk.mounts > mounts, "the SDK to mount");
    await act(async () => mock.timers.tick(60_000));
    await flush();
    assert.equal(page.current().ready, false);

    await act(async () => sdk.live!.publish(signedIn));
    assert.equal(page.current().authenticated, true);
    assert.equal(sdk.mounts, mounts + 1);
  } finally {
    sdk.start = "ready";
    mock.timers.reset();
    await page.close();
  }
});

test("a click that starts Privy in time clears its timer", async () => {
  const set = mock.method(globalThis, "setTimeout");
  const clear = mock.method(globalThis, "clearTimeout");
  try {
    const runtime = await startPrivy(async () => signedIn as never);
    assert.equal(runtime, signedIn);
    assert.equal(set.mock.callCount(), 1);
    assert.deepEqual(clear.mock.calls.map((call) => call.arguments[0]), [set.mock.calls[0]!.result]);
  } finally {
    set.mock.restore();
    clear.mock.restore();
  }
});

test("a session cookie whose Privy fails to start ends signed out, not pending", async () => {
  sdk.start = "error";
  const page = await mount("https://blast.test/feed", {}, true);
  try {
    await waitFor(() => page.current().ready, "the failed start to settle");
    assert.equal(page.current().authenticated, false);
    assert.equal(page.current().runtime, null);
  } finally {
    sdk.start = "ready";
    await page.close();
  }
});

test("unmounting the page rejects a sign-in still waiting for Privy", async () => {
  sdk.start = "hang";
  const page = await mount("https://blast.test/feed", {});
  let failure: unknown = null;
  try {
    await act(async () => {
      page.current().load().catch((error: unknown) => (failure = error));
    });
  } finally {
    sdk.start = "ready";
    await page.close();
  }
  await waitFor(() => failure, "the waiting load to reject");
  assert.match(String(failure), /Privy stopped/);
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
