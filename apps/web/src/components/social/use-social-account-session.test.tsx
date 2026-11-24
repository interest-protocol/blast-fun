import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";

import {
  fetchSocialAccount,
  socialAccountFromSession,
  type SocialAccountState,
} from "./social-account-client";
import { useSocialAccountSession } from "./use-social-account-session";
import { workspaceOwnerFromSession } from "./blast-mode/workspace/entry-owner";

test("refused me provenance survives wallet hint clearing; intentional retry and successful auth recover", async () => {
  const dom = new JSDOM('<div id="mount"></div>', {
    url: "https://blast.test",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(dom.window.document.getElementById("mount")!);
  let session!: ReturnType<typeof useSocialAccountSession>;
  let input = {
    ready: false,
    authenticated: false,
    wallet: false,
    accountState: socialAccountFromSession({
      ready: false,
      authenticated: false,
    })!,
  };
  function Probe() {
    session = useSocialAccountSession(input);
    return null;
  }
  async function render(next: Partial<typeof input>) {
    input = { ...input, ...next };
    await act(async () => root.render(<Probe />));
    return workspaceOwnerFromSession({
      ...input.accountState,
      sessionStatus: session.sessionStatus,
    });
  }
  try {
    assert.deepEqual(await render({}), { status: "pending" });
    const noSession = socialAccountFromSession({
      ready: true,
      authenticated: false,
    })!;
    assert.deepEqual(await render({ ready: true, accountState: noSession }), {
      status: "ready",
      owner: { kind: "guest" },
    });

    const refused = await fetchSocialAccount({
      getAccessToken: async () => "test-token",
      fetch: async () => new Response(null, { status: 401 }),
    });
    assert.equal(
      refused.status,
      "signed_out",
      "the existing client intentionally folds a refused read into signed_out",
    );
    assert.deepEqual(
      await render({ authenticated: true, accountState: refused }),
      { status: "error" },
    );
    assert.equal(session.sessionStatus, "refused");

    await render({ authenticated: false, wallet: true, accountState: refused });
    assert.deepEqual(
      await render({ wallet: false, accountState: noSession }),
      { status: "error" },
      "clearing the refused wallet hint must not install guest storage",
    );
    await act(async () => session.resetRefusal());
    assert.equal(session.sessionStatus, "signed_out");
    assert.deepEqual(
      workspaceOwnerFromSession({
        ...noSession,
        sessionStatus: session.sessionStatus,
      }),
      { status: "ready", owner: { kind: "guest" } },
    );

    await render({ authenticated: true, accountState: refused });
    const accountState = {
      status: "ready",
      account: { account_id: "account-1" },
    } as SocialAccountState;
    assert.deepEqual(await render({ accountState }), {
      status: "ready",
      owner: { kind: "account", account_id: "account-1" },
    });
    assert.equal(session.sessionStatus, "authenticated");
    assert.deepEqual(
      await render({ authenticated: false, accountState: noSession }),
      { status: "ready", owner: { kind: "guest" } },
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
  }
});
