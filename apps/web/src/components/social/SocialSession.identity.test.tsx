import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { waitFor } from "#web/test/fixtures/social/test-dom.ts";

const ACCOUNT_A = "00000000-0000-4000-8000-000000000001";
const ACCOUNT_B = "00000000-0000-4000-8000-000000000002";

// The external auth provider changes its principal before the real me query settles.
const privy = {
  ready: true,
  authenticated: true,
  user: { id: "principal-A" },
  getAccessToken: async () => privy.user.id,
  logout: async () => {},
};
Object.assign(globalThis, { t013Privy: privy });
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith("/privy-session.ts"))
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const usePrivySession=()=>globalThis.t013Privy;",
      };
    return nextResolve(specifier, context);
  },
});
const { SocialSession } = await import("./SocialSession");
const { useSocialAccount } = await import("./use-social-account");
const { useSocialViewer } = await import("./SignInGate");

test("a blocked account preference returns a recoverable switch failure", async (t) => {
  const dom = new JSDOM("", { url: "https://blast.test" });
  const { rememberAccountSession } = await import("./account-selection");
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  try {
    t.mock.setter(document, "cookie", () => {
      throw new dom.window.DOMException("Cookie access denied.", "SecurityError");
    });
    assert.equal(rememberAccountSession("privy"), false);
  } finally {
    dom.window.close();
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
  }
});

test("production SocialSession publishes a new principal during a held then refused me lookup and recovers the same owner", async () => {
  const dom = new JSDOM('<div id="mount"></div>', {
    url: "https://blast.test",
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
  const original = globalThis.fetch;
  let answerB!: (response: Response) => void;
  let current!: ReturnType<typeof useSocialAccount>;
  let viewer!: ReturnType<typeof useSocialViewer>;
  const currentAccountId = () => current.account?.account_id;
  let failing = true;
  const reads: string[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("x-handle"))
      return Response.json({ updated: false });
    const token = new Headers(init?.headers).get("authorization")!;
    reads.push(token);
    if (token.endsWith("principal-B") && failing)
      return new Promise((resolve) => {
        answerB = resolve;
      });
    return Response.json({
      account: {
        account_id: token.endsWith("principal-A") ? ACCOUNT_A : ACCOUNT_B,
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
  };
  function Probe() {
    current = useSocialAccount();
    viewer = useSocialViewer();
    return (
      <span>
        {current.status} {current.account?.account_id}
      </span>
    );
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
  try {
    await render();
    await waitFor(() => current.status !== "loading", "principal A's account lookup to settle");
    assert.equal(currentAccountId(), ACCOUNT_A);
    assert.equal(current.sessionIdentity, "principal-A");
    assert.equal(viewer.sessionIdentity, "principal-A");
    client.setQueryData(["blast", "me", "private"], "A private");
    privy.user = { id: "principal-B" };
    await render();
    await waitFor(() => answerB !== undefined, "principal B's held lookup");
    assert.equal(current.sessionIdentity, "principal-B");
    assert.equal(current.status, "loading");
    assert.equal(viewer.sessionIdentity, "principal-B");
    assert.equal(current.account, null);
    assert.equal(client.getQueryData(["blast", "me", "private"]), undefined);
    await act(async () => {
      answerB(
        Response.json(
          { error: { code: "service_unavailable" } },
          { status: 503 },
        ),
      );
    });
    await waitFor(() => current.status !== "loading", "principal B's refused lookup to settle");
    assert.equal(current.status, "error");
    assert.equal(current.account, null);
    failing = false;
    await act(async () => current.refresh());
    await waitFor(() => current.status === "ready", "principal B's recovered account");
    assert.equal(currentAccountId(), ACCOUNT_B);
    assert.equal(current.sessionIdentity, "principal-B");
    assert.equal(viewer.sessionIdentity, "principal-B");
    assert.ok(reads.some((token) => token.endsWith("principal-B")));
  } finally {
    await act(async () => root.unmount());
    client.clear();
    globalThis.fetch = original;
    dom.window.close();
    Reflect.deleteProperty(globalThis, "t013Privy");
  }
});

test("the shared client reads and acts as the chosen account while both sign-ins remain live", async () => {
  const dom = new JSDOM('<div id="mount"></div>', { url: "https://blast.test" });
  let getPrivyToken = true;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
    t013Privy: {
      ...privy,
      user: { id: "principal-A" },
      getAccessToken: async () => getPrivyToken ? "principal-A" : null,
    },
  });
  const { rememberAccountSession } = await import("./account-selection");
  const { socialRequestAuth } = await import("./social-fetch.ts");
  const root = createRoot(document.getElementById("mount")!);
  const client = new QueryClient();
  const original = globalThis.fetch;
  let viewer!: ReturnType<typeof useSocialViewer>;
  let current!: ReturnType<typeof useSocialAccount>;
  let walletExpired = false;

  document.cookie = "__Host-blast_wallet_hint=1; Path=/; Secure";
  const reads: (string | null)[] = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith("x-handle")) {
      return Response.json({ updated: false });
    }
    const token = new Headers(init?.headers).get("authorization");
    reads.push(token);
    if (!token && walletExpired) {
      document.cookie = "__Host-blast_wallet_hint=; Max-Age=0; Path=/; Secure";
      return Response.json({ error: { code: "unauthorized" } }, { status: 401 });
    }
    return Response.json({
      account: {
        account_id: token ? ACCOUNT_A : ACCOUNT_B,
        kind: "new",
        callsign: token ? "privy_pilot" : "slush_pilot",
        display_name: null,
        avatar_url: null,
        x_handle: null,
        verified: false,
        onboarding: { shown: true, completed: true },
        privacy: "public",
        sharing_since_ms: null,
        wallets: [],
      },
    });
  };

  function Probe() {
    viewer = useSocialViewer();
    current = useSocialAccount();
    return <span>{viewer.callsign}</span>;
  }

  try {
    assert.equal(rememberAccountSession("wallet"), true);
    await act(async () => {
      root.render(<QueryProvider client={client}><SocialSession initialSelection="wallet"><Probe /></SocialSession></QueryProvider>);
    });
    await waitFor(() => viewer.callsign === "slush_pilot", "the selected Slush account");
    assert.equal(reads[0], null);
    assert.deepEqual((await socialRequestAuth(viewer.getAccessToken))?.headers, {});

    walletExpired = true;
    await act(async () => current.refresh());
    await waitFor(() => !viewer.signedIn, "the selected Slush session to expire");
    await act(async () => {});
    assert.ok(reads.every((token) => token === null), "Slush expiry does not select Privy");

    document.cookie = "__Host-blast_wallet_hint=1; Path=/; Secure";
    await act(async () => {
      assert.equal(rememberAccountSession("privy"), true);
      root.render(<QueryProvider client={client}><SocialSession initialSelection="privy" key="new-document"><Probe /></SocialSession></QueryProvider>);
    });
    await waitFor(() => viewer.callsign === "privy_pilot", "the selected Privy account");
    assert.deepEqual((await socialRequestAuth(viewer.getAccessToken))?.headers, { authorization: "Bearer principal-A" });
    assert.match(document.cookie, /__Host-blast_wallet_hint=1/);
    getPrivyToken = false;
    assert.equal(await socialRequestAuth(viewer.getAccessToken), null, "a missing Privy token cannot authenticate as Slush");
  } finally {
    await act(async () => root.unmount());
    client.clear();
    globalThis.fetch = original;
    dom.window.close();
    Reflect.deleteProperty(globalThis, "t013Privy");
  }
});
