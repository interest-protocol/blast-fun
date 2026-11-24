import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { JSDOM } from "jsdom";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";

const dom = new JSDOM('<div id="mount"></div>', {
  url: "https://blast.test/presale?status=live#next",
});
Object.assign(globalThis, {
  window: dom.window,
  self: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  Element: dom.window.Element,
  MutationObserver: dom.window.MutationObserver,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
  cancelAnimationFrame: clearTimeout,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const phone = new dom.window.EventTarget();
let phoneLayout = true;
Object.defineProperty(phone, "matches", { get: () => phoneLayout });
dom.window.matchMedia = (query) =>
  query === "(max-width: 760px)" ? phone as MediaQueryList : ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }) as unknown as MediaQueryList;
dom.window.scrollTo = () => {};
let loads = 0;
let finish!: () => void;
const ready = new Promise<void>((resolve) => {
  finish = resolve;
});
Object.assign(globalThis, { workspaceImportReady: ready });
const reactUrl = import.meta.resolve("react");
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "./workspace/WorkspaceHost") {
      loads += 1;
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(`import {createElement} from ${JSON.stringify(reactUrl)}; await globalThis.workspaceImportReady; export function WorkspaceHost(){return createElement('div',{'data-loaded-workspace':''},'Loaded workspace');}`)}`,
      };
    }
    return nextResolve(specifier, context);
  },
});
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppShell } = await import("#web/components/blast-ui/AppShell.tsx");
const { BlastModeHost } = await import("./BlastModeHost");
const { workspaceSession } = await import("./workspace/session");

test("the workspace stays closed on phones and loads on demand on wider screens", async () => {
  const root = createRoot(dom.window.document.getElementById("mount")!);
  const client = createTestQueryClient();
  const router = {
    push() {
      assert.fail("entry never routes");
    },
    replace() {},
    refresh() {},
    back() {},
    forward() {},
    prefetch() {},
  };
  try {
    await act(async () =>
      root.render(
        <QueryProvider client={client}>
          <AppRouterContext value={router as never}>
            <PathnameContext value="/presale">
              <div data-blast-ui="">
                <AppShell
                  overlays={
                    <BlastModeHost
                      accountState={{ status: "signed_out", account: null }}
                    />
                  }
                  portfolio={{ status: "unavailable" }}
                  signInHref="/sign-in"
                  signedIn={false}
                  viewer={null}
                >
                  <div id="view">
                    <button id="opener">Origin</button>
                  </div>
                </AppShell>
              </div>
            </PathnameContext>
          </AppRouterContext>
        </QueryProvider>,
      ),
    );
    assert.equal(loads, 0);
    const opener = dom.window.document.getElementById("opener")!;
    opener.focus();
    const shortcut = (key: string) => new dom.window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    const phoneShortcut = shortcut("b");
    await act(async () => opener.dispatchEvent(phoneShortcut));
    assert.equal(phoneShortcut.defaultPrevented, false, "the phone shell leaves the shortcut unhandled");
    assert.equal(loads, 0);
    phoneLayout = false;
    await act(async () =>
      workspaceSession().open({
        path: "/presale?status=live#next",
        scroll_x: 0,
        scroll_y: 0,
        main_scroll_top: 0,
      }),
    );
    assert.equal(loads, 1);
    const exit = dom.window.document.querySelector<HTMLButtonElement>(
      "[data-workspace-host] button",
    )!;
    assert.equal(dom.window.document.activeElement, exit);
    assert.ok(dom.window.document.querySelector('[aria-busy="true"][aria-label="Opening saved workspace"]'));
    await act(async () => exit.click());
    assert.equal(
      dom.window.document.querySelector("[data-workspace-host]"),
      null,
    );
    assert.equal(dom.window.document.activeElement, opener);
    await act(async () => {
      finish();
      await ready;
    });
    assert.equal(
      dom.window.document.querySelector("[data-loaded-workspace]"),
      null,
    );
    await act(async () =>
      workspaceSession().open({
        path: "/presale",
        scroll_x: 0,
        scroll_y: 0,
        main_scroll_top: 0,
      }),
    );
    assert.ok(dom.window.document.querySelector("[data-loaded-workspace]"));
    assert.equal(loads, 1);
    await act(async () => {
      phoneLayout = true;
      phone.dispatchEvent(Object.assign(new dom.window.Event("change"), { matches: true }));
    });
    assert.ok(!dom.window.document.querySelector("[data-loaded-workspace]"), "the live workspace closes at phone width");
    assert.equal(workspaceSession().getSnapshot().open, false);
  } finally {
    await act(async () => {
      finish();
      root.unmount();
    });
    dom.window.close();
    client.clear();
    Reflect.deleteProperty(globalThis, "workspaceImportReady");
  }
});
