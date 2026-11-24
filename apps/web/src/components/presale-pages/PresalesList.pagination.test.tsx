import assert from "node:assert/strict";
import test from "node:test";

import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient } = await import("@tanstack/react-query");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { settleQueries } = await import("#web/lib/query/test-client.ts");
const { PresalesList } = await import("./PresalesList");
const { fixtureList, FIXTURE_NOW } = await import("../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts");
const { SocialViewerProvider } = await import("../social/SignInGate.tsx");
const { WatchedPresalesList } = await import("./watched");
const getAccessToken = async () => "test-access-token";

for (const mode of ["filter", "server", "watchlist", "calendar", "calendar-live", "calendar-ended", "pagination"] as const) {
  const path = mode === "watchlist" ? "/presale?sort=watch" : "/presale";
  test(`a failed presale ${mode} read keeps safe diagnostics and recovers on retry`, async (t) => {
    t.mock.method(Date, "now", () => FIXTURE_NOW);
    window.history.replaceState(null, "", path);
    const originalFetch = globalThis.fetch;
    let unavailable = true;
    const seed = fixtureList("live", "pinned");
    const first = { ...seed, presales: seed.presales.map((sale) => ({ ...sale, start_ms: Date.now() - 60_000, end_ms: Date.now() + 3_600_000 })) };
    const recovered = mode === "filter" || mode === "calendar" ? fixtureList("upcoming", "opening") : mode === "pagination" ? { ...first, presales: [{ ...first.presales[0]!, presale_id: `0x${"a".repeat(64)}`, name: "Recovered page" }], next_cursor: null } : first;
    globalThis.fetch = async (url) => (mode === "calendar-live" || mode === "calendar-ended") && !String(url).includes(mode === "calendar-live" ? "status=live" : "status=ended")
      ? Response.json({ ...fixtureList("upcoming", "opening"), presales: [] })
      : unavailable
      ? Response.json({ error: { code: "PRIVATE_PROVIDER_SECRET", message: "PRIVATE_PROVIDER_SECRET" } }, { status: 503, headers: { "x-request-id": "presale-list-ref" } })
      : Response.json(mode === "watchlist" ? { items: recovered.presales.map((presale) => ({ presale, starred: true, followed: false, added_ms: Date.now() })), total: recovered.presales.length, next_cursor: null, as_of: recovered.as_of } : recovered);
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
    const props = { initial: mode === "server" ? null : mode === "pagination" ? { ...first, next_cursor: "diagnostic-next" } : first, nowMs: Date.now(), sort: mode === "watchlist" ? "watch" : "pinned", status: "live", view: "list" } as const;
    await act(async () => root.render(
      <QueryProvider client={client}>
        {mode === "watchlist" ? <SocialViewerProvider signedIn getAccessToken={getAccessToken}><WatchedPresalesList {...props} /></SocialViewerProvider> : <PresalesList {...props} />}
      </QueryProvider>,
    ));
    await act(async () => settleQueries(client));
    const action = mode === "filter" ? "Upcoming" : mode === "calendar" || mode === "calendar-live" || mode === "calendar-ended" ? "Calendar" : mode === "pagination" ? "Show more" : null;
    if (action) await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === action)!.click();
    });
    await act(async () => settleQueries(client));
    assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /Code: service_unavailable\. Reference: presale-list-ref\./);
    assert.doesNotMatch(container.textContent!, /PRIVATE_PROVIDER_SECRET/);
    if (mode === "pagination") assert.ok(container.textContent?.includes(first.presales[0]!.name), "a failed next page keeps the existing rows");
    unavailable = false;
    await act(async () => {
      [...container.querySelectorAll("button")].find((button) => button.textContent === (mode === "pagination" ? "Show more" : "Try again"))!.click();
    });
    await act(async () => settleQueries(client));
    assert.equal(container.querySelector('[role="alert"]'), null);
    assert.ok(container.textContent?.includes(recovered.presales[0]!.name));
  });
}

test("a cached empty presales filter stays visible while it refreshes", async (t) => {
  window.history.replaceState(null, "", "/presale");
  const originalFetch = globalThis.fetch;
  const response = Promise.withResolvers<Response>();
  globalThis.fetch = async (input) => new URL(String(input), window.location.origin).searchParams.get("status") === "live"
    ? Response.json(fixtureList("live", "pinned"))
    : (await response.promise).clone();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 60_000 } } });
  const { presaleListQuery } = await import("../social/queries.ts");
  const empty = { ...fixtureList("upcoming", "opening"), presales: [], next_cursor: null };
  client.setQueryData(presaleListQuery({ status: "upcoming", sort: "opening" }).queryKey, empty, { updatedAt: Date.now() - 60_000 });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  });
  await act(async () => root.render(<QueryProvider client={client}><PresalesList initial={fixtureList("live", "pinned")} nowMs={FIXTURE_NOW} sort="pinned" status="live" view="list" /></QueryProvider>));
  await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Upcoming")!.click());
  assert.equal(!!container.querySelector('[aria-label="Loading presales"]'), false);
  assert.match(container.textContent!, /No upcoming presales/);
  await act(async () => {
    response.resolve(Response.json(empty));
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  assert.equal(!!container.querySelector('[aria-label="Loading presales"]'), false);
  assert.match(container.textContent!, /No upcoming presales/);
  await act(async () => [...container.querySelectorAll("button")].find((button) => button.textContent === "Browse live presales")!.click());
  assert.equal(container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.split(" ")[0], "Live");
  assert.ok(container.querySelector(".presale-grid a"));
});

for (const changeFilter of [false, true]) {
  test(changeFilter ? "a delayed pagination response never appends under another filter" : "pagination appends while its filter is still current", async (t) => {
    window.history.replaceState(null, "", "/presale");
    const first = fixtureList("live", "pinned");
    // A full first page (18 cards) so the grid has nothing left to fill and waits for "Show more".
    const seed = fixtureList("upcoming", "opening");
    const upcoming = { ...seed, presales: Array.from({ length: 18 }, (_, index) => ({ ...seed.presales[0]!, presale_id: `0x${(index + 1).toString(16).padStart(64, "0")}` })), next_cursor: "next-upcoming" };
    const originalFetch = globalThis.fetch;
    const more = Promise.withResolvers<Response>();
    const filtered = Promise.withResolvers<Response>();
    let pageRequested = false;
    globalThis.fetch = async (input) => {
      const url = new URL(String(input), "http://127.0.0.1");
      if (url.searchParams.get("cursor") === "next-live") {
        pageRequested = true;
        return more.promise;
      }
      assert.equal(url.searchParams.get("status"), "upcoming");
      return filtered.promise;
    };
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    t.after(async () => {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
      globalThis.fetch = originalFetch;
    });
    await act(async () => root.render(
      <QueryProvider client={client}>
        <PresalesList initial={{ ...first, next_cursor: "next-live" }} nowMs={FIXTURE_NOW} sort="pinned" status="live" view="list" />
      </QueryProvider>,
    ));
    const button = (label: string) => {
      const found = [...container.querySelectorAll("button")].find((element) => element.textContent === label);
      assert.ok(found, label);
      return found;
    };
    // The grid is short of a full page, so it reads the next page itself, before any click.
    assert.equal(pageRequested, true);
    if (changeFilter) {
      await act(async () => button("Upcoming").click());
      assert.ok(container.querySelector('[aria-label="Loading presales"]'));
      assert.doesNotMatch(container.textContent!, /Show more/);
      assert.ok(!container.textContent?.includes(first.presales[0]!.name), "the old filter's rows are not shown as upcoming");
      await act(async () => {
        filtered.resolve(Response.json(upcoming));
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      assert.ok(container.textContent?.includes(upcoming.presales[0]!.name));
      assert.equal(button("Show more").disabled, false, "the new filter can page while the obsolete read finishes");
    }
    await act(async () => {
      more.resolve(Response.json({ ...first, presales: [{ ...first.presales[0], presale_id: `0x${"b".repeat(64)}`, name: "Later Live" }], next_cursor: null }));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    assert.equal(container.textContent?.includes("Later Live"), !changeFilter);
    if (changeFilter) {
      assert.ok(container.textContent?.includes(upcoming.presales[0]!.name));
      assert.equal(button("Show more").disabled, false);
    }
  });
}

test("calendar ranges persist through URLs, remounts, and browser history without changing lifecycle filters", async (t) => {
  window.history.replaceState(null, "", "/presale?view=calendar&status=ended");
  const instant = Date.now();
  const base = fixtureList("live", "ending");
  const page = { ...base, presales: [{ ...base.presales[0]!, start_ms: instant - 60_000, end_ms: instant + 3_600_000 }] };
  const empty = { ...base, presales: [], next_cursor: null };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement("div");
  document.body.append(container);
  let root = createRoot(container);
  const props = { calendar: empty, calendarLive: page, calendarEnded: empty, initial: empty, nowMs: instant, sort: "recent", status: "ended", view: "calendar" } as const;
  const render = (range: "upcoming" | "past" | "all") => <QueryProvider client={client}><PresalesList {...props} calendarRange={range} /></QueryProvider>;
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  const selected = () => container.querySelector('[aria-label="Calendar event range"] [aria-pressed="true"]')?.textContent;
  const rows = () => container.querySelectorAll("a.cal-item").length;
  const choose = async (label: string) => act(async () => {
    [...container.querySelectorAll('[aria-label="Calendar event range"] button')].find((button) => button.textContent?.startsWith(label))!.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await act(async () => root.render(render("upcoming")));
  assert.equal(selected(), "Upcoming1");
  assert.equal(rows(), 1);
  await choose("Past");
  const pastPath = window.location.pathname + window.location.search;
  assert.match(window.location.search, /calendarRange=past/);
  assert.equal(new URLSearchParams(window.location.search).get("status"), "ended");
  assert.equal(selected(), "Past1");
  assert.equal(rows(), 1);
  assert.match(container.textContent!, /Scheduled opening/);
  await choose("All");
  assert.equal(selected(), "All2");
  assert.equal(rows(), 2);
  const allPath = window.location.pathname + window.location.search;
  // jsdom does not drive navigation reliably; emit the URL and popstate pair a browser produces.
  await act(async () => { window.history.replaceState(null, "", pastPath); window.dispatchEvent(new window.PopStateEvent("popstate")); });
  assert.equal(selected(), "Past1");
  await act(async () => { window.history.replaceState(null, "", allPath); window.dispatchEvent(new window.PopStateEvent("popstate")); });
  assert.equal(selected(), "All2");
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(render("all")));
  assert.equal(selected(), "All2");
  assert.equal(rows(), 2);
  assert.equal(container.querySelectorAll('a.cal-item a, a.cal-item button').length, 0);
});
