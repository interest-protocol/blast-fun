import assert from "node:assert/strict";
import test from "node:test";
import { createPartnerV1Read, type PartnerV1Handlers } from "@blast/server/modules/partner-api/v1/route.ts";
import { isVersionedPartnerPath } from "@blast/core/modules/backend-api/partner-http.ts";
import { partnerV1Route } from "@blast/server/modules/partner-api/v1/paths.ts";
import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";

const id = "0x" + "a".repeat(64);
const paths = [
  ["defillama/metadata", "v1/defillama/metadata"],
  ["defillama/metrics", "v1/defillama/metrics"],
  ["defillama/contracts", "v1/defillama/contracts"],
  ["presales", "social/presales"], ["presales/featured", "social/presales/featured"],
  [`presales/${id}`, `social/presales/${id}`], ["prices", "social/prices"],
  ["discovery", "launchpad/discovery"], ["search", "launchpad/search"],
  [`market/coins/${id}%3A%3Am%3A%3AC/candles`, `launchpad/market/coins/${id}%3A%3Am%3A%3AC/candles`],
  [`market/coins/${id}%3A%3Am%3A%3AC`, `launchpad/market/coins/${id}%3A%3Am%3A%3AC`],
  [`market/coins/${id}%3A%3Am%3A%3AC/metadata`, `v1/market/coins/${id}%3A%3Am%3A%3AC/metadata`],
  ["market/status", "launchpad/market/status"],
  [`market/coins/${id}%3A%3Am%3A%3AC/holders`, `launchpad/market/coins/${id}%3A%3Am%3A%3AC/holders`],
  [`market/launches/${id}/activity`, `launchpad/market/launches/${id}/activity`],
  [`market/pools/blast_curve/${id}`, `launchpad/market/pools/blast_curve/${id}`],
  [`market/pools/cetus/${id}`, `launchpad/market/pools/cetus/${id}`],
  [`market/pools/bluefin/${id}`, `launchpad/market/pools/bluefin/${id}`],
  [`market/pools/blast_curve/${id}/candles`, `launchpad/market/pools/blast_curve/${id}/candles`],
  [`market/pools/cetus/${id}/trades`, `launchpad/market/pools/cetus/${id}/trades`],
  [`market/launches/${id}/rewards`, `launchpad/market/launches/${id}/rewards`],
  [`market/launches/${id}/reward-rounds`, `launchpad/market/launches/${id}/reward-rounds`],
  [`market/wallets/${id}/launches`, `launchpad/market/wallets/${id}/launches`],
  [`market/wallets/${id}/launch-rewards`, `launchpad/market/wallets/${id}/launch-rewards`],
  [`market/wallets/${id}/launch-holder-rewards`, `launchpad/market/wallets/${id}/launch-holder-rewards`],
  ["market/partners", "launchpad/market/partners"],
  [`market/partners/${id}`, `launchpad/market/partners/${id}`],
  [`market/partners/${id}/launches`, `launchpad/market/partners/${id}/launches`],
  ["market/launchpad/policy", "launchpad/market/launchpad/policy"],
];
const headers = { cookie: "private", authorization: "Bearer private", "x-blast-partner-key": "private", "x-blast-api-key": "private" };
const handlers = (read: PartnerV1Handlers["presales"]): PartnerV1Handlers => ({ defillama: read, daily_stats: read, presales: read, featured: read, presale: read, presale_proof: read, prices: read, discovery: read, wallet_launches: read, search: read, market: read, coin_metadata: read });

test("v1 routes all operations without redirects, losing repeated parameters, or forwarding user credentials", async () => {
  for (const [path, source] of paths) {
    const query = `?partner_id=${id}&coin=a&coin=b&cursor=a%2Bb%3D`;
    let calls = 0;
    const body = { next_cursor: "opaque", amount: "9007199254740993", nullable: null };
    const read = createPartnerV1Read(handlers(async (request) => {
      calls++;
      assert.equal(request.url, `https://www.blast.fun/api/${source}${query}`);
      for (const name of Object.keys(headers)) assert.equal(request.headers.get(name), null);
      return Response.json(body, { headers: { "Cache-Control": "public, max-age=60" } });
    }));
    const response = await read(new Request(`https://www.blast.fun/api/v1/${path}${query}`, { headers }), testClient());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), body);
    assert.equal(response.headers.get("x-blast-api-version"), "1");
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("vercel-cdn-cache-control"), "no-store");
    assert.equal(calls, 1);
  }
});

test("v1 preserves errors and retry headers, strips HEAD bodies, and rejects writes or unknown routes", async () => {
  const read = createPartnerV1Read(handlers(async () => Response.json({ error: { code: "rate_limited" } }, { status: 429, headers: { "Retry-After": "12" } })));
  const url = "https://www.blast.fun/api/v1/presales";
  const get = await read(new Request(url), testClient());
  assert.equal(get.status, 429);
  assert.equal(get.headers.get("retry-after"), "12");
  const head = await read(new Request(url, { method: "HEAD" }), testClient());
  assert.equal(head.status, 429);
  assert.equal(await head.text(), "");
  assert.equal((await read(new Request(url, { method: "POST" }), testClient())).status, 405);
  for (const path of [
    "/api/v2/presales", "/api/v1/me", "/api/v1/presales/viewer", `/api/v1/market/pools/blast_curve/${id}/trades`, "/api/v1/presales/", "/api/v1/%70resales",
    // Near misses of the launchpad reads: another wallet route, a partial ID, an unknown suffix.
    `/api/v1/market/wallets/${id}`, `/api/v1/market/wallets/${id}/trades`, "/api/v1/market/wallets/0xa/launches",
    `/api/v1/market/partners/${id}/earnings`, "/api/v1/market/partners/", `/api/v1/market/launches/${id}/rewards/x`,
    "/api/v1/market/launchpad", `/api/v1/market/wallets/0x${"A".repeat(64)}/launches`,
    `/api/v1/market/pools/unknown/${id}`, "/api/v1/market/pools/cetus/0xa",
    `/api/v1/market/pools/bluefin/0x${"A".repeat(64)}`, `/api/v1/market/pools/cetus/${id}/private`,
  ]) {
    assert.equal(partnerV1Route(path), null, path);
    assert.equal((await read(new Request("https://www.blast.fun" + path), testClient())).status, 404);
  }
  assert.equal(isVersionedPartnerPath("/api/v2/presales"), true);
  assert.equal(isVersionedPartnerPath("/api/social/presales"), false);
});

test("blast-v2#566: v1 answers presales and price histories in the published shape", async () => {
  const summary = { presale_id: id, name: "Orbit", backers_sample: [{ callsign: "maya" }] };
  const answers: Record<string, unknown> = {
    "/api/social/presales": { presales: [summary], next_cursor: null },
    "/api/social/presales/featured": { presales: [summary] },
    [`/api/social/presales/${id}`]: { presale: { presale_id: id }, terms: { hard_cap: "1", launch_fdv_quote: "9" } },
    "/api/social/prices": { prices: [{ coin_type: "SUI", price_usd: "3.4", price_as_of_ms: 12 }], clock_ms: 13 },
  };
  const read = createPartnerV1Read(handlers(async (request) => Response.json(answers[new URL(request.url).pathname])));
  const body = async (path: string) => (await read(new Request(`https://blast.test/api/v1/${path}`), testClient())).json();
  assert.deepEqual(await body("presales"), { presales: [{ presale_id: id, name: "Orbit" }], next_cursor: null });
  assert.deepEqual(await body("presales/featured"), { presales: [{ presale_id: id, name: "Orbit" }] });
  assert.deepEqual(await body(`presales/${id}`), { presale: { presale_id: id }, terms: { hard_cap: "1" } });
  assert.deepEqual(await body("prices"), { prices: [{ coin_type: "SUI", price_usd: "3.4" }], clock_ms: 13 });
  const head = await read(new Request("https://blast.test/api/v1/presales", { method: "HEAD" }), testClient());
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("partner discovery, pool and coin responses keep their published market fields", async () => {
  const market = { market_cap_usd: "120.00" };
  const enriched = { ...market, fdv_usd: "200.00" };
  const coin = `${id}%3A%3Am%3A%3AC`;
  const answers: Record<string, unknown> = {
    "/api/launchpad/discovery": { metrics: { [id]: { holders: 18, market: enriched } }, legacyMarket: {}, legacyFdvUsd: {} },
    [`/api/launchpad/market/pools/blast_curve/${id}`]: { pool: { market: enriched }, candle: null },
    [`/api/launchpad/market/coins/${coin}`]: { coin: id, market: enriched },
  };
  const read = createPartnerV1Read(handlers(async (request) => {
    const { pathname, searchParams } = new URL(request.url);
    if (pathname === "/api/launchpad/discovery" && searchParams.get("catalog") === "graduated") {
      return Response.json({ view: "graduated", legacyMarket: { [id]: { price: "1" } }, legacyFdvUsd: { [id]: "200.00" } });
    }
    return Response.json(answers[pathname]);
  }));
  const body = async (path: string) => (await read(new Request(`https://blast.test/api/v1/${path}`), testClient())).json();

  assert.deepEqual(await body("discovery?catalog=graduated"), { view: "graduated" });
  assert.deepEqual(await body("discovery"), { metrics: { [id]: { holders: 18, market } } });
  assert.deepEqual(await body(`market/pools/blast_curve/${id}`), { pool: { market }, candle: null });
  assert.deepEqual(await body(`market/coins/${coin}`), { coin: id, market });
});
