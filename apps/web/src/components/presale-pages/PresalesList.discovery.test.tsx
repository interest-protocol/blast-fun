import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { installTestDom, testEvent } from "../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient } = await import("@tanstack/react-query");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { SocialViewerProvider } = await import("../social/SignInGate.tsx");
const { PresalesList, PresaleRow } = await import("./PresalesList");
const { fixtureList, fixtureViewer, FIXTURE_NOW } = await import("../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts");
const token = async () => "fixture-token";

async function setup(t: TestContext, answer: () => Promise<{ rows: ReturnType<typeof fixtureList>["presales"]; total: number } | null>, scope?: "watch", path = scope ? "/presale?sort=backed&scope=watch" : "/presale") {
  window.history.replaceState(null, "", path);
  const originalFetch = globalThis.fetch;
  const live = fixtureList("live", "ending");
  const publicReads: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "http://127.0.0.1");
    if (url.pathname.endsWith("/viewer")) return Response.json({ rows: [], presales: {} });
    publicReads.push(url.search);
    return Response.json(fixtureList((url.searchParams.get("status") ?? "live") as "live" | "upcoming" | "ended", url.searchParams.get("sort") ?? "ending"));
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const container = document.createElement("div"); container.setAttribute("data-blast-ui", ""); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); globalThis.fetch = originalFetch; });
  await act(async () => root.render(<QueryProvider client={client}><SocialViewerProvider signedIn getAccessToken={token}>
    <PresalesList initial={live} nowMs={FIXTURE_NOW} sort={scope ? "backed" : "ending"} scope={scope} status="live" view="list" watchlist={{ ids: new Set(), signedIn: true, load: answer }} />
  </SocialViewerProvider></QueryProvider>));
  const toggleFilters = () => act(async () => container.querySelector<HTMLButtonElement>('button[aria-label^="Filters"]')!.click());
  const click = async (label: string) => {
    if (label === "Watchlist") {
      await toggleFilters();
      await act(async () => Array.from(document.querySelectorAll("button")).find(button => button.textContent === "Watchlist only")!.click());
      await toggleFilters();
      return;
    }
    await act(async () => {
      const button = [...container.querySelectorAll("button")].find(item => item.textContent?.trim() === label);
      assert.ok(button, label);
      button.click();
    });
  };
  const sort = async (label: string) => {
    await toggleFilters();
    const field = document.querySelector<HTMLSelectElement>('select')!;
    assert.deepEqual(Array.from(field.options, option => option.text), ["Ending soon", "Most backers"]);
    await act(async () => {
      field.value = Array.from(field.options).find(option => option.text === label)!.value;
      field.dispatchEvent(testEvent("change", { bubbles: true }));
    });
    await toggleFilters();
  };
  const names = () => [...container.querySelectorAll("#plist .sr-name > b, #plist .sr-title > b")].map((item) => item.textContent);
  return { container, click, sort, names, live, publicReads };
}

test("Watchlist retains either Live order through toggles, lifecycle changes, reload entry, and history restoration", async (t) => {
  const live = fixtureList("live", "ending");
  const rows = [
    { ...live.presales[0], name: "Soon", end_ms: FIXTURE_NOW + 600_000, participants: 1 },
    { ...live.presales[1], name: "Popular", end_ms: FIXTURE_NOW + 1_200_000, participants: 4 },
  ];
  const page = await setup(t, async () => ({ rows, total: 2 }));
  assert.deepEqual(page.names(), page.live.presales.map((sale) => sale.name));
  await page.click("Watchlist");
  assert.deepEqual(page.names(), ["Soon", "Popular"]);
  assert.equal(window.location.search, "?scope=watch");
  assert.ok(page.container.querySelector('[aria-label^="Filters"][aria-label$=", Watchlist"]'));
  await page.sort("Most backers");
  assert.deepEqual(page.names(), ["Popular", "Soon"]);
  assert.equal(window.location.search, "?sort=backed&scope=watch");
  await page.click("Watchlist");
  assert.equal(window.location.search, "?sort=backed");
  assert.ok(page.container.querySelector('[aria-label^="Filters, Most backers"]'));
  assert.ok(page.publicReads.some((query) => new URLSearchParams(query).get("sort") === "backed"));
  await page.click("Watchlist");
  assert.deepEqual(page.names(), ["Popular", "Soon"]);
  const historyLength = window.history.length;
  await act(async () => {
    window.history.replaceState(null, "", "/presale?scope=watch");
    window.dispatchEvent(testEvent("popstate"));
  });
  assert.deepEqual(page.names(), ["Soon", "Popular"]);
  assert.equal(window.history.length, historyLength, "restoration never writes another history entry");
  await act(async () => {
    window.history.replaceState(null, "", "/presale?sort=backed&scope=watch");
    window.dispatchEvent(testEvent("popstate"));
  });
  assert.deepEqual(page.names(), ["Popular", "Soon"]);
  await page.click("Upcoming");
  assert.ok(page.container.querySelector('[aria-label^="Filters"][aria-label$=", Watchlist"]'));
  assert.equal(page.container.querySelector('[aria-label="Sort presales: Opening soon"]'), null);
  await page.click("Ended");
  assert.ok(page.container.querySelector('[aria-label^="Filters"][aria-label$=", Watchlist"]'));
  assert.equal(page.container.querySelector('[aria-label="Sort presales: Recently ended"]'), null);
});

test("direct Watchlist entry uses its chosen order instead of the public seed", async (t) => {
  const live = fixtureList("live", "ending");
  const page = await setup(t, async () => ({ rows: [live.presales[0], live.presales[1]], total: 2 }), "watch");
  assert.deepEqual(page.names(), [...live.presales.slice(0, 2)].sort((a, b) => b.participants - a.participants).map((row) => row.name));
});

test("returning to a cached server seed restores the current URL's scope and order", async (t) => {
  const live = fixtureList("live", "ending");
  const page = await setup(t, async () => ({ rows: live.presales.slice(0, 2), total: 2 }), undefined, "/presale?sort=backed&scope=watch");
  assert.ok(page.container.querySelector('[aria-label^="Filters"][aria-label$=", Watchlist"]'));
  assert.ok(page.container.querySelector('[aria-label^="Filters, Most backers"]'));
  assert.deepEqual(page.names(), [...live.presales.slice(0, 2)].sort((a, b) => b.participants - a.participants).map((row) => row.name));
  assert.equal(window.location.search, "?sort=backed&scope=watch");
});

for (const total of [0, 2]) test(`Watchlist empty state uses the successful total (${total}) and can show all without changing sort`, async (t) => {
  const page = await setup(t, async () => ({ rows: [], total }), "watch");
  assert.match(page.container.textContent!, total === 0 ? /No saved presales yet.*Add to watchlist/ : /No live presales in your watchlist/);
  if (total !== 0) assert.doesNotMatch(page.container.textContent!, /No saved presales yet/);
  await page.click("Show all live presales");
  assert.equal(window.location.search, "?sort=backed");
  assert.ok(page.names().length);
});

test("a pending or failed Watchlist read cannot become an empty watchlist", async (t) => {
  const pending = Promise.withResolvers<{ rows: ReturnType<typeof fixtureList>["presales"]; total: number } | null>();
  const page = await setup(t, () => pending.promise, "watch");
  assert.ok(page.container.querySelector('[aria-label="Loading presales"]'));
  assert.doesNotMatch(page.container.textContent!, /No saved presales|No live presales/);
  await act(async () => pending.resolve(null));
  assert.ok(page.container.querySelector('[role="alert"]'));
  assert.doesNotMatch(page.container.textContent!, /No saved presales|No live presales/);
});

test("social attribution uses the actual named backers and stays visible outside the avatar tooltip", async (t) => {
  const container = document.createElement("div"); container.setAttribute("data-blast-ui", ""); document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); container.remove(); });
  const sale = fixtureList("live", "ending").presales[0];
  const entry = Object.values(fixtureViewer()).find((item) => item.following.length >= 2)!;
  const viewer = { [sale.presale_id]: { ...entry, following: entry.following.slice(0, 2) } };
  await act(async () => root.render(<PresaleRow sale={sale} now={FIXTURE_NOW} viewer={viewer} />));
  assert.equal(container.querySelector(".sr-social")?.textContent, "2 people you follow backed");
  await act(async () => root.render(<PresaleRow sale={sale} now={FIXTURE_NOW} viewer={{ [sale.presale_id]: { ...entry, following: entry.following.slice(0, 1) } }} />));
  assert.equal(container.querySelector(".sr-social")?.textContent, `${entry.following[0].account.display_name ?? entry.following[0].account.callsign} backed`);
  assert.equal(container.querySelector(".sr-social-text")?.getAttribute("title"), container.querySelector(".sr-social")?.textContent);
  await act(async () => root.render(<PresaleRow sale={sale} now={FIXTURE_NOW} viewer={null} />));
  assert.equal(container.querySelector(".sr-social"), null);
});
