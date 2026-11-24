import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient } = await import("@tanstack/react-query");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { SocialViewerProvider } = await import("../SignInGate");
const { ViewerStateStore } = await import("../viewer-state-store");
const { ProfileFollow } = await import("./IdentityCard");

test("a rejected follow clears its busy state, shows an error, and can be retried", async (t) => {
  const rejected = Promise.withResolvers<never>();
  const write = t.mock.method(ViewerStateStore.prototype, "setFollowing", () => rejected.promise);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });
  await act(async () => root.render(
    <QueryProvider client={client}>
      <SocialViewerProvider callsign="viewer" signedIn>
        <ProfileFollow callsign="nova" followingHint={false} />
      </SocialViewerProvider>
    </QueryProvider>,
  ));
  const button = container.querySelector("button")!;
  await act(async () => button.click());
  assert.equal(write.mock.callCount(), 1);
  assert.equal(button.getAttribute("aria-busy"), "true");
  await act(async () => rejected.reject(new Error("Unexpected write failure")));
  assert.equal(button.hasAttribute("aria-busy"), false);
  assert.ok(container.querySelector('[role="alert"]'));
  await act(async () => button.click());
  assert.equal(write.mock.callCount(), 2);
  assert.equal(button.hasAttribute("aria-busy"), false);
});
