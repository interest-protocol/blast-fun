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
const { bondingCatalogQuery, bondingFeaturedQuery } = await import("../bonding/bonding-client.ts");
const { PinnedLaunches } = await import("./PinnedLaunches.tsx");

const presales = fixtureList("live", "ending").presales;

/** The Bonding board's featured read: `featured` is true for pins and false for its "closest to graduation" stand-in. */
async function curves(featured: boolean, id = `0x${"01".repeat(32)}`) {
  const engine = discoveryFixtureEngine({ state: () => "serving", now: () => FIXTURE_TIMESTAMP_MS });
  const response = await handleDiscoveryRequest(new Request("https://blast.test/api/launchpad/discovery?catalog=featured"), engine, async () => featured ? [id] : []);
  return parseDiscoveryResponse(await response.json());
}

async function rankedCurves() {
  const engine = discoveryFixtureEngine({ state: () => "serving", now: () => FIXTURE_TIMESTAMP_MS });
  const response = await handleDiscoveryRequest(new Request("https://blast.test/api/launchpad/discovery?catalog=bonding&sort=progress&limit=12"), engine);
  return parseDiscoveryResponse(await response.json());
}

async function mount(t: TestContext, seed: Readonly<{ presales?: typeof presales; curves?: Awaited<ReturnType<typeof curves>>; ranking?: Awaited<ReturnType<typeof rankedCurves>>; now?: number; pinSeed?: string; fetch?: typeof fetch; seeded?: Readonly<{ presales?: typeof presales; curves?: BondingHeroSeed }> }>) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = seed.fetch ?? (async () => Response.json({ details: { tagline: null, cover: null, links: [] } }));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  if (seed.presales) client.setQueryData(featuredPresalesQuery().queryKey, seed.presales);
  if (seed.curves) client.setQueryData(bondingFeaturedQuery().queryKey, seed.curves);
  if (seed.ranking) client.setQueryData(bondingCatalogQuery("bonding", "progress", "", null).queryKey, seed.ranking);
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = originalFetch;
  });
  const now = seed.now ?? FIXTURE_NOW;
  await act(async () => root.render(<QueryProvider client={client}><PinnedLaunches curves={seed.seeded?.curves} now={now} nowMs={seed.seeded ? Date.now() : FIXTURE_NOW} initialPinSeed={seed.pinSeed ?? "page-b"} presales={seed.seeded?.presales} /></QueryProvider>));
  return container;
}

test("Home draws nothing when the only ranked curve has reached its target", async (t) => {
  const none = await mount(t, { presales: [], curves: await curves(false) });
  assert.equal(none.querySelector("section"), null);
});

test("Home can open on the highest ranked live curve with two pinned presales", async (t) => {
  const container = await mount(t, { presales, curves: await curves(false), ranking: await rankedCurves(), pinSeed: "page-a" });
  const slides = [...container.querySelectorAll(".slide:not([data-visual-copy])")];
  assert.equal(slides.length, 3);
  const first = container.querySelector(".slide:not([inert])");
  assert.match(first?.textContent ?? "", /Closest to graduation · 83\.33%/);
  assert.match(first?.textContent ?? "", /Pixel 7/);
  assert.equal(first?.querySelector("a")?.getAttribute("href"), `/coin/${encodeURIComponent(`0x${"12".repeat(31)}ff::meme::MEME`)}`);
});

test("Home shows the closest coin once when Blast has already pinned it", async (t) => {
  const container = await mount(t, { presales, curves: await curves(true, `0x${"12".repeat(32)}`), ranking: await rankedCurves() });
  assert.equal(container.querySelectorAll(".slide:not([data-visual-copy])").length, 3);
  assert.doesNotMatch(container.textContent ?? "", /Closest to graduation/);
});

test("Home continues past a ranked page containing only curves that reached their target", async (t) => {
  const ranked = await rankedCurves();
  assert.equal(ranked.section.state, "available");
  const { section } = ranked;
  const container = await mount(t, {
    presales,
    curves: await curves(false),
    pinSeed: "page-a",
    ranking: {
      ...ranked,
      section: { ...section, data: { rows: section.data.rows.slice(0, 1), nextCursor: "next-page" } },
    },
    fetch: async (input) => {
      if (String(input).includes("cursor=next-page")) {
        return Response.json({ ...ranked, section: { ...section, data: { rows: section.data.rows.slice(1), nextCursor: null } } });
      }
      return Response.json({ details: null });
    },
  });
  await waitFor(() => container.querySelector(".slide:not([inert])")?.textContent?.includes("Pixel 7"), "the live curve in the opening slide");
});

test("Home shuffles pinned curves together with presales", async (t) => {
  const pinned = await curves(true);
  const rows = pinned.section.state === "available" || pinned.section.state === "stale" ? pinned.section.data.rows : [];
  assert.ok(rows.length > 0, "the fixture engine has a curve to pin");
  const container = await mount(t, { presales, curves: pinned, pinSeed: "page-c" });
  assert.equal(container.querySelectorAll('[aria-roledescription="carousel"]').length, 1);
  const hrefs = [...container.querySelectorAll(".slide:not([data-visual-copy]) a")].map((link) => link.getAttribute("href"));
  assert.deepEqual(hrefs, [...rows.map((row) => `/coin/${encodeURIComponent(row.coinType)}`), ...presales.map((sale) => `/presale/${sale.presale_id}`)]);
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
