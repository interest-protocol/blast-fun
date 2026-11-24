import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime.js");
const { PathnameContext, PathParamsContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime.js");
const { ConnectionsLoading, ConnectionRowsLoading } = await import("./ConnectionsLoading");
const router = { bfcacheId: "connections-test", refresh() {}, back() {}, forward() {}, push() {}, replace() {}, prefetch() {} };

for (const tab of ["followers", "following"] as const) {
  test(`${tab} direct visit has the connections shell and matching rows`, async (t) => {
    const container = document.createElement("div"); document.body.appendChild(container);
    const root = createRoot(container);
    t.after(async () => { await act(async () => root.unmount()); container.remove(); });
    await act(async () => root.render(<AppRouterContext value={router}><PathnameContext value={`/@kai/${tab}`}><PathParamsContext value={{ callsign: "kai" }}><ConnectionsLoading /></PathParamsContext></PathnameContext></AppRouterContext>));
    assert.equal(container.querySelector("h1")!.textContent, tab === "followers" ? "Followers" : "Following");
    assert.equal(container.querySelector('nav a[aria-current="page"]')!.getAttribute("href"), `/@kai/${tab}`);
    assert.equal(container.querySelector("input")!.placeholder, `Search ${tab}`);
    assert.equal(container.querySelectorAll("li").length, 0);
    assert.doesNotMatch(container.textContent!, /Edit profile|Settings|Presale calls/);
    assert.match(container.querySelector('[role="status"]')!.textContent!, new RegExp(`Loading ${tab}`));
    await act(async () => root.render(<ConnectionRowsLoading tab={tab} count={1} />));
    assert.equal(container.querySelectorAll("li").length, 1);
    await act(async () => root.render(<ConnectionRowsLoading tab={tab} count={0} />));
    assert.equal(container.querySelectorAll("li").length, 0);
    assert.ok(container.querySelector('.empty[role="status"]'));
    await act(async () => root.render(<ConnectionRowsLoading tab={tab} count={1000} />));
    assert.equal(container.querySelectorAll("li").length, 20);
  });
}
