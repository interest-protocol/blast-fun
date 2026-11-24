import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { shouldRetry } from "#web/lib/query/client.ts";
import { createTestQueryClient, settleQueries, withQueryClient } from "#web/lib/query/test-client.ts";
import { installTestDom } from "../../../../test/fixtures/social/test-dom.ts";

const { document, window } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { PoolChart } = await import("./PoolChart.tsx");

const CANDLES = JSON.parse(readFileSync(
  new URL("../../../../../../packages/core/test/fixtures/modules/launchpad-contract/fixtures/v1-pool-candles-cetus.json", import.meta.url),
  "utf8",
)) as { provenance: { timestamp_ms: number }; migration: { venue_pool_key: string } };
const POOL_KEY = CANDLES.migration.venue_pool_key;
const AT = CANDLES.provenance.timestamp_ms + 400;
const CONTROLS = { range: "24h", interval: "1m" } as const;

async function mount(t: test.TestContext, reply: (path: string) => Response, launchAt?: number) {
  t.mock.method(Date, "now", () => AT);
  const asked: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input), window.location.origin);
    asked.push(pathname);
    return reply(pathname);
  });
  const client = createTestQueryClient({ queries: { retry: shouldRetry } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  t.after(async () => { await act(async () => root.unmount()); client.clear(); container.remove(); });
  await act(async () => root.render(withQueryClient(client, <PoolChart
    poolKey={POOL_KEY}
    symbol="KSTL"
    decimals={9}
    quote={{ symbol: "USDC", decimals: 6 }}
    initialControls={CONTROLS}
    market={{ launchAt }}
    uncovered={<p>The earlier sale chart</p>}
  />)));
  await act(async () => settleQueries(client));
  return { asked, text: () => container.textContent ?? "" };
}

const [venue, poolId] = POOL_KEY.split(":");
const CANDLE_PATH = `/api/launchpad/market/pools/${venue}/${poolId}/candles`;

test("a sale pool the market read knows draws the shared pool chart in the sale's quote and names partial history", async (t) => {
  const fresh = { ...CANDLES, provenance: { ...CANDLES.provenance, observed_ms: AT, lag_ms: 400 }, migration: null };
  const chart = await mount(t, (path) => path === CANDLE_PATH ? Response.json(fresh) : Response.json({}, { status: 404 }));
  assert.ok(chart.asked.includes(CANDLE_PATH), "history is the pool's own candle read");
  assert.match(chart.text(), /USDC/);
  assert.match(chart.text(), /Partial price history/, "a pool with no known opening time never claims full history");
  assert.doesNotMatch(chart.text(), /earlier sale chart/);
});

test("a sale pool the market read does not know keeps the sale's earlier chart after one read", async (t) => {
  const chart = await mount(t, () => Response.json({ error: { code: "not_found" } }, { status: 404 }), AT - 3_600_000);
  assert.match(chart.text(), /The earlier sale chart/);
  assert.equal(chart.asked.filter((path) => path === CANDLE_PATH).length, 1, "an unknown pool is asked for once");
});
