import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";
installTestDom();
const { act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { PathnameContext } = await import("next/dist/shared/lib/hooks-client-context.shared-runtime");
const { AppShell } = await import("./AppShell");

test("peer portfolio routes preserve the mounted page; leaving Portfolio still replaces it", async t => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  t.after(async () => { await act(async () => root.unmount()); host.remove(); });
  let mounts = 0;
  function Page() { const [instance] = useState(() => ++mounts); return <output>{instance}</output>; }
  const router = { bfcacheId: "test", back() {}, forward() {}, refresh() {}, hmrRefresh() {}, push() {}, replace() {}, prefetch() {} };
  async function render(path: string) {
    await act(async () => root.render(<AppRouterContext value={router}><PathnameContext value={path}><AppShell portfolio={{ status: "unavailable" }} signInHref="/sign-in" signedIn={false} viewer={null}><Page /></AppShell></PathnameContext></AppRouterContext>));
  }
  await render("/portfolio");
  const page = host.querySelector("output");
  for (const section of ["rewards", "vestings", "presales", "launches"]) {
    await render(`/portfolio/${section}`);
    assert.ok(host.querySelector("output") === page, `${section} should keep the mounted page`);
  }
  assert.equal(mounts, 1);
  await render("/presale");
  assert.notEqual(host.querySelector("output"), page);
});
