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
    if (specifier === "@privy-io/react-auth")
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const usePrivy=()=>globalThis.t013Privy;",
      };
    if (specifier.endsWith("/PrivySessionProvider.tsx"))
      return {
        shortCircuit: true,
        url: "data:text/javascript,export const usePrivySessionMounted=()=>true;",
      };
    return nextResolve(specifier, context);
  },
});
const { SocialSession } = await import("./SocialSession");
const { useSocialAccount } = await import("./use-social-account");
const { useSocialViewer } = await import("./SignInGate");

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
