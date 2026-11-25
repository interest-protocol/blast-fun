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
  test(`presale notifications never lock the bell and retain a ${outcome}`, async (t) => {
    const pending = Promise.withResolvers<FollowWriteResult>();
    const failures: unknown[] = [];
    const failure = new Error("Follow write failed");
    const writes = t.mock.method(ViewerStateStore.prototype, "setFollowing", () => pending.promise);
    t.mock.method(globalThis, "fetch", async () => new Response("{}", { status: 503 }));
    function Notify() {
      const { toggle } = usePresaleNotify(SABL.presale);
      return <button onClick={() => void toggle().catch((error) => failures.push(error))} type="button">Notify</button>;
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
    // A second tap while the first write is pending still reaches the store.
    await act(async () => void button.dispatchEvent(testEvent("click")));
    assert.equal(writes.mock.callCount(), 2);
    await act(async () => {
      if (outcome === "success") pending.resolve({ status: "ok" });
      else pending.reject(failure);
      await pending.promise.catch(() => undefined);
    });
    assert.deepEqual(failures, outcome === "success" ? [] : [failure, failure]);
  });
}
