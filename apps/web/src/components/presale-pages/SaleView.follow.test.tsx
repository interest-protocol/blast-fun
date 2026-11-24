import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, withQueryClient } = await import("#web/lib/query/test-client.ts");
const { SocialViewerProvider } = await import("#web/components/social/SignInGate.tsx");
const { ViewerStateStore } = await import("#web/components/social/viewer-state-store.ts");
const { fixtureDetail, FIXTURE_NOW } = await import("../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts");
const { SaleView } = await import("./SaleView");

test("a rejected sale follow clears busy and allows another attempt", async () => {
  const original = ViewerStateStore.prototype.setFollowing;
  const originalFetch = globalThis.fetch;
  let attempts = 0;
  ViewerStateStore.prototype.setFollowing = async () => {
    attempts++;
    throw new Error("offline");
  };
  globalThis.fetch = async () => new Response(null, { status: 503 });
  const client = createTestQueryClient();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(withQueryClient(client,
      <SocialViewerProvider callsign="nova" signedIn>
        <SaleView detail={fixtureDetail("mrdn")} nowMs={FIXTURE_NOW} viewerEntry={null} />
      </SocialViewerProvider>,
    )));
    const button = container.querySelector<HTMLButtonElement>("button.follow")!;
    assert.ok(button);
    for (let attempt = 1; attempt <= 2; attempt++) {
      await act(async () => button.click());
      assert.equal(attempts, attempt);
      assert.equal(button.disabled, false);
    }
  } finally {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    ViewerStateStore.prototype.setFollowing = original;
    globalThis.fetch = originalFetch;
  }
});
