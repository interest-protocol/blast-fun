import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { sameOriginFetch, testMarketRoutes } from "../../../../test/fixtures/modules/launchpad-market/testing.ts";
import { browserMarketDependencies } from "../blast-infra-browser.ts";
import { readChart, type ChartSource } from "./chart-client.ts";

const ORIGIN = "https://infra.test";
const captured = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../../../../packages/core/test/fixtures/modules/launchpad-contract/fixtures/${name}`, import.meta.url), "utf8")) as Record<string, unknown>;
const CURVE = captured("v1-pool-candles-curve.json");
const CETUS = captured("v1-pool-candles-cetus.json");
const MARKER = CURVE.migration as Record<string, string | number>;
const CURVE_KEY = MARKER.curve_pool_key as string;
const CETUS_KEY = MARKER.venue_pool_key as string;
const AT = (CURVE.provenance as Record<string, number>).timestamp_ms + 400;

function fresh(body: Record<string, unknown>) {
  const provenance = body.provenance as Record<string, number>;
  return { ...body, provenance: { ...provenance, observed_ms: AT, lag_ms: 400 } };
}

function infra(reply: (path: string) => Response, seen: string[]) {
  const fetcher = (async (input: URL | string) => {
    const url = new URL(String(input));
    if (url.pathname === "/v1/status") return Response.json({ provenance: fresh(CURVE).provenance });
    seen.push(`${url.pathname}${url.search}`);
    return reply(url.pathname);
  }) as typeof fetch;
  // The browser reads the app's routes; they relay each read to this blast-infra.
  return browserMarketDependencies(null, sameOriginFetch(testMarketRoutes(ORIGIN, { apiKey: null, fetch: fetcher })), () => AT);
}

const SOURCE: ChartSource = {
  expected: null,
  curvePoolKey: CURVE_KEY,
  venuePoolKey: null,
  migration: null,
  symbol: "C",
  quoteSymbol: "SUI",
  memeDecimals: 6,
  quoteDecimals: 9,
};

test("the chart reads each source pool's own candles from blast-infra, never the coin's merged chart", async () => {
  const seen: string[] = [];
  const reply = (path: string) => Response.json(fresh(path.includes("/cetus/") ? CETUS : CURVE));
  const chart = await readChart(
    { ...SOURCE, venuePoolKey: CETUS_KEY },
    { interval: "1m", range: "all" },
    infra(reply, seen),
    AT,
  );
  assert.equal(chart.curve.state, "available");
  assert.equal(chart.venue?.state, "available");
  assert.deepEqual(seen.sort(), [
    `/v1/pools/blast_curve/${CURVE_KEY.slice(12)}/candles?interval=1m&limit=2000`,
    `/v1/pools/cetus/${CETUS_KEY.slice(6)}/candles?interval=1m&limit=2000`,
  ]);
  assert.ok(seen.every((path) => !path.startsWith("/v1/coins/")));
});

test("a migration the page did not know yet adds its recorded venue pool, and the curve stays", async () => {
  const seen: string[] = [];
  const reply = (path: string) => Response.json(fresh(path.includes("/cetus/") ? CETUS : CURVE));
  const chart = await readChart(SOURCE, { interval: "1m", range: "all" }, infra(reply, seen), AT);
  assert.equal(chart.curve.state, "available");
  assert.equal(chart.venue?.state, "available");
  assert.equal(chart.migration?.venuePoolKey, CETUS_KEY);
  assert.ok(seen.some((path) => path.includes("/cetus/")));
});

test("a recorded venue pool blast-infra cannot chart leaves the venue out, not the curve", async () => {
  const seen: string[] = [];
  const chart = await readChart(
    { ...SOURCE, venuePoolKey: "uniswap:0x01" },
    { interval: "1m", range: "all" },
    infra(() => Response.json(fresh({ ...CURVE, migration: null })), seen),
    AT,
  );
  assert.equal(chart.curve.state, "available");
  assert.equal(chart.venue, null);
});
