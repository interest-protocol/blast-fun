import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { installTestDom, setInputValue, testEvent, waitFor } from "../../../test/fixtures/social/test-dom.ts";
import { discoveryState } from "./discovery-state.ts";

const { document } = installTestDom();
Object.assign(document, { oninput: null });
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient } = await import("@tanstack/react-query");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { SocialViewerProvider } = await import("../social/SignInGate.tsx");
const { PresalesList } = await import("./PresalesList");
const { fixtureList, FIXTURE_NOW } = await import("../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts");
const statuses = ["live", "upcoming", "ended"] as const;
const now = FIXTURE_NOW;
const getAccessToken = async () => "test-access-token";

async function mount(t: TestContext, path = "/presale", empty: boolean | "all" = false) {
  window.history.replaceState(null, "", path);
  const page = (status: typeof statuses[number], sort: string) => {
    const data = fixtureList(status, sort);
    if (empty === "all") return { ...data, presales: [], status_counts: { live: 0, upcoming: 0, ended: 0 } };
    return empty && status === "upcoming" ? { ...data, presales: [] } : data;
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), window.location.origin);
    const selection = discoveryState(url.pathname.endsWith("/viewer") ? JSON.parse(String(init?.body ?? "{}")) : Object.fromEntries(url.searchParams));
    const data = page(selection.status, selection.sort);
    return Response.json(url.pathname.endsWith("/viewer") ? { presales: {}, rows: data.presales } : data);
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  const watchlist = {
    ids: new Set<string>(), signedIn: true,
    load: async (status: typeof statuses[number]) => ({ rows: page(status, "backed").presales, total: 2 }),
  };
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  });
  const pressed = (group: string) => container.querySelector(`[aria-label="${group}"] [aria-pressed="true"]`)?.textContent ?? "";
  const selectedTab = () => container.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? "";
  // The URL is the source of truth: wait until the rendered View matches it.
  const viewMatchesUrl = () => pressed("View") === (new URLSearchParams(window.location.search).get("view") === "calendar" ? "Calendar" : "Browse");
  const render = async () => {
    const selection = discoveryState(Object.fromEntries(new URLSearchParams(window.location.search)));
    await act(async () => root.render(
      <QueryProvider client={client}>
        <SocialViewerProvider signedIn getAccessToken={getAccessToken}>
          <PresalesList {...selection} initial={page(selection.status, selection.sort)} nowMs={now} watchlist={watchlist} />
        </SocialViewerProvider>
      </QueryProvider>,
    ));
    await waitFor(viewMatchesUrl, "the list to render the View in the URL");
  };
  await render();
  const click = async (selector: string, label: string, done: () => boolean) => {
    // Panels load after a View change, so wait for the control too.
    const button = await waitFor(() => [...container.querySelectorAll<HTMLButtonElement>(selector)].find(b => b.textContent?.startsWith(label)), `the ${label} control`);
    await act(async () => button.click());
    await waitFor(done, `${label} to take effect`);
  };
  const browseShows = (status: typeof statuses[number]) => {
    assert.equal(container.querySelector('[aria-label="View"] button[aria-pressed="true"]')?.textContent, "Browse");
    assert.equal(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.split(" ")[0], { live: "Live", upcoming: "Upcoming", ended: "Ended" }[status]);
    assert.equal(new URLSearchParams(window.location.search).get("status") ?? "live", status);
    assert.equal(new URLSearchParams(window.location.search).has("calendarRange"), false);
    const id = fixtureList(status, "backed").presales[0]!.presale_id;
    assert.ok(container.querySelector(`.presale-grid a[href="/presale/${id}"], .rows2 a[href="/presale/${id}"]`), `${status} listings are visible`);
    return true;
  };
  return {
    container, pressed,
    /** Retry an assertion until the page shows it; loads and restores settle on their own time. */
    expect: (check: () => void, description: string) => waitFor(() => { check(); return true; }, description),
    assertBrowse: (status: typeof statuses[number]) => waitFor(() => browseShows(status), `Browse to show ${status} listings`),
    click: (selector: string, label: string, view: string) => click(selector, label, () => pressed("View") === view && viewMatchesUrl()),
    view: (label: string) => click('[aria-label="View"] button', label, () => pressed("View") === label && viewMatchesUrl()),
    status: (label: string) => click('[role="tab"]', label, () => selectedTab().startsWith(label)),
    range: (label: string) => click('[aria-label="Calendar event range"] button', label, () => pressed("Calendar event range").startsWith(label)),
    path: () => window.location.pathname + window.location.search,
    async restore(path: string) {
      // Supply the URL/popstate pair a browser produces; jsdom has no document navigation.
      await act(async () => { window.history.replaceState(null, "", path); window.dispatchEvent(new window.PopStateEvent("popstate")); });
      await waitFor(viewMatchesUrl, `the View restored from ${path}`);
    },
    async history(direction: "back" | "forward") {
      await act(async () => {
        const restored = new Promise<void>(resolve => window.addEventListener("popstate", () => resolve(), { once: true }));
        window.history[direction]();
        await restored;
      });
      await waitFor(viewMatchesUrl, `the View restored by ${direction}`);
    },
    async reload() {
      await act(async () => root.unmount());
      client.clear();
      root = createRoot(container);
      await render();
    },
  };
}

test("Live → Calendar → Browse restores Live and its listings even with no upcoming presales", async (t) => {
  const ui = await mount(t, "/presale", true);
  await ui.assertBrowse("live");
  await ui.view("Calendar");
  assert.equal(ui.path(), "/presale?view=calendar");
  await ui.view("Browse");
  await ui.assertBrowse("live");
  assert.equal(ui.path(), "/presale");
  assert.doesNotMatch(ui.container.textContent!, /No upcoming presales/);
});

test("the empty Calendar action returns to Browse in a quiet catalog", async (t) => {
  const ui = await mount(t, "/presale", "all");
  await ui.view("Calendar");
  await ui.expect(() => assert.match(ui.container.textContent!, /No upcoming events/), "No upcoming events");
  await ui.click("button", "Browse presales", "Browse");
  assert.equal(ui.path(), "/presale");
  await ui.expect(() => assert.match(ui.container.textContent!, /No live presales/), "No live presales");
  assert.doesNotMatch(ui.container.textContent!, /Browse upcoming presales/);
});

test("Browse search and its matching listings survive a Calendar round trip", async (t) => {
  const ui = await mount(t);
  const query = fixtureList("live", "ending").presales[0]!.symbol;
  const input = ui.container.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(async () => { setInputValue(input, query); input.dispatchEvent(testEvent("input")); });
  const links = () => [...ui.container.querySelectorAll(".presale-grid [data-list-row]")].map(row => row.getAttribute("data-list-row"));
  await ui.expect(() => assert.equal(links().length, 1), "one matching listing");
  const matches = links();
  await ui.view("Calendar");
  await ui.range("All");
  await ui.view("Browse");
  assert.equal(ui.container.querySelector<HTMLInputElement>('input[type="search"]')?.value, query);
  assert.deepEqual(links(), matches);
  assert.equal(ui.path(), "/presale");
});

for (const status of statuses) {
  for (const range of ["Upcoming", "Past", "All"]) {
    test(`${status} survives Calendar ${range} without inheriting its event range`, async (t) => {
      const ui = await mount(t);
      await ui.status({ live: "Live", upcoming: "Upcoming", ended: "Ended" }[status]);
      await ui.assertBrowse(status);
      await ui.view("Calendar");
      await ui.range(range);
      assert.equal(new URLSearchParams(window.location.search).get("status") ?? "live", status);
      await ui.expect(() => assert.ok(ui.pressed("Calendar event range").startsWith(range)), `Calendar range ${range}`);
      await ui.view("Browse");
      await ui.assertBrowse(status);
    });
  }
}

for (const calendarRange of ["upcoming", "past", "all"]) {
  test(`direct Calendar ${calendarRange} entry returns to Live, including after reload`, async (t) => {
    const ui = await mount(t, `/presale?view=calendar&calendarRange=${calendarRange}`);
    await ui.reload();
    await ui.view("Browse");
    await ui.assertBrowse("live");
    assert.equal(ui.path(), "/presale");
    await ui.reload();
    await ui.assertBrowse("live");
  });
}

for (const [status, sort, scope] of [["live", "backed", "all"], ["upcoming", "interest", "watch"], ["ended", "best", "following"]] as const) {
  test(`Calendar preserves ${status} Browse sort, ${scope} scope and list layout across reload`, async (t) => {
    const ui = await mount(t, `/presale?status=${status}&sort=${sort}&scope=${scope}&layout=list`);
    await ui.view("Calendar");
    await ui.range("Past");
    const calendarPath = ui.path();
    await ui.reload();
    await ui.expect(() => assert.ok(ui.pressed("Calendar event range").startsWith("Past")), `Calendar range ${"Past"}`);
    await ui.view("Browse");
    await ui.assertBrowse(status);
    const browsePath = ui.path();
    assert.equal(new URLSearchParams(window.location.search).get("sort"), sort);
    assert.equal(new URLSearchParams(window.location.search).get("scope") ?? "all", scope);
    assert.equal([...ui.container.querySelectorAll('[aria-label="Result layout"] button')].find((button) => button.textContent === "List")?.getAttribute("aria-pressed"), "true");
    assert.equal(ui.container.querySelector('button[aria-label^="Filters,"]')?.getAttribute("aria-label"), `Filters, ${{ backed: "Most backers", interest: "Most interested", best: "Best since launch" }[sort]}${scope === "watch" ? ", Watchlist" : ""}`);
    await ui.restore(calendarPath);
    await ui.expect(() => assert.equal(ui.pressed("View"), "Calendar"), "the Calendar view");
    await ui.restore(browsePath);
    await ui.assertBrowse(status);
    await ui.reload();
    await ui.assertBrowse(status);
    assert.equal(ui.path(), browsePath);
  });
}

test("Back/Forward restores different Browse statuses and Calendar selections from the URL", async (t) => {
  const ui = await mount(t);
  await ui.status("Ended");
  await ui.view("Calendar");
  await ui.range("All");
  const calendarPath = ui.path();
  await ui.history("back");
  await ui.expect(() => assert.ok(ui.pressed("Calendar event range").startsWith("Upcoming")), `Calendar range ${"Upcoming"}`);
  await ui.history("back");
  await ui.assertBrowse("ended");
  await ui.history("back");
  await ui.assertBrowse("live");
  await ui.history("forward");
  await ui.assertBrowse("ended");
  await ui.history("forward");
  await ui.history("forward");
  assert.equal(ui.path(), calendarPath);
  await ui.expect(() => assert.ok(ui.pressed("Calendar event range").startsWith("All")), `Calendar range ${"All"}`);
  await ui.reload();
  await ui.view("Browse");
  await ui.assertBrowse("ended");
});
