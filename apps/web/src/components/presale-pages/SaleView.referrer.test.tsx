import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

const { document, window } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { fixtureDetail, FIXTURE_NOW } = await import("../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts");
const { SaleView } = await import("./SaleView");

for (const [path, label, href] of [
  ["/@broken%", "Presales", "/presale"],
  ["/@broken%E0%A4%A", "Presales", "/presale"],
  ["/@kai%20name", "@kai name", "/@kai%20name"],
  ["/portfolio/launches?sort=recent", "Back to claims", "/portfolio/launches?sort=recent"],
  ["/portfolio/coins", "Presales", "/presale"],
  ["/portfolio/vestings/0x1", "Presales", "/presale"],
  ["/@kai/", "@kai/", "/@kai"],
  ["/", "Home", "/"],
  ["/feed", "Home", "/feed"],
  ["/presale", "Presales", "/presale"],
  ["/presale/current", "Presales", "/presale"],
  ["/presale/other", "Presales", "/presale"],
  ["/portfolio", "Back to coins", "/portfolio"],
  ["/portfolio/presales", "Back to presales", "/portfolio/presales"],
  ["/portfolio/vestings", "Back to claims", "/portfolio/vestings"],
  ["/portfolio/rewards", "Back to claims", "/portfolio/rewards"],
  ["/portfolio/launches", "Back to claims", "/portfolio/launches"],
  ["/portfolio/claims", "Back to claims", "/portfolio/claims"],
  ["/settings", "Settings", "/settings"],
  ["/notifications", "Notifications", "/notifications"],
  ["/notifications/x", "Presales", "/presale"],
  ["/crew/kai", "Presales", "/presale"],
  ["/invites", "Presales", "/presale"],
]) {
  test(`the sale back link safely labels the referrer ${path}`, async () => {
    window.history.pushState({}, "", "/presale/current");
    Object.defineProperty(document, "referrer", { value: `${window.location.origin}${path}`, configurable: true });
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = createTestQueryClient();
    const beforeFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(null, { status: 503 });
    try {
      await act(async () => root.render(withQueryClient(client,
        <SaleView detail={fixtureDetail("mrdn")} nowMs={FIXTURE_NOW} viewerEntry={null} />,
      )));
      const back = container.querySelector(".backbar a");
      assert.ok(back);
      assert.equal(back.textContent, label);
      assert.equal(back.getAttribute("href"), href);
    } finally {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
      globalThis.fetch = beforeFetch;
    }
  });
}
