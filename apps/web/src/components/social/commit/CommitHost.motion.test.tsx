import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom, recordAnimations, testEvent } from "../../../../test/fixtures/social/test-dom.ts";
import { ALON_ID, ALON_READ } from "../../../../test/fixtures/social/commit/alon.ts";

const dom = installTestDom();
const motion = recordAnimations();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { useCommitHost } = await import("./CommitHost");

function Page() {
  const { node, overlays } = useCommitHost({ presaleDeployed: true });
  return <><button onClick={() => overlays.openCommitTo?.(ALON_ID, null)}>Open</button>{node}</>;
}

test("the real commit host retains the sale through dismissal, then releases it when the exit finishes", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalMedia = dom.window.matchMedia;
  dom.window.matchMedia = (query) => ({ ...originalMedia(query), matches: query.includes("max-width: 760px") });
  globalThis.fetch = async (url) => String(url).includes(`/presales/${ALON_ID}`)
    ? Response.json(ALON_READ) : Response.json({}, { status: 503 });
  const client = createTestQueryClient();
  const container = dom.document.createElement("div");
  container.setAttribute("data-blast-ui", "");
  dom.document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); globalThis.fetch = originalFetch; dom.window.matchMedia = originalMedia; });
  await act(async () => root.render(withQueryClient(client, <Page />)));
  await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
  const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
  assert.ok(dialog);
  await act(async () => motion.finishAll());
  await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
  assert.ok(dialog.isConnected, "the exit can play before the host clears the sale");
  assert.equal(dialog.getAttribute("aria-modal"), null);
  assert.equal(dialog.querySelector<HTMLButtonElement>('[data-ui-variant="primary"]')?.disabled, true);
  await act(async () => {
    dialog.dispatchEvent(testEvent("touchstart", { touches: [{ clientX: 20, clientY: 10 }] }));
    dialog.dispatchEvent(testEvent("touchmove", { touches: [{ clientX: 20, clientY: 30 }] }));
    dialog.dispatchEvent(testEvent("touchcancel", { touches: [] }));
  });
  assert.equal(dialog.getAttribute("aria-modal"), "true", "catching dismissal restores the original commit dialog");
  await act(async () => motion.finishAll());
  assert.equal(container.querySelector('[role="dialog"]'), dialog);
  await act(async () => dialog.querySelector<HTMLButtonElement>('[aria-label="Close"]')!.click());
  await act(async () => motion.finishAll());
  assert.equal(container.querySelector('[role="dialog"]'), null);
  assert.equal(dom.document.body.style.overflow, "");
});
