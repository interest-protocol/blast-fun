import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient } = await import("@tanstack/react-query");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { SocialViewerProvider } = await import("../social/SignInGate.tsx");
const { PresalesList } = await import("./PresalesList");
const { fixtureList, FIXTURE_NOW } = await import("../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts");

const { presaleListQuery } = await import("../social/queries.ts");

const getAccessToken = async () => "test-token";

test("each section selects immediately, owns its loading panel, then shows its empty result", async (t) => {
  t.mock.method(Date, "now", () => FIXTURE_NOW);
  window.history.replaceState(null, "", "/presale");
  const originalFetch = globalThis.fetch;
  let pending = Promise.withResolvers<Response>();
  globalThis.fetch = async (input) => {
    const path = new URL(String(input), window.location.origin).pathname;
    if (path === "/api/social/presales") return pending.promise;
    return Response.json({ presales: {}, rows: [], following: [], entries: [] });
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  });
  await act(async () => root.render(
    <QueryProvider client={client}>
      <SocialViewerProvider signedIn getAccessToken={getAccessToken}>
        <PresalesList initial={fixtureList("live", "pinned")} nowMs={FIXTURE_NOW} sort="pinned" status="live" view="list" />
      </SocialViewerProvider>
    </QueryProvider>,
  ));
  const assertSelected = (label: string) => {
    const selected = container.querySelectorAll<HTMLElement>('[role="tab"][aria-selected="true"]');
    assert.equal(selected.length, 1);
    assert.ok(selected[0].textContent?.startsWith(label));
    const panels = container.querySelectorAll('[role="tabpanel"]:not([hidden])');
    assert.equal(panels.length, 1);
    assert.equal(panels[0].id, selected[0].getAttribute("aria-controls"));
    const parentSelection = container.querySelectorAll('[aria-label="View"] button[aria-pressed="true"]');
    assert.equal(parentSelection.length, 1);
    assert.equal(parentSelection[0].textContent, "Browse");
    return panels[0];
  };
  assertSelected("Live");
  const labels = () => [...container.querySelectorAll('[role="tab"]')].map(tab => tab.textContent);
  assert.deepEqual(labels(), ["Live", "Upcoming", "Ended"]);
  for (const [label, status, sort, message] of [
    ["Upcoming", "upcoming", "opening", "No upcoming presales"],
    ["Ended", "ended", "recent", "No ended presales"],
    ["Live", "live", "pinned", "No live presales"],
  ] as const) {
    if (status === "live") client.removeQueries({ queryKey: presaleListQuery({ status, sort }).queryKey, exact: true });
    pending = Promise.withResolvers<Response>();
    const tab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(tab => tab.textContent?.startsWith(label))!;
    await act(async () => tab.click());
    const panel = assertSelected(label);
    assert.ok(panel.querySelector('[aria-label="Loading presales"]'), `${label} owns its loading indicator`);
    assert.equal(panel.querySelector('[aria-busy="true"]')?.id, "plist");
    await act(async () => {
      pending.resolve(Response.json({ ...fixtureList(status, sort), presales: [], status_counts: { live: 0, upcoming: 0, ended: 0 } }));
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    assert.ok(assertSelected(label).textContent?.includes(message), `${label} owns its empty result`);
    assert.equal(panel.querySelector('[aria-busy="true"]'), null);
    if (status === "live" || status === "upcoming") {
      assert.doesNotMatch(panel.textContent ?? "", /Browse (live|upcoming) presales/);
    }
  }
  assert.deepEqual(labels(), ["Live", "Upcoming", "Ended"], "the tabs carry no counts");
});
