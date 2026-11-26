import assert from "node:assert/strict";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { PrivySessionContext, privySessionValue, type PrivyRuntime } from "#web/components/auth/privy-session.ts";
import { PrivyCoinSignerBridge, type PrivyCoinSigner } from "./signers.tsx";

test("creating the Blast wallet on a restored session waits for Privy to start instead of failing", async () => {
  const dom = new JSDOM('<div id="mount"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("mount")!);
  let start!: (runtime: PrivyRuntime) => void;
  const ready = new Promise<PrivyRuntime>((resolve) => (start = resolve));
  const created: unknown[] = [];
  const runtime = { createWallet: async (input: unknown) => void created.push(input) } as unknown as PrivyRuntime;
  // Privy is still starting: no runtime yet, and `load` answers once it is ready.
  const session = privySessionValue(null, false, () => ready, () => () => undefined);
  let signer: PrivyCoinSigner | null = null;
  try {
    await act(async () => root.render(
      <PrivySessionContext value={session}>
        <PrivyCoinSignerBridge onChange={(next) => (signer = next)} />
      </PrivySessionContext>,
    ));
    const creating = signer!.createWallet();
    await act(async () => start(runtime));
    await creating;
    assert.deepEqual(created, [{ chainType: "sui" }]);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
  }
});
