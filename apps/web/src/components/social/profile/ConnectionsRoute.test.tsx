import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PathnameContext, PathParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
const { ProfileRouteLoading } = await import("./ConnectionsRoute");

for (const tab of ["followers", "following"] as const) {
  test(`${tab} deep-link fallback uses the connections shell without profile actions`, async (t) => {
    const container = document.createElement("div"); document.body.appendChild(container);
    const root = createRoot(container);
    t.after(async () => { await act(async () => root.unmount()); container.remove(); });
    await act(async () => root.render(<PathnameContext value={`/@kai/${tab}`}><PathParamsContext value={{ callsign: "kai" }}><ProfileRouteLoading /></PathParamsContext></PathnameContext>));
    assert.equal(container.querySelector("h1")!.textContent, tab === "followers" ? "Followers" : "Following");
    assert.equal(container.querySelector('nav a[aria-current="page"]')!.getAttribute("href"), `/@kai/${tab}`);
    assert.equal(container.querySelector("input")!.placeholder, `Search ${tab}`);
    const pending = container.querySelector(`[role="status"][aria-label="Loading ${tab}"]`);
    assert.equal(pending?.getAttribute("aria-busy"), "true");
    assert.equal(container.querySelector("li"), null);
    assert.doesNotMatch(container.textContent!, /Edit profile|Settings|Presale calls/);
  });
}

test("profile routes keep their profile fallback", async (t) => {
  const container = document.createElement("div"); document.body.appendChild(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  await act(async () => root.render(<PathnameContext value="/@kai"><ProfileRouteLoading><span>Profile loading</span></ProfileRouteLoading></PathnameContext>));
  assert.equal(container.textContent, "Profile loading");
  assert.equal(container.querySelector("nav"), null);
});
