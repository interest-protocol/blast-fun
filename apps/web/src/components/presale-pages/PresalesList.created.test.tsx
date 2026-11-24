import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient } = await import("@tanstack/react-query");
const { AppRouterContext } = await import("next/dist/shared/lib/app-router-context.shared-runtime");
const { RedirectBoundary } = await import("next/dist/client/components/redirect-boundary");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { SocialViewerProvider } = await import("../social/SignInGate.tsx");
const { PresalesList } = await import("./PresalesList");
const { fixtureList, FIXTURE_NOW } = await import(
  "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts"
);

test("an old ?view=mine link sends a signed-in viewer to their profile and shows Live to a visitor", async (t) => {
  window.history.replaceState(null, "", "/presale?view=mine");
  const originalFetch = globalThis.fetch;
  const reads: string[] = [];
  globalThis.fetch = async (input) => {
    reads.push(String(input));
    return Response.json({ presales: {}, rows: [], following: [], entries: [] });
  };
  const replaced: string[] = [];
  const router = {
    bfcacheId: "test",
    back() {},
    forward() {},
    refresh() {},
    hmrRefresh() {},
    push() {},
    replace(href: string) {
      replaced.push(href);
      window.history.replaceState(null, "", href);
    },
    prefetch: async () => {},
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const publicPage = fixtureList("live", "pinned");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container, {
    onCaughtError(error) {
      if (!(error instanceof Error) || error.message !== "NEXT_REDIRECT") throw error;
    },
  });
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  });
  const render = (signedIn: boolean) => (
    <AppRouterContext value={router}>
      <RedirectBoundary>
        <QueryProvider client={client}>
          <SocialViewerProvider callsign="creator" getAccessToken={async () => "creator-token"} signedIn={signedIn}>
            <PresalesList initial={publicPage} nowMs={FIXTURE_NOW} sort="pinned" status="live" view="list" />
          </SocialViewerProvider>
        </QueryProvider>
      </RedirectBoundary>
    </AppRouterContext>
  );

  await act(async () => root.render(render(false)));
  assert.deepEqual(replaced, []);
  const tabs = [...container.querySelectorAll('[role="tab"]')];
  assert.deepEqual(tabs.map(tab => tab.textContent), ["Live", "Upcoming", "Ended"]);
  assert.equal(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent, "Live");
  assert.ok(container.textContent?.includes(publicPage.presales[0]!.name));

  await act(async () => root.render(render(true)));
  assert.deepEqual(replaced, ["/@creator"]);
  assert.ok(!reads.some(url => url.includes("/presales/created")), "the created list is no longer read here");
});
