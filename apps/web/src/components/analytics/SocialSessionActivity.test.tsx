import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";

import { QueryProvider } from "#web/lib/query/provider.tsx";
import { waitFor } from "#web/test/fixtures/social/test-dom.ts";

const privy = {
  ready: true,
  authenticated: true,
  user: { id: "principal-A" },
  getAccessToken: async (): Promise<string | null> => privy.user.id,
  logout: async () => {},
};
Object.assign(globalThis, { activityFixturePrivy: privy });
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith("/privy-session.ts")) {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const usePrivySession=()=>globalThis.activityFixturePrivy;",
      };
    }
    return nextResolve(specifier, context);
  },
});
const { SocialSession } = await import("../social/SocialSession.tsx");
const { useSocialAccount } = await import("../social/use-social-account.ts");
const { SOCIAL_WALLET_HINT_COOKIE } = await import(
  "@blast/core/modules/social/contracts/wallet-sign-in.ts"
);

// Drain scheduled React/Promise work without an elapsed-time sleep.
const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));

test("the real SocialSession mount is default-off and consumes its one settled account with explicit Privy or wallet provenance", async () => {
  const dom = new JSDOM('<div id="mount"></div>', {
    url: "https://blast.test",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("mount")!);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const originalFetch = globalThis.fetch;
  const originalFlag = process.env.NEXT_PUBLIC_ANALYTICS_ACCOUNT_ACTIVITY_ENABLED;
  delete process.env.NEXT_PUBLIC_ANALYTICS_ACCOUNT_ACTIVITY_ENABLED;
  let tokens = 0;
  let reads = 0;
  let readyAccount: string | null = null;
  let resolveAccount!: (value: Response) => void;
  let current!: ReturnType<typeof useSocialAccount>;
  const requests: RequestInit[] = [];
  const listeners = new Set<string>();
  const add = document.addEventListener.bind(document);
  const remove = document.removeEventListener.bind(document);
  document.addEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ) => {
    if (["visibilitychange", "pointerdown", "keydown"].includes(type)) {
      listeners.add(type);
    }
    add(type, listener, options);
  }) as typeof document.addEventListener;
  document.removeEventListener = ((
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | EventListenerOptions,
  ) => {
    listeners.delete(type);
    remove(type, listener, options);
  }) as typeof document.removeEventListener;
  privy.getAccessToken = async () => {
    tokens += 1;
    return privy.user.id;
  };
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("/analytics/activity")) {
      requests.push(init!);
      return new Response(null, { status: 204 });
    }
    if (String(url).endsWith("x-handle")) {
      return Response.json({ updated: false });
    }
    reads += 1;
    if (readyAccount) {
      return accountResponse(readyAccount);
    }
    return new Promise((resolve) => {
      resolveAccount = resolve;
    });
  };
  function Probe() {
    current = useSocialAccount();
    return <span>{current.status}</span>;
  }
  async function render() {
    await act(async () => {
      root.render(
        <QueryProvider client={client}>
          <SocialSession>
            <Probe />
          </SocialSession>
        </QueryProvider>,
      );
    });
  }
  function accountResponse(accountId: string) {
    return Response.json({
      account: {
        account_id: accountId,
        kind: "new",
        callsign: "pilot",
        display_name: null,
        avatar_url: null,
        x_handle: null,
        verified: false,
        onboarding: { shown: false, completed: false },
        privacy: "public",
        sharing_since_ms: null,
        wallets: [],
      },
    });
  }
  async function settle(accountId: string) {
    readyAccount = accountId;
    await act(async () => resolveAccount(accountResponse(accountId)));
    await waitFor(() => current.status === "ready", "the existing account to settle", 3_000);
  }
  try {
    await render();
    await waitFor(() => reads === 1, "one shared account lookup", 3_000);
    assert.equal(current.status, "loading");
    await settle("00000000-0000-4000-8000-000000000001");
    const priorTokens = tokens;
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await nextTask();
    assert.equal(requests.length, 0);
    assert.equal(tokens, priorTokens, "disabled collection adds no token read");
    assert.equal(listeners.size, 0);
    process.env.NEXT_PUBLIC_ANALYTICS_ACCOUNT_ACTIVITY_ENABLED = "true";
    await render();
    await waitFor(() => requests.length === 1, "enabled activity", 3_000);
    assert.equal(reads, 1, "enabling collection does not load the account again");
    assert.equal(new Headers(requests[0]!.headers).get("Authorization"), "Bearer principal-A");
    assert.equal(requests[0]!.body, undefined);
    readyAccount = null;
    privy.user = { id: "principal-B" };
    await render();
    await waitFor(() => reads === 2, "new principal account lookup", 3_000);
    assert.equal(current.status, "loading");
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await nextTask();
    assert.equal(requests.length, 1, "loading never emits for A's cached account");
    await act(async () =>
      resolveAccount(Response.json({ error: { code: "unauthorized" } }, { status: 401 })),
    );
    await waitFor(() => current.sessionStatus === "refused", "refused principal", 3_000);
    assert.equal(current.sessionStatus, "refused");
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await nextTask();
    assert.equal(requests.length, 1, "a refused session cannot emit");
    await act(async () => current.refresh());
    document.cookie = `${SOCIAL_WALLET_HINT_COOKIE}=1; Path=/; Secure`;
    privy.getAccessToken = async () => null;
    await render();
    await settle("00000000-0000-4000-8000-000000000002");
    await nextTask();
    assert.equal(
      requests.length,
      1,
      "missing Privy token cannot fall back to the coexisting wallet",
    );
    readyAccount = null;
    const beforeWalletReads = reads;
    privy.authenticated = false;
    await render();
    await waitFor(() => reads > beforeWalletReads, "wallet's canonical account lookup", 3_000);
    await settle("00000000-0000-4000-8000-000000000003");
    await waitFor(() => requests.length === 2, "settled wallet-only activity", 3_000);
    assert.equal(new Headers(requests[1]!.headers).get("Authorization"), null);
    assert.equal(requests[1]!.credentials, "same-origin");
    process.env.NEXT_PUBLIC_ANALYTICS_ACCOUNT_ACTIVITY_ENABLED = "false";
    await render();
    assert.equal(listeners.size, 0);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    globalThis.fetch = originalFetch;
    if (originalFlag === undefined) {
      delete process.env.NEXT_PUBLIC_ANALYTICS_ACCOUNT_ACTIVITY_ENABLED;
    } else {
      process.env.NEXT_PUBLIC_ANALYTICS_ACCOUNT_ACTIVITY_ENABLED = originalFlag;
    }
    dom.window.close();
    Reflect.deleteProperty(globalThis, "activityFixturePrivy");
  }
});
