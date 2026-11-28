import assert from "node:assert/strict";
import test from "node:test";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { toHex } from "@mysten/sui/utils";
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

test("an embedded withdrawal drops its signature when the account deactivates during signing", async () => {
  const dom = new JSDOM('<div id="mount"></div>');
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("mount")!);
  const key = Ed25519Keypair.fromSecretKey(new Uint8Array(32).fill(7));
  const publicKey = key.getPublicKey();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const runtime = {
    authenticated: true,
    user: { linkedAccounts: [{
      type: "wallet",
      chainType: "sui",
      connectorType: "embedded",
      walletClientType: "privy",
      imported: false,
      id: "embedded-wallet",
      recoveryMethod: "privy-v2",
      address: publicKey.toSuiAddress(),
      publicKey: toHex(publicKey.toRawBytes()),
    }] },
    async signRawHash() {
      started.resolve();
      await release.promise;
      return { signature: `0x${"31".repeat(64)}` };
    },
  } as unknown as PrivyRuntime;
  const session = privySessionValue(runtime, true, async () => runtime, () => () => undefined);
  let bridge: PrivyCoinSigner | null = null;
  try {
    await act(async () => root.render(
      <PrivySessionContext value={session}>
        <PrivyCoinSignerBridge onChange={(next) => (bridge = next)} />
      </PrivySessionContext>,
    ));
    const signing = bridge!.signer()!.signTransaction(new Uint8Array([1, 2, 3]));
    await started.promise;
    await act(async () => root.render(null));
    const rejected = assert.rejects(signing, { message: "The active account changed." });
    release.resolve();
    await rejected;
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
  }
});
