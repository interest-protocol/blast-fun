import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivySourceWalletsStore, PrivyStart } from "./privy-start.ts";
import { setShellPref } from "#web/components/blast-ui/use-shell-prefs.ts";

// The page's start; these tests only watch the SDK's wallet clients.
const start = new PrivyStart();
const sourceWallets = new PrivySourceWalletsStore();

const resources = { factories: 0, listeners: 0 };
Object.assign(globalThis, { privyLifetimeResources: resources });
const reactUrl = import.meta.resolve("react");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@privy-io/react-auth/solana") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(`
          export const useWallets = () => ({ wallets: [] });
          export const useSignTransaction = () => ({ signTransaction: async () => ({}) });
          export function toSolanaWalletConnectors() {
            const resources = globalThis.privyLifetimeResources;
            resources.factories++;
            let mounted = true;
            resources.listeners += 2;
            return {
              onMount() { if (!mounted) { mounted = true; resources.listeners += 2; } },
              onUnmount() { if (mounted) { mounted = false; resources.listeners -= 2; } },
              get() { return [{ walletBranding: { id: "walletconnect_solana" }, wallet: { name: "WalletConnect" } }]; }
            };
          }
        `)}`,
      };
    }
    if (specifier === "@privy-io/react-auth/extended-chains") {
      return { shortCircuit: true, url: "data:text/javascript,export const useCreateWallet=()=>({createWallet:async()=>({})});export const useSignRawHash=()=>({signRawHash:async()=>({})});" };
    }
    if (specifier === "@privy-io/react-auth") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(`
          import { createElement, useEffect } from ${JSON.stringify(reactUrl)};
          export function PrivyProvider({ appId, config, children }) {
            const connectors = config?.externalWallets?.solana?.connectors;
            useEffect(() => {
              connectors?.onMount();
              return () => connectors?.onUnmount();
            }, [connectors]);
            return createElement("section", { "data-app": appId, "data-wallets": connectors?.get().map(c => c.wallet.name).join(","), "data-theme": config.appearance?.theme }, children);
          }
          export const usePrivy = () => ({ ready: false, authenticated: false, user: null, getAccessToken: async () => null, logout: async () => {} });
          export const useLogin = () => ({ login() {} });
          export const useLoginWithOAuth = () => ({ initOAuth: async () => {} });
          export const useConnectWallet = () => ({ connectWallet() {} });
          export const useWallets = () => ({ wallets: [] });
        `)}`,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { default: PrivySessionRuntime } = await import("./PrivySessionRuntime.tsx");

const noop = () => undefined;
function Runtime({ appId }: Readonly<{ appId: string }>) {
  return <PrivySessionRuntime appId={appId} emit={noop} nonce={null} start={start} wallets={sourceWallets} />;
}

test("the wallet picker follows Blast's theme while the wallet session stays mounted", async () => {
  const dom = new JSDOM('<div data-blast-ui id="mount"></div>', { url: "https://blast.test" });
  Object.assign(dom.window, {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("mount")!);
  try {
    await act(async () => root.render(<Runtime appId="theme-app" />));
    const picker = document.querySelector("section");
    assert.equal(picker?.getAttribute("data-theme"), "light");
    const factories = resources.factories;

    await act(async () => setShellPref("theme", "dark"));
    assert.equal(picker?.getAttribute("data-theme"), "dark");

    await act(async () => setShellPref("theme", "light"));
    assert.equal(picker?.getAttribute("data-theme"), "light");
    assert.equal(resources.factories, factories);
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
  }
});

test("T-008: Strict Mode navigation and remounting retain bounded connectors and release listeners", async () => {
  const dom = new JSDOM('<div id="mount"></div>', { url: "https://blast.test" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(document.getElementById("mount")!);
  const before = resources.factories;
  try {
    for (let visit = 0; visit < 8; visit++) {
      await act(async () => root.render(
        <StrictMode>
          <Runtime appId="app-A" />
        </StrictMode>,
      ));
      assert.equal(resources.factories, before + 1, "navigation and discarded renders reuse the document's connectors");
      assert.equal(resources.listeners, 2);
      assert.equal(document.querySelector("section")?.getAttribute("data-wallets"), "WalletConnect");
      await act(async () => root.render(null));
      assert.equal(resources.listeners, 0, "leaving the provider releases its registry listeners");
    }
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
  }
});

test("T-008: server requests create no wallet registries and browser documents and app IDs stay isolated", async () => {
  const before = resources.factories;
  for (const appId of ["server-A", "server-B"]) {
    renderToStaticMarkup(<Runtime appId={appId} />);
  }
  assert.equal(resources.factories, before, "server renders must not cache wallets or install registry listeners");
  assert.equal(resources.listeners, 0);

  for (let page = 0; page < 2; page++) {
    const dom = new JSDOM('<div id="mount"></div>', { url: "https://blast.test" });
    Object.assign(globalThis, { window: dom.window, document: dom.window.document });
    const root = createRoot(document.getElementById("mount")!);
    try {
      for (const appId of ["app-A", "app-B", "app-A"]) {
        await act(async () => root.render(<Runtime appId={appId} />));
        assert.equal(document.querySelector("section")?.getAttribute("data-app"), appId);
        assert.equal(resources.listeners, 2, "only the active app's registry is subscribed");
      }
      assert.equal(resources.factories, before + (page + 1) * 2, "different documents and apps own distinct registries");
    } finally {
      await act(async () => root.unmount());
      assert.equal(resources.listeners, 0);
      dom.window.close();
      Reflect.deleteProperty(globalThis, "window");
      Reflect.deleteProperty(globalThis, "document");
    }
  }
});
