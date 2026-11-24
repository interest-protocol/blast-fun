import assert from "node:assert/strict";
import test from "node:test";
import { toast as sonner } from "sonner";
import { renderToStaticMarkup } from "react-dom/server";
import { installTestDom, testEvent } from "../../../../test/fixtures/social/test-dom.ts";
import { happeningRead, happeningPresale, TIDE, MRDN } from "../../../../test/fixtures/social/happening/happening-fixtures.ts";

const dom = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { CelebrationHost } = await import("./CelebrationHost");
const { ToastProvider } = await import("#web/components/blast-ui/Toasts.tsx");
const { setDevicePref } = await import("#web/components/blast-ui/device-prefs.ts");
const { happeningStore } = await import("../happening/happening-store");
const { ShellPortfolioProvider } = await import("../shell-portfolio-context");
const { NO_SHELL_PORTFOLIO } = await import("../shell-portfolio-context-model");

const current = () => sonner.getToasts().find((entry) => entry.id === "presale-lifecycle");

test("live migrations never lock the page, steal focus, or reopen after dismissal", async () => {
  const container = dom.document.createElement("div");
  dom.document.body.append(container);
  const root = createRoot(container);
  let clicks = 0;
  let refreshed = 0;
  const store = happeningStore();
  const read = (lifecycle: string) => happeningRead({
    today: [happeningPresale({ ...TIDE.presale, lifecycle }), happeningPresale({ ...MRDN.presale, lifecycle })],
    fastest: [], tape: [],
  });
  try {
    dom.window.localStorage.clear();
    setDevicePref("celebrate", true);
    store.apply(read("open"));
    await act(async () => root.render(
      <ShellPortfolioProvider value={{ ...NO_SHELL_PORTFOLIO, refresh: () => refreshed++ }}>
        <ToastProvider>
          <button id="page-action" onClick={() => clicks++}>Keep browsing</button>
          <CelebrationHost />
        </ToastProvider>
      </ShellPortfolioProvider>,
    ));
    const pageAction = container.querySelector<HTMLButtonElement>("#page-action")!;
    pageAction.focus();
    await act(async () => store.apply(read("funded")));
    assert.ok(current());
    assert.equal(refreshed, 1);
    await act(async () => store.apply(read("migrated")));
    assert.equal(sonner.getToasts().filter((entry) => entry.id === "presale-lifecycle").length, 1);
    const notice = current();
    assert.ok(notice && "jsx" in notice);
    assert.match(renderToStaticMarkup(notice.jsx), /2 presales migrated/);
    assert.equal(refreshed, 2);
    assert.equal(dom.document.activeElement, pageAction);
    assert.equal(dom.document.querySelector('dialog, [aria-modal="true"], canvas, [data-burst-layer]'), null);
    assert.equal(dom.document.body.style.overflow, "");
    assert.equal(pageAction.closest('[inert], [aria-hidden="true"]'), null);
    await act(async () => pageAction.dispatchEvent(testEvent("click")));
    assert.equal(clicks, 1);
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    const dismiss = container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
    assert.ok(dismiss);
    await act(async () => dismiss.click());
    await act(async () => new Promise((resolve) => setTimeout(resolve, 50)));
    assert.equal(current(), undefined);
    await act(async () => store.apply(read("migrated")));
    assert.equal(current(), undefined, "the same read cannot reopen a dismissed announcement");
    await act(async () => store.apply(read("open")));
    await act(async () => store.apply(read("migrated")));
    assert.equal(current(), undefined, "device memory suppresses a repeated lifecycle transition");
    await act(async () => setDevicePref("celebrate", false));
    await act(async () => store.apply(happeningRead({ today: [happeningPresale({ presale_id: "new", lifecycle: "open" })], fastest: [], tape: [] })));
    await act(async () => store.apply(happeningRead({ today: [happeningPresale({ presale_id: "new", lifecycle: "migrated" })], fastest: [], tape: [] })));
    assert.equal(current(), undefined, "the device preference still applies");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    setDevicePref("celebrate", true);
  }
});
