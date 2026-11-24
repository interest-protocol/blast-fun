import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom, testEvent } from "../../../../test/fixtures/social/test-dom.ts";
import type { FollowWriteResult } from "../viewer-state-client";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { SocialViewerProvider } = await import("../SignInGate");
const { ViewerStateStore } = await import("../viewer-state-store");
const { usePresaleNotify } = await import("./parts");
const { SABL } = await import("../../../../test/fixtures/social/happening/happening-fixtures.ts");

for (const outcome of ["success", "rejection"] as const) {
  test(`presale notifications clear busy after ${outcome} and retain rejection`, async (t) => {
    const pending = Promise.withResolvers<FollowWriteResult>();
    const failures: unknown[] = [];
    const failure = new Error("Follow write failed");
    t.mock.method(ViewerStateStore.prototype, "setFollowing", () => pending.promise);
    t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 503 }));
    function Notify() {
      const { busy, toggle } = usePresaleNotify(SABL.presale);
      return <button aria-busy={busy} onClick={() => void toggle().catch((error) => failures.push(error))} type="button">Notify</button>;
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    t.after(async () => {
      await act(async () => root.unmount());
      container.remove();
    });
    await act(async () => root.render(<SocialViewerProvider callsign="kaimoreno" signedIn><Notify /></SocialViewerProvider>));
    const button = container.querySelector("button")!;
    await act(async () => void button.dispatchEvent(testEvent("click")));
    assert.equal(button.getAttribute("aria-busy"), "true");
    await act(async () => {
      if (outcome === "success") pending.resolve({ status: "ok" });
      else pending.reject(failure);
      await pending.promise.catch(() => undefined);
    });
    assert.equal(button.getAttribute("aria-busy"), "false");
    assert.deepEqual(failures, outcome === "success" ? [] : [failure]);
  });
}
