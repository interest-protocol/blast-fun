import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";

import { installTestDom, waitFor } from "../../../../test/fixtures/social/test-dom.ts";
import { discoveryFixtureEngine } from "../../../../../../packages/server/test/fixtures/modules/launchpad-discovery/fixture-engine.ts";
import { FIXTURE_TIMESTAMP_MS } from "../../../../../../packages/server/test/fixtures/modules/launchpad-contract/fixtures.ts";
import { fixtureList, FIXTURE_NOW } from "../../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { handleDiscoveryRequest } from "@blast/server/modules/launchpad-discovery/resource.ts";
import type { BondingHeroSeed } from "#web/lib/backend-api/bonding.ts";
import { parseDiscoveryResponse } from "@blast/core/modules/launchpad-discovery/rows.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { QueryClient } = await import("@tanstack/react-query");
const { QueryProvider } = await import("#web/lib/query/provider.tsx");
const { featuredPresalesQuery } = await import("../queries.ts");
const { bondingFeaturedQuery } = await import("../bonding/bonding-client.ts");
const { PinnedLaunches } = await import("./PinnedLaunches.tsx");

const presales = fixtureList("live", "ending").presales;

/** The Bonding board's featured read: `featured` is true for pins and false for its "closest to graduation" stand-in. */
async function curves(featured: boolean, id = `0x${"01".repeat(32)}`) {
  const engine = discoveryFixtureEngine({ state: () => "serving", now: () => FIXTURE_TIMESTAMP_MS });
  const response = await handleDiscoveryRequest(new Request("https://blast.test/api/launchpad/discovery?catalog=featured"), engine, async () => featured ? [id] : []);
  return parseDiscoveryResponse(await response.json());
}

async function mount(t: TestContext, seed: Readonly<{ presales?: typeof presales; curves?: Awaited<ReturnType<typeof curves>>; now?: number; fetch?: typeof fetch; launchpad?: boolean; seeded?: Readonly<{ presales?: typeof presales; curves?: BondingHeroSeed }> }>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = seed.fetch ?? (async () => Response.json({ details: { tagline: null, cover: null, links: [] } }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  if (seed.presales) client.setQueryData(featuredPresalesQuery().queryKey, seed.presales);
  if (seed.curves) client.setQueryData(bondingFeaturedQuery().queryKey, seed.curves);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  });
  const now = seed.now ?? FIXTURE_NOW;
  await act(async () => root.render(<QueryProvider client={client}><PinnedLaunches curves={seed.seeded?.curves} launchpad={seed.launchpad ?? true} now={now} nowMs={seed.seeded ? Date.now() : FIXTURE_NOW} initialPinSeed="page-b" presales={seed.seeded?.presales} /></QueryProvider>));
  return container;
}

test("Home draws nothing without a pin, and the Bonding stand-in is not a pin", async (t) => {
  const none = await mount(t, { presales: [], curves: await curves(false) });
  assert.equal(none.querySelector("section"), null);
});

test("shuffled presales come first, then pinned curves in their original order", async (t) => {
  const pinned = await curves(true);
  const rows = pinned.section.state === "available" || pinned.section.state === "stale" ? pinned.section.data.rows : [];
  assert.ok(rows.length > 0, "the fixture engine has a curve to pin");
  const container = await mount(t, { presales, curves: pinned });
  assert.equal(container.querySelectorAll('[aria-roledescription="carousel"]').length, 1);
  const hrefs = [...container.querySelectorAll(".slide:not([data-visual-copy]) a")].map((link) => link.getAttribute("href"));
  assert.deepEqual(hrefs, [...[...presales].reverse().map((sale) => `/presale/${sale.presale_id}`), ...rows.map((row) => `/coin/${encodeURIComponent(row.coinType)}`)]);
  assert.equal(container.querySelectorAll(".segment").length, hrefs.length, "one segment per slide");
});

test("a lone pinned graduated curve or presale shows as a static card", async (t) => {
  const curve = await mount(t, { presales: [], curves: await curves(true, `0x${"07".repeat(32)}`) });
  const coinType = `0x${"07".repeat(31)}ff::meme::MEME`;
  assert.equal(curve.querySelector("a")?.getAttribute("href"), `/coin/${encodeURIComponent(coinType)}`);
  assert.doesNotMatch(curve.textContent ?? "", /to graduat/);
  assert.equal(curve.querySelector("progress"), null);
  assert.equal(curve.querySelector(".timer, .segment"), null, "one slide does not rotate");
  const sale = await mount(t, { presales: [presales[0]!], curves: await curves(false) });
  assert.equal(sale.querySelectorAll("a").length, 1);
  assert.equal(sale.querySelector(".timer, .segment"), null);
});

test("a presale that has ended by the Home clock drops out", async (t) => {
  const sale = presales.find((candidate) => candidate.phase === "open");
  assert.ok(sale, "the fixture has an open presale");
  const container = await mount(t, { presales: [sale], curves: await curves(false), now: sale.end_ms + 1 });
  assert.equal(container.querySelector("section"), null);
});

test("a read that is out or failed draws nothing and does not throw", async (t) => {
  const out = await mount(t, { fetch: () => new Promise<Response>(() => undefined) });
  assert.equal(out.querySelector("section"), null);
  const failed = await mount(t, { fetch: async () => new Response("no", { status: 503 }) });
  assert.equal(failed.querySelector("section"), null);
});

test("the carousel names its slides as launches", async (t) => {
  const container = await mount(t, { presales, curves: await curves(true) });
  const label = container.querySelector('[role="status"]')?.getAttribute("aria-label");
  assert.match(label ?? "", /^Launch 1 of \d+$/);
});

test("without a server seed the bar fills in when the browser's reads answer", async (t) => {
  const raw = async () => (await handleDiscoveryRequest(new Request("https://blast.test/api/launchpad/discovery?catalog=featured"), discoveryFixtureEngine({ state: () => "serving", now: () => FIXTURE_TIMESTAMP_MS }), async () => [])).json() as Promise<Record<string, unknown>>;
  const body = { ...(await raw()), featured: true };
  const answer = async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/social/presales/featured")) return Response.json({ presales });
    if (url.includes("catalog=featured")) return Response.json(body);
    return Response.json({ details: { tagline: null, cover: null, links: [] } });
  };
  const container = await mount(t, { fetch: answer as typeof fetch });
  await waitFor(() => container.querySelector('[aria-roledescription="carousel"]'), "the carousel");
  assert.ok(container.querySelectorAll(".slide:not([data-visual-copy]) a").length > presales.length, "presales and curves both arrived");
});

test("server seeds paint the bar with no browser read", async (t) => {
  const pinned = await curves(true);
  const reads: string[] = [];
  const container = await mount(t, {
    fetch: (async (input: RequestInfo | URL) => { reads.push(String(input)); return Response.json({ details: { tagline: null, cover: null, links: [] } }); }) as typeof fetch,
    seeded: { presales, curves: { answer: pinned, details: {}, nowMs: Date.now() } },
  });
  assert.equal(container.querySelectorAll('[aria-roledescription="carousel"]').length, 1);
  assert.deepEqual(reads.filter((url) => url.includes("/featured")), [], "fresh seeds are not read again");
});

test("with the launchpad off the pinned curves neither show nor are read", async (t) => {
  const reads: string[] = [];
  const container = await mount(t, {
    launchpad: false,
    curves: await curves(true),
    presales: [presales[0]!],
    fetch: (async (input: RequestInfo | URL) => { reads.push(String(input)); return Response.json({}); }) as typeof fetch,
  });
  assert.equal(container.querySelectorAll("a").length, 1, "the presale only");
  assert.equal(reads.some((url) => url.includes("catalog=featured")), false);
});
