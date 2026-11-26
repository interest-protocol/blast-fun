import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { createRoot } from "react-dom/client";

const dom = new JSDOM('<script nonce="document-policy"></script><div id="mount"></div>', {
  url: "https://blast.test",
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  IS_REACT_ACT_ENVIRONMENT: true,
});

const reactUrl = import.meta.resolve("react");
const styledUrl = import.meta.resolve("styled-components");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@privy-io/react-auth") {
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(`
          import { createElement } from ${JSON.stringify(reactUrl)};
          import { styled } from ${JSON.stringify(styledUrl)};
          const Dialog = styled.section({ display: "flex" });
          export function PrivyProvider({ appId, config, children }) {
            return createElement(Dialog, { "aria-label": appId, "data-wallet-connect": config.externalWallets?.walletConnect?.enabled, "data-wallet-list": config.appearance?.walletList?.join(",") ?? "default" },
              config.loginMethods.map(method => createElement("button", { key: method }, method)),
              children);
          }
        `)}`,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { PrivyAuthProvider } = await import("./PrivyAuthProvider.tsx");
const { usePreparePrivyWalletPicker, useRestorePrivyWallet } = await import("./privy-wallet-picker.ts");

test("public startup discovers extensions, restores the paired chain, and expands the same provider for the wallet picker", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  const extensions = "detected_ethereum_wallets,detected_solana_wallets";
  const savedWallets = {
    ethereum: { chainType: "ethereum", connectorType: "wallet_connect_v2" },
    solana: { chainType: "solana", connectorType: "solana_adapter", walletClientType: "phantom" },
    coinbase_wallet: { chainType: "ethereum", connectorType: "coinbase_wallet" },
    base_account: { chainType: "ethereum", connectorType: "base_account" },
  } as const;
  type Saved = keyof typeof savedWallets | null;
  function Surface({ picker, restore }: { picker: boolean; restore: Saved }) {
    useRestorePrivyWallet(restore ? savedWallets[restore] : undefined);
    usePreparePrivyWalletPicker(picker);
    return null;
  }
  const render = (picker: boolean, restore: Saved) => act(async () => root.render(
    <PrivyAuthProvider appId="blast" nonce={null} deferWalletPicker>
      <Surface picker={picker} restore={restore} />
    </PrivyAuthProvider>,
  ));
  try {
    await render(false, null);
    const owner = host.querySelector("section")!;
    assert.equal(host.querySelectorAll("section").length, 1);
    assert.equal(owner.dataset.walletList, extensions);
    await render(false, "ethereum");
    assert.equal(owner.dataset.walletList, extensions + ",wallet_connect_qr");
    await render(false, "solana");
    assert.equal(owner.dataset.walletList, extensions + ",wallet_connect_qr_solana", "Solana QR restores under the remote peer's brand");
    for (const dedicated of ["coinbase_wallet", "base_account"] as const) {
      await render(false, dedicated);
      assert.equal(owner.dataset.walletList, extensions + "," + dedicated);
    }
    await render(false, null);
    assert.equal(owner.dataset.walletList, extensions, "leaving the restored wallet clears its chain");
    await render(true, "solana");
    assert.equal(owner.dataset.walletList, "default");
    assert.equal(host.querySelector("section"), owner);
  } finally {
    await act(async () => root.unmount());
  }
});

test("sign-in keeps X, Google and document styles when wallet options change", async () => {
  const root = createRoot(document.getElementById("mount")!);
  try {
    await act(async () =>
      root.render(
        <PrivyAuthProvider
          appId="blast-auth"
          nonce="new-rsc-request"
          externalWallets={{ walletConnect: { enabled: false } }}
        >
          <span>Sign in</span>
        </PrivyAuthProvider>,
      ),
    );
    assert.deepEqual(
      [...document.querySelectorAll("button")].map((button) => button.textContent),
      ["twitter", "google"],
    );
    assert.equal(document.querySelector("section")?.getAttribute("aria-label"), "blast-auth");
    assert.equal(
      document.querySelector<HTMLStyleElement>("style[data-styled]")?.nonce,
      "document-policy",
    );
    assert.match(document.body.textContent!, /Sign in/);
    assert.equal(document.querySelector("section")?.getAttribute("data-wallet-connect"), "false");

    await act(async () =>
      root.render(
        <PrivyAuthProvider
          appId="blast-auth"
          nonce="another-rsc-request"
          externalWallets={{ walletConnect: { enabled: true } }}
        >
          <span>Sign in</span>
        </PrivyAuthProvider>,
      ),
    );
    assert.equal(document.querySelector("section")?.getAttribute("data-wallet-connect"), "true");
    assert.equal(
      document.querySelector<HTMLStyleElement>("style[data-styled]")?.nonce,
      "document-policy",
    );
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "document");
  }
});
