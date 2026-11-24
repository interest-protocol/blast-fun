import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { installTestDom, type TestElement } from "../../../../test/fixtures/social/test-dom.ts";

const { document, window } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { SettingsBackBarView } = await import("./SettingsBackBar");
const { backLabelOf } = await import("./settings-model");

import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";

/**
 * R3-76-AC-2 (oa41 `viewFor`'s Settings branch and `backbar`): Settings carries
 * a back bar above its title naming the page you came from — Portfolio when you
 * came from it — and "‹ Profile" on a direct load.
 */

const ORIGIN = "http://127.0.0.1";
const router = { push: () => undefined, replace: () => undefined, prefetch: () => undefined } as unknown as AppRouterInstance;
const steps: number[] = [];

/** The tab's history as the Navigation API reports it (`paths`, oldest first), standing on the last one. */
function history(paths: readonly string[]) {
  const entries = paths.map((path, index) => ({ url: path.startsWith("http") ? path : `${ORIGIN}${path}`, key: `k${index}`, index }));
  Object.assign(window, { navigation: { currentEntry: entries.at(-1), entries: () => entries } });
  window.history.replaceState(null, "", entries.at(-1)!.url);
  Object.assign(globalThis.history, { go: (delta: number) => void steps.push(delta) });
}

async function mount(t: TestContext): Promise<TestElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(
      <AppRouterContext value={router}>
        <SettingsBackBarView ownCallsign="kaimoreno" profileHref="/@kaimoreno" />
      </AppRouterContext>,
    ),
  );
  t.after(async () => {
    await act(async () => root.unmount());
    container.parentNode?.removeChild(container);
  });
  return container;
}

const link = (container: TestElement) => container.querySelector("a") as TestElement;

test("R3-76-AC-2: a direct load (and the server's HTML) reads ‹ Profile, to one's own profile; the bar is not the page head", async (t) => {
  const html = renderToStaticMarkup(
    <AppRouterContext value={router}>
      <SettingsBackBarView ownCallsign="kaimoreno" profileHref="/@kaimoreno" />
    </AppRouterContext>,
  );
  assert.match(html, /^<div class="backbar" data-back-bar=""><a class="back" href="\/@kaimoreno"><svg[^>]*>.*?<\/svg>Profile<\/a><\/div>$/);
  history(["/settings"]);
  const container = await mount(t);
  assert.equal(link(container).textContent, "Profile");
  assert.equal(link(container).getAttribute("href"), "/@kaimoreno");
});

test("R3-76-AC-2: from Portfolio the bar reads ‹ Portfolio and steps back to it; Settings' own entries are skipped", async (t) => {
  history(["/", "/portfolio", "/settings", "/settings?sheet=link"]);
  const container = await mount(t);
  assert.equal(link(container).textContent, "Portfolio");
  assert.equal(link(container).getAttribute("href"), "/portfolio");
  steps.length = 0;
  await act(async () => link(container).click());
  assert.deepEqual(steps, [-2]);
});

test("R3-76-AC-2: the page before is named as the gate's routeTitle does; one it cannot name, or another site, leaves ‹ Profile", async (t) => {
  history(["/@kaimoreno", "/settings"]);
  assert.equal(link(await mount(t)).textContent, "Profile");
  history(["/presale/0xabc", "/settings"]);
  assert.equal(link(await mount(t)).getAttribute("href"), "/@kaimoreno");
  history(["https://example.com/", "/settings"]);
  assert.equal(link(await mount(t)).getAttribute("href"), "/@kaimoreno");
  assert.deepEqual(
    ["/", "/feed", "/presale", "/notifications", "/portfolio", "/@kaimoreno", "/crew/kaimoreno", "/@luca", "/presale/0x1", "/create"].map((path) => backLabelOf(path, "kaimoreno")),
    ["Home", "Home", "Presales", "Notifications", "Portfolio", "Profile", "Profile", null, null, null],
  );
  assert.equal(backLabelOf("/@kaimoreno", null), null);
});

test("every page path names the same back label, browser path or rewrite target", () => {
  const rows: readonly (readonly [string, string | null])[] = [
    ["/", "Home"], ["/feed", "Home"], ["/feed/", null],
    ["/presale", "Presales"], ["/presale/", null],
    ["/notifications", "Notifications"], ["/notifications/x", null],
    ["/portfolio", "Portfolio"], ["/portfolio/vestings", null],
    ["/settings/x", null], ["/invites", null],
    ["/@kai", "Profile"], ["/@kai/", "Profile"], ["/crew/kai", "Profile"], ["/crew/kai/", "Profile"],
    ["/crew/kai/followers", null], ["/@nova", null], ["/coin/x", null], ["/x", null],
  ];
  for (const [path, label] of rows) assert.equal(backLabelOf(path, "kai"), label, path);
});
