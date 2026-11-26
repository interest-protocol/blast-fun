import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivyStart } from "./privy-start.ts";

// The page's start; these tests only watch the SDK's wallet clients.
const start = new PrivyStart();

type Wallet = { name: string; version: string; icon: string; chains: string[]; accounts: never[]; features: Record<string, never> };
const wallets = new Set<Wallet>();
const walletConnectInstances = new Set<object>();
const listeners = { register: new Set<(...values: Wallet[]) => void>(), unregister: new Set<(...values: Wallet[]) => void>() };
const registry = {
  get: () => [...wallets],
  recordWalletConnect: (connector: object) => walletConnectInstances.add(connector),
  on(event: keyof typeof listeners, listener: (...values: Wallet[]) => void) {
    listeners[event].add(listener);
    return () => listeners[event].delete(listener);
  },
};
Object.assign(globalThis, { privyRegistryFixture: registry });
const reactUrl = import.meta.resolve("react");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@wallet-standard/app") {
      return { shortCircuit: true, url: "data:text/javascript,export const getWallets=()=>globalThis.privyRegistryFixture;" };
    }
    if (specifier === "@privy-io/react-auth/extended-chains") {
      return { shortCircuit: true, url: "data:text/javascript,export const useCreateWallet=()=>({createWallet:async()=>({})});export const useSignRawHash=()=>({signRawHash:async()=>({})});" };
    }
    if (specifier === "@privy-io/react-auth") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(`
          import { createElement, useEffect } from ${JSON.stringify(reactUrl)};
          export function PrivyProvider({ config, children }) {
            const connectors = config?.externalWallets?.solana?.connectors;
            useEffect(() => { connectors?.onMount(); return () => connectors?.onUnmount(); }, [connectors]);
            if (connectors) globalThis.privyRegistryFixture.recordWalletConnect(connectors.get().find(c => c.wallet.name === "WalletConnect"));
            return createElement("section", { "data-wallets": connectors?.get().map(c => c.wallet.name).join(",") }, children);
          }
          export const usePrivy = () => ({ ready: false, authenticated: false, user: null, getAccessToken: async () => null, logout: async () => {} });
          export const useLogin = () => ({ login() {} });
          export const useLoginWithOAuth = () => ({ initOAuth: async () => {} });
        `)}`,
      };
    }
    return nextResolve(specifier, context);
  },
});
// The real public Privy factory and Solana connectors run against the stateful registry boundary.
const { default: PrivySessionRuntime } = await import("./PrivySessionRuntime.tsx");
const noop = () => undefined;

test("T-008: real SDK discovers added and removed wallets after absence while unchanged remounts retain one client", async () => {
  for (const appId of ["server-A", "server-B"]) {
    renderToStaticMarkup(<PrivySessionRuntime appId={appId} emit={noop} nonce={null} start={start} />);
  }
  assert.equal(walletConnectInstances.size, 0, "server requests create no browser wallet clients");
  const dom = new JSDOM('<div id="mount"></div>', { url: "https://blast.test" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("mount")!);
  const lateWallet: Wallet = { name: "Late wallet", version: "1.0.0", icon: "data:image/svg+xml,", chains: ["solana:mainnet"], accounts: [], features: {} };
  const render = async (appId = "registry-app") => act(async () => root.render(
    <StrictMode><PrivySessionRuntime appId={appId} emit={noop} nonce={null} start={start} /></StrictMode>,
  ));
  const names = () => document.querySelector("section")?.getAttribute("data-wallets")?.split(",");
  try {
    await render();
    assert.deepEqual(names(), ["WalletConnect"]);
    const extension = { ...lateWallet, chains: ["sui:mainnet"] };
    wallets.add(extension);
    for (const listener of listeners.register) listener(extension);
    await render();
    assert.equal(walletConnectInstances.size, 1, "a Sui extension cannot replace the Solana connector");
    wallets.delete(extension);
    for (const listener of listeners.unregister) listener(extension);

    for (let visit = 0; visit < 8; visit++) {
      await act(async () => root.render(null));
      assert.equal(listeners.register.size, 0);
      assert.equal(listeners.unregister.size, 0);
      await render();
      assert.equal(walletConnectInstances.size, 1, "unchanged wallet membership reuses one real SDK WalletConnect connector");
      assert.equal(listeners.register.size, 1);
      assert.equal(listeners.unregister.size, 1);
    }
    // The live SDK has already discovered this extension. Re-rendering the owner
    // must keep the existing WalletConnect client.
    wallets.add(lateWallet);
    for (const listener of listeners.register) listener(lateWallet);
    await render();
    assert.deepEqual(names(), ["Late wallet", "WalletConnect"]);
    assert.equal(walletConnectInstances.size, 1);
    const repeatedExtension = { ...lateWallet };
    wallets.add(repeatedExtension);
    for (const listener of listeners.register) listener(repeatedExtension);
    await render();
    assert.equal(walletConnectInstances.size, 1, "another extension advertising the same name preserves the client");
    wallets.delete(repeatedExtension);
    await act(async () => root.render(null));
    wallets.delete(lateWallet);
    await render();
    assert.equal(walletConnectInstances.size, 2, "a change missed during absence is reconciled");

    for (let visit = 0; visit < 3; visit++) {
      await act(async () => root.render(null));
      wallets.add(lateWallet);
      for (const listener of listeners.register) listener(lateWallet);
      await render();
      assert.deepEqual(names(), ["Late wallet", "WalletConnect"], "a wallet installed during provider absence remains available");
      assert.equal(listeners.register.size, 1);
      assert.equal(listeners.unregister.size, 1);

      await act(async () => root.render(null));
      wallets.delete(lateWallet);
      for (const listener of listeners.unregister) listener(lateWallet);
      await render();
      assert.deepEqual(names(), ["WalletConnect"], "wallets removed during absence do not remain in the list");
    }
    assert.equal(walletConnectInstances.size, 8, "each missed membership change reconciles the connector list");
    await render("different-app");
    assert.equal(walletConnectInstances.size, 9, "app IDs own independent configurations");
    await render();
    assert.equal(walletConnectInstances.size, 9, "returning to the first app reuses its current configuration");
  } finally {
    await act(async () => root.unmount());
    assert.equal(listeners.register.size, 0);
    assert.equal(listeners.unregister.size, 0);
    dom.window.close();
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
  }
  const secondDocument = new JSDOM('<div id="mount"></div>', { url: "https://blast.test" });
  Object.assign(globalThis, { window: secondDocument.window, document: secondDocument.window.document });
  const secondRoot = createRoot(document.getElementById("mount")!);
  try {
    await act(async () => secondRoot.render(<PrivySessionRuntime appId="registry-app" emit={noop} nonce={null} start={start} />));
    assert.equal(walletConnectInstances.size, 10, "browser documents own independent configurations");
  } finally {
    await act(async () => secondRoot.unmount());
    assert.equal(listeners.register.size, 0);
    assert.equal(listeners.unregister.size, 0);
    secondDocument.window.close();
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
  }
});
