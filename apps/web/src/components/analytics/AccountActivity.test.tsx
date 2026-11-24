import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, StrictMode, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";

import { AccountActivity } from "./AccountActivity.tsx";
import type { ActivitySession } from "./account-activity.ts";

// Drain scheduled React/Promise work without an elapsed-time sleep.
const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));

test("the mounted emitter stays idle without an account, survives Strict Mode and drops old token completion on switch or unmount", async () => {
  const dom = new JSDOM('<div id="mount"></div>', {
    url: "https://blast.test",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  let root = createRoot(document.getElementById("mount")!);
  const original = globalThis.fetch;
  let resolveA!: (value: string) => void;
  let resolveC!: (value: string) => void;
  let tokens = 0;
  let holdRequest = false;
  let finishRequest!: (value: Response) => void;
  let signalAtCommit: AbortSignal | null = null;
  let abortedAtCommit: boolean | undefined;
  const requests: RequestInit[] = [];
  globalThis.fetch = async (_, init) => {
    requests.push(init!);
    if (holdRequest) {
      return new Promise((resolve) => {
        finishRequest = resolve;
      });
    }
    return new Response(null, { status: 204 });
  };
  const a: ActivitySession = {
    accountId: "A",
    identity: "privy-A",
    mode: "privy",
    getAccessToken: () => {
      tokens += 1;
      return new Promise((resolve) => {
        resolveA = resolve;
      });
    },
  };
  function CommitProbe({ session }: Readonly<{ session: ActivitySession | null }>) {
    useLayoutEffect(() => {
      if (signalAtCommit) {
        abortedAtCommit = signalAtCommit.aborted;
      }
    }, [session]);
    return <AccountActivity session={session} />;
  }
  async function render(session: ActivitySession | null) {
    await act(async () => {
      root.render(
        <StrictMode>
          <CommitProbe session={session} />
        </StrictMode>,
      );
      await nextTask();
    });
  }
  try {
    await render(null);
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await nextTask();
    assert.equal(tokens, 0);
    assert.equal(requests.length, 0);
    // A settled account may already be available when this subtree first mounts.
    await act(async () => root.unmount());
    root = createRoot(document.getElementById("mount")!);
    await render(a);
    assert.equal(tokens, 1, "Strict Mode's discarded setup acquires no token");
    await render({ ...a });
    assert.equal(tokens, 1, "rerender does not replace a pending attempt");
    await render({
      accountId: "B",
      identity: "privy-B",
      mode: "privy",
      getAccessToken: async () => "B-token",
    });
    assert.equal(requests.length, 1);
    assert.equal(new Headers(requests[0]!.headers).get("Authorization"), "Bearer B-token");
    await render({
      accountId: "B-recreated",
      identity: "privy-B",
      mode: "privy",
      getAccessToken: async () => "B-token",
    });
    assert.equal(requests.length, 2, "a new canonical account UUID has its own cooldown");
    resolveA("late-A");
    await nextTask();
    assert.equal(requests.length, 2);
    holdRequest = true;
    await render({ accountId: "D", identity: "wallet", mode: "wallet" });
    assert.equal(requests.length, 3);
    signalAtCommit = requests[2]!.signal!;
    assert.equal(signalAtCommit.aborted, false);
    await render(null);
    assert.equal(
      abortedAtCommit,
      true,
      "the old request aborts during commit, before passive cleanup",
    );
    finishRequest(new Response(null, { status: 204 }));
    holdRequest = false;
    await render(null);
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await nextTask();
    assert.equal(requests.length, 3);
    await render({
      accountId: "C",
      identity: "privy-C",
      mode: "privy",
      getAccessToken: () =>
        new Promise((resolve) => {
          resolveC = resolve;
        }),
    });
    await act(async () => root.unmount());
    resolveC("late-C");
    document.dispatchEvent(new dom.window.Event("visibilitychange"));
    await nextTask();
    assert.equal(requests.length, 3);
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = original;
    dom.window.close();
  }
});
