import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient } from "@tanstack/react-query";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { SocialViewerProvider } from "./SignInGate";
import { workspaceEntryOwner } from "./blast-mode/workspace/entry-owner";
import { useViewerStateStore } from "./ViewerState";

test("private query scope follows stable account rather than callsign or wallet", async () => {
  const dom = new JSDOM('<div id="mount"></div>', {
    url: "https://blast.test",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(dom.window.document.getElementById("mount")!);
  const client = new QueryClient();
  async function render(
    accountId: string | null,
    callsign: string | null,
    signedIn = true,
  ) {
    await act(async () =>
      root.render(
        <QueryProvider client={client}>
          <SocialViewerProvider
            signedIn={signedIn}
            accountId={accountId}
            callsign={callsign}
          >
            <span>Page</span>
          </SocialViewerProvider>
        </QueryProvider>,
      ),
    );
  }
  try {
    await render("A", "same");
    client.setQueryData(["blast", "me", "private"], "A private");
    await render("A", "renamed");
    assert.equal(client.getQueryData(["blast", "me", "private"]), "A private");
    await render(null, null);
    await render("B", "renamed");
    assert.equal(client.getQueryData(["blast", "me", "private"]), undefined);
    client.setQueryData(["blast", "me", "private"], "B private");
    await render("B", "renamed", false);
    assert.equal(client.getQueryData(["blast", "me", "private"]), undefined);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    dom.window.close();
  }
});

test("a private viewer read from A cannot refill the cache after B becomes pending", async () => {
  const dom = new JSDOM('<div id="mount"></div>', {
    url: "https://blast.test",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("mount")!);
  const client = new QueryClient();
  const original = globalThis.fetch;
  let release!: (value: Response) => void;
  let signal: AbortSignal | null | undefined;
  globalThis.fetch = async (_url, init) => {
    signal = init?.signal;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  let store!: ReturnType<typeof useViewerStateStore>;
  function Probe() {
    store = useViewerStateStore();
    return null;
  }
  async function render(sessionIdentity: string, pending: boolean) {
    await act(async () =>
      root.render(
        <QueryProvider client={client}>
          <SocialViewerProvider
            signedIn
            sessionIdentity={sessionIdentity}
            accountId={pending ? null : "A"}
            sessionPending={pending}
          >
            <Probe />
          </SocialViewerProvider>
        </QueryProvider>,
      ),
    );
  }
  try {
    await render("A-principal", false);
    const old = store!;
    old.want({ callsigns: ["nova"] });
    const reading = old.flush();
    for (let n = 0; n < 8; n++) await Promise.resolve();
    await render("B-principal", true);
    assert.equal(
      store,
      null,
      "new principal cannot subscribe to the previous private store",
    );
    release(
      Response.json({
        reactions: {},
        follows: { accounts: { nova: true }, presales: {} },
        backers: {},
      }),
    );
    await reading;
    assert.equal(
      client.getQueryCache().getAll().length,
      0,
      "late A response must not recreate private cache after clearing",
    );
    assert.equal(signal?.aborted, true, "cancel the outgoing private reader");
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = original;
    client.clear();
    dom.window.close();
  }
});

test("a changed authenticated principal clears private queries and ends the old entry before me resolves or refuses", async () => {
  const dom = new JSDOM('<div id="mount"></div>', {
    url: "https://blast.test",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const root = createRoot(document.getElementById("mount")!);
  const client = new QueryClient();
  const account = { kind: "account", account_id: "A" } as const;
  async function render(
    sessionIdentity: string,
    accountId: string | null,
    sessionPending: boolean,
  ) {
    await act(async () =>
      root.render(
        <QueryProvider client={client}>
          <SocialViewerProvider
            signedIn
            sessionIdentity={sessionIdentity}
            accountId={accountId}
            sessionPending={sessionPending}
          >
            <span>Page remains mounted</span>
          </SocialViewerProvider>
        </QueryProvider>,
      ),
    );
  }
  try {
    await render("principal-A", "A", false);
    client.setQueryData(["blast", "me", "private"], "A private");
    await render("principal-A", null, true);
    assert.equal(
      client.getQueryData(["blast", "me", "private"]),
      "A private",
      "same-principal refresh retains continuity",
    );
    assert.equal(
      workspaceEntryOwner(
        account,
        { status: "pending" },
        { entry: "principal-A", current: "principal-A" },
      ).status,
      "ready",
    );
    await render("principal-B", null, true);
    assert.equal(
      client.getQueryData(["blast", "me", "private"]),
      undefined,
      "B cannot see A while its me read is pending",
    );
    for (const status of ["pending", "error"] as const) {
      assert.equal(
        workspaceEntryOwner(
          account,
          { status },
          { entry: "principal-A", current: "principal-B" },
        ).status,
        "ended",
      );
    }
    await render("principal-B", null, false);
    assert.equal(client.getQueryData(["blast", "me", "private"]), undefined);
    assert.equal(
      workspaceEntryOwner(
        { kind: "guest" },
        { status: "pending" },
        { entry: "", current: "principal-B" },
      ).status,
      "ready",
      "guest exploration remains latched through sign-in",
    );
  } finally {
    await act(async () => root.unmount());
    client.clear();
    dom.window.close();
  }
});
