import assert from "node:assert/strict";
import test from "node:test";
import { installTestDom } from "../../../test/fixtures/social/test-dom.ts";

const { document } = installTestDom();
const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createTestQueryClient, withQueryClient, settleQueries } = await import("#web/lib/query/test-client.ts");
const { queryKeys } = await import("#web/lib/query/keys.ts");
const { fixtureDetail, FIXTURE_NOW } = await import("../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts");
const { SalePriceChart } = await import("./SalePriceChart");

const pricePage = {
  window: "24h",
  clock_ms: FIXTURE_NOW,
  as_of: { checkpoint: 1, timestamp_ms: FIXTURE_NOW, lag_ms: 0 },
};

/** Waits (in 25ms steps, at most a second) for a rendered condition instead of trusting one fixed delay under load. */
async function until(done: () => boolean) {
  for (let step = 0; step < 40 && !done(); step++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 25)); });
}

test("a failed presale price read retries into a confirmed empty period without inventing a return", async (t) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = createTestQueryClient();
  const previousFetch = globalThis.fetch;
  const sale = fixtureDetail("kstl").presale;
  let failed = true;
  let reads = 0;
  globalThis.fetch = async () => {
    reads++;
    return failed ? new Response(null, { status: 503 }) : Response.json({ ...pricePage, prices: [{
      presale_id: sale.presale_id, coin_type: sale.sale_token, tier: "5m", from_ms: FIXTURE_NOW - 86_400_000,
      price_usd: null, price_24h_usd: null, change_24h_bps: null, day_open_ms: null, day_open_usd: null, points: [],
      quote: { coin_type: "test::sui::TSUI", symbol: "TSUI", price: "0.000088", as_of_ms: FIXTURE_NOW - 172_800_000, points: [], change_24h_bps: null },
    }] });
  };
  t.after(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    globalThis.fetch = previousFetch;
  });
  await act(async () => root.render(withQueryClient(client, <SalePriceChart sale={sale} trade={<button>Trade</button>} />)));
  await until(() => container.querySelector('[role="alert"]') !== null);
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /Price history could not load/);
  assert.doesNotMatch(container.textContent!, /0\.00%/);
  const retry = container.querySelector<HTMLButtonElement>('[aria-label="Retry price history"]');
  assert.ok(retry);
  failed = false;
  await act(async () => retry.click());
  await until(() => reads === 2 && !/Loading price history/.test(container.textContent ?? ""));
  assert.equal(reads, 2);
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.match(container.textContent!, /No recorded prices in this period/);
  assert.match(container.textContent!, /Price0\.0₄88TSUI/, "the price names its quote coin");
  assert.doesNotMatch(container.textContent!, /today/, "an unmeasured change is left out with its label");
  assert.doesNotMatch(container.textContent!, /0\.00%/);
});

for (const outcome of ["success", "error"] as const) {
  test(`cached price history stays visible during refresh, and its retry stays busy until ${outcome}`, async (t) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const client = createTestQueryClient();
    const previousFetch = globalThis.fetch;
    const sale = fixtureDetail("kstl").presale;
    const key = queryKeys.prices.history(`presale:${sale.presale_id}`, "24h");
    const history = {
      presale_id: sale.presale_id, coin_type: sale.sale_token, tier: "5m", from_ms: FIXTURE_NOW - 86_400_000,
      price_usd: "0.0021", price_24h_usd: "0.002", change_24h_bps: 500, day_open_ms: null, day_open_usd: null,
      points: [[FIXTURE_NOW - 300_000, "0.002"], [FIXTURE_NOW, "0.0021"]],
    };
    client.setQueryData(key, history);
    const pending: ((response: Response) => void)[] = [];
    globalThis.fetch = () => new Promise<Response>((resolve) => pending.push(resolve));
    t.after(async () => {
      await act(async () => root.unmount());
      client.clear();
      container.remove();
      globalThis.fetch = previousFetch;
    });
    const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
    await act(async () => root.render(withQueryClient(client, <SalePriceChart sale={sale} trade={<button>Trade</button>} />)));
    await act(async () => { void client.refetchQueries({ queryKey: key, exact: true }); await tick(); });
    assert.equal(pending.length, 1);
    assert.equal(container.querySelector('[data-price-history]')?.getAttribute("data-price-history"), "available", "routine refresh preserves the valid cached chart");
    assert.equal(container.querySelector('[aria-label="Loading price history"]'), null);
    assert.match(container.textContent!, /\+5\.00%/);
    await act(async () => { pending[0]!(new Response(null, { status: 503 })); await settleQueries(client); });
    const retry = container.querySelector<HTMLButtonElement>('[aria-label="Retry price history"]');
    assert.ok(retry);
    await act(async () => { retry.click(); await tick(); });
    const busy = container.querySelector<HTMLButtonElement>('[aria-busy="true"]');
    assert.ok(busy, "a retry with cached data exposes pending feedback");
    assert.equal(busy.getAttribute("aria-label"), "Retrying price history");
    assert.equal(busy.disabled, true);
    assert.ok(busy.querySelector('[role="status"][aria-label="Retrying price history"]'));
    await act(async () => { busy.click(); busy.click(); await tick(); });
    assert.equal(pending.length, 2, "busy activation cannot restart the held retry");
    await act(async () => {
      pending[1]!(outcome === "success" ? Response.json({ ...pricePage, prices: [history] }) : new Response(null, { status: 503 }));
      await settleQueries(client);
    });
    assert.equal(container.querySelector('[aria-busy="true"]'), null);
    if (outcome === "success") {
      assert.equal(container.querySelector('[role="alert"]'), null);
      assert.equal(container.querySelector('[data-price-history]')?.getAttribute("data-price-history"), "available");
    } else {
      const settled = container.querySelector<HTMLButtonElement>('[aria-label="Retry price history"]');
      assert.ok(settled);
      assert.equal(settled.disabled, false);
      assert.match(container.querySelector('[role="alert"]')!.textContent!, /Price history could not load/);
    }
  });
}
