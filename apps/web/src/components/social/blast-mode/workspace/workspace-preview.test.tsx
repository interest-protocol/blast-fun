import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { installTestDom } from "../../../../../test/fixtures/social/test-dom.ts";
import { WORKSPACE_BOOT_SCRIPT } from "./workspace-boot";
import { parseWorkspacePreview } from "./workspace-preview";
import { workspaceSession } from "./session";
const { document, window } = installTestDom();
const preview = { presentation: "focus" as const, panels: 3, saved: true, discover: false, ticket: 360, holders: 210, activityHidden: false };
const savedSessionKey = "blast.workspace:session:1";
const savedPreviewKey = "blast.workspace.preview:1";

test("preview accepts only bounded geometry and drops every unrelated account field", () => {
  assert.deepEqual(parseWorkspacePreview({ ...preview, account: "private", panels_private: ["draft"], balance: "secret" }), preview);
  assert.equal(parseWorkspacePreview({ ...preview, holders: 170 })?.holders, 170);
  for (const bad of [{ ...preview, panels: 99 }, { ...preview, ticket: "360" }, { ...preview, holders: -1 }, { ...preview, presentation: "unknown" }]) assert.equal(parseWorkspacePreview(bad), undefined);
});

test("parser-time cover preserves geometry before React; Exit works without hydration", () => {
  const root = document.createElement("div"); root.setAttribute("data-blast-ui", "");
  root.innerHTML = '<div data-workspace-cover-mount></div><div hidden inert data-workspace-cover-source><section><button>Exit</button><span data-pending-saved></span><div data-pending-layout><div data-pending-edge></div><aside data-pending-discover></aside><div data-pending-panels><div data-board data-terminal-grid="desktop"><div></div></div><div hidden inert data-compare-placeholder><div data-panel></div></div></div></div></section></div>';
  document.body.append(root);
  const source = root.querySelector<HTMLElement>("[data-workspace-cover-source]")!;
  const boot = () => runInNewContext(WORKSPACE_BOOT_SCRIPT, {
    document: {
      currentScript: { previousElementSibling: source },
      documentElement: document.documentElement,
      addEventListener: document.addEventListener.bind(document),
      removeEventListener: document.removeEventListener.bind(document),
    },
    window,
    URL: window.URL,
    Event: window.Event,
    MutationObserver: window.MutationObserver,
    getComputedStyle: window.getComputedStyle.bind(window),
  });
  const origin = { path: window.location.pathname, scroll_x: 0, scroll_y: 0, main_scroll_top: 0 };
  const previousWidth = window.innerWidth;
  const previousMatchMedia = window.matchMedia;
  const phone = new window.EventTarget();
  Object.defineProperty(phone, "matches", { get: () => window.innerWidth <= 760 });
  window.matchMedia = (query) => query === "(max-width: 760px)" ? phone as MediaQueryList : previousMatchMedia(query);
  const open = () => window.sessionStorage.setItem(savedSessionKey, JSON.stringify({ open: true, origin }));
  try {
    Object.assign(window, { innerWidth: 760 });
    open();
    boot();
    assert.equal(root.querySelector("[data-workspace-boot]"), null, "a phone never paints the restore cover");
    Object.assign(window, { innerWidth: 1280 });
    open();
    window.sessionStorage.setItem(savedPreviewKey, JSON.stringify({ ...preview, discover: true }));
    const liveSession = workspaceSession();
    assert.equal(liveSession.getSnapshot().open, true);
    boot();
    const cover = root.querySelector<HTMLElement>("[data-workspace-boot]")!;
    assert.ok(cover);
    assert.equal(cover.querySelector<HTMLElement>("[data-board] > div")!.style.getPropertyValue("--board-ticket"), "22.5rem");
    assert.equal(cover.querySelector<HTMLElement>("[data-pending-discover]")!.hidden, true);
    cover.querySelector("button")!.click();
    assert.equal(root.querySelector("[data-workspace-boot]"), null);
    assert.deepEqual(JSON.parse(window.sessionStorage.getItem(savedSessionKey)!), { open: false, origin });
    assert.equal(liveSession.getSnapshot().open, false, "Exit also closes an initialized live session before its frame mounts");
    boot();
    assert.equal(root.querySelector("[data-workspace-boot]"), null);
    open();
    window.localStorage.setItem("blast.discover.chosen", "1");
    boot();
    assert.equal(root.querySelector<HTMLElement>("[data-workspace-boot] [data-pending-discover]")!.hidden, false);
    document.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape" }));
    assert.equal(root.querySelector("[data-workspace-boot]"), null);
    open();
    window.sessionStorage.setItem(savedPreviewKey, JSON.stringify({ ...preview, presentation: "compare" }));
    boot();
    assert.equal(root.querySelectorAll("[data-workspace-boot] [data-panel]").length, 3);
    root.querySelector("button")!.click();
    open();
    window.sessionStorage.setItem(savedPreviewKey, "{broken");
    boot();
    assert.ok(root.querySelector("[data-workspace-boot]"), "corrupt optional geometry keeps the restoration cover");
    Object.assign(window, { innerWidth: 760 });
    phone.dispatchEvent(Object.assign(new window.Event("change"), { matches: true }));
    assert.equal(root.querySelector("[data-workspace-boot]"), null, "resizing to a phone closes a pending restore");
    Object.assign(window, { innerWidth: 1280 });
    window.sessionStorage.setItem(savedSessionKey, "{broken");
    boot();
    assert.equal(root.querySelector("[data-workspace-boot]"), null);
  } finally {
    root.remove();
    window.sessionStorage.clear();
    window.localStorage.removeItem("blast.discover.chosen");
    window.matchMedia = previousMatchMedia;
    Object.assign(window, { innerWidth: previousWidth });
  }
});
