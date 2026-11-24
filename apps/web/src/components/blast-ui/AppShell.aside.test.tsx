import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom, testEvent } from "../../../test/fixtures/social/test-dom.ts";

const { window, document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
const { AppShell } = await import("./AppShell");
const { setShellPref } = await import("./use-shell-prefs");

test("collapsed rail ignores expanded-card offsets and stays below the header as coins load, grow and scroll", async (t) => {
  const container = document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  document.body.appendChild(container);
  const root = createRoot(container);
  const router = { push() {}, replace() {}, prefetch() {} };
  t.mock.method(window.HTMLElement.prototype, "getBoundingClientRect", function (this: HTMLElement) {
    const top = this.matches("#main, #aside") ? 64 : this.matches("[data-page-surface]") ? 1000 : this.matches("[data-aside-card]") ? 144 : 0;
    return new window.DOMRect(0, top, 44, this.matches("[data-shell-topbar]") ? 64 : 44);
  });
  t.after(async () => {
    await act(async () => { root.unmount(); setShellPref("asideCollapsed", false); });
    container.remove();
  });
  await act(async () => setShellPref("asideCollapsed", false));
  const render = async (coins: number, presale = false) => {
    await act(async () => root.render(
      <AppRouterContext value={router as never}>
        <PathnameContext value="/">
          <AppShell
            aside={<div className="card" data-aside-card="" />}
            asideMini={coins ? <div aria-label="Your coins">{Array.from({ length: coins }, (_, index) => <button key={index} type="button">Coin {index}</button>)}</div> : null}
            portfolio={{ status: "unavailable" }}
            signInHref="/sign-in"
            signedIn={false}
            viewer={null}
          >
            <div data-sale-page={presale ? "" : undefined}>
              <div data-page-head="" />
              <div className="card" data-page-surface="" />
            </div>
          </AppShell>
        </PathnameContext>
      </AppRouterContext>,
    ));
  };
  await render(0);
  const aside = document.getElementById("aside")!;
  assert.equal(aside.style.marginTop, "856px", "expanded cards retain alignment to the page surface");
  await act(async () => setShellPref("asideCollapsed", true));
  for (const count of [0, 1, 10]) {
    await render(count);
    Object.defineProperty(aside, "offsetHeight", { value: count * 100, configurable: true });
    await act(async () => window.dispatchEvent(testEvent("resize")));
    assert.equal(aside.style.marginTop, "");
    assert.equal(aside.style.top, "64px", "coin count cannot push the expand control above or below the header");
    assert.equal(aside.querySelector(".asideMini")?.firstElementChild?.getAttribute("aria-label"), "Expand trending coins");
  }
  await act(async () => setShellPref("asideCollapsed", false));
  assert.equal(aside.style.marginTop, "856px", "reopening restores expanded-card alignment");
  const stickyTop = aside.style.top;
  await render(0, true);
  await act(async () => window.dispatchEvent(testEvent("resize")));
  assert.equal(aside.style.marginTop, "", "presale cards use the shared grid row without a measured margin");
  assert.equal(aside.style.top, stickyTop, "presale alignment preserves the existing sticky position");
  await render(0);
  await act(async () => window.dispatchEvent(testEvent("resize")));
  assert.equal(aside.style.marginTop, "856px", "other pages retain their surface alignment after leaving a presale");
});

test("sticky offsets follow header growth and shrinkage, then stop observing on unmount", async (t) => {
  let height = 104;
  let resize = () => {};
  let observed: Element | null = null;
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class extends original {
    constructor(callback: ResizeObserverCallback) {
      super(callback);
      this.callback = callback;
    }
    readonly callback: ResizeObserverCallback;
    observe(target: Element) {
      if (target.matches("[data-shell-topbar]")) {
        observed = target;
        resize = () => this.callback([], this);
      }
    }
    disconnect() { observed = null; }
  };
  t.mock.method(window.HTMLElement.prototype, "getBoundingClientRect", function (this: HTMLElement) {
    return new window.DOMRect(0, 0, 320, this.matches("[data-shell-topbar]") ? height : 0);
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <AppRouterContext value={{ push() {}, replace() {}, prefetch() {} } as never}>
        <PathnameContext value="/portfolio">
          <AppShell portfolio={{ status: "unavailable" }} signInHref="/sign-in" signedIn={false} viewer={null}>
            <p>Portfolio</p>
          </AppShell>
        </PathnameContext>
      </AppRouterContext>,
    ));
    const header = container.querySelector<HTMLElement>("[data-shell-topbar]")!;
    const shell = header.parentElement!;
    assert.equal(observed, header);
    assert.equal(shell.style.getPropertyValue("--shell-topbar-height"), "104px");
    for (height of [121.75, 196, 56]) {
      await act(async () => resize());
      assert.equal(shell.style.getPropertyValue("--shell-topbar-height"), `${height}px`);
    }
  } finally {
    await act(async () => root.unmount());
    globalThis.ResizeObserver = original;
    container.remove();
  }
  assert.equal(observed, null);
});
