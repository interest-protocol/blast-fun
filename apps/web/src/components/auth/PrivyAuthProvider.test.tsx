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
            return createElement(Dialog, { "aria-label": appId, "data-wallet-connect": config.externalWallets?.walletConnect?.enabled },
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
