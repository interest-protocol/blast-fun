import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { QueryRefusal, QueryTransientError } from "#web/lib/query/client.ts";
import { marketRetryDelay, retainMarketValues, retryMarketRead } from "./market-refresh";
import type { HomeCoin } from "@blast/core/modules/social/contracts/home.ts";
import { observedHomePrice } from "@blast/server/modules/social/home/coins.ts";

test("Home retains quiet-pool observations and real zero, with their actual timestamps", () => {
  assert.deepEqual(observedHomePrice("0.2", "1000", 600_000), { price: "0.2", asOfMs: 1000 });
  assert.deepEqual(observedHomePrice("0", "1000", 600_000), { price: "0", asOfMs: 1000 });
  for (const price of [null, "-1", "NaN", "Infinity", ""]) assert.equal(observedHomePrice(price, "1000", 600_000), null);
  assert.equal(observedHomePrice("1", "700000", 600_000), null);
});

test("partial market failures keep observed values without giving them a fresh timestamp", () => {
  const before = { presale_id: "a", coin_type: "type-a", lifecycle: "migrated", price_usd: "0", price_as_of_ms: 1000, fdv_usd: "0", change_24h_bps: 0, change_24h_from_ms: 900 } as HomeCoin;
  const missing = { ...before, price_usd: null, price_as_of_ms: null, fdv_usd: null, change_24h_bps: null, change_24h_from_ms: undefined };
  assert.deepEqual(retainMarketValues({ coins: [before] }, { coins: [missing] }).coins, [before]);
  const inputs = { total_supply: null, circulating_supply: null, open_1h_usd: null, open_24h_usd: null, baselines_until_ms: 2000 };
  const fullDay = { ...before, change_24h_from_ms: undefined, live_inputs: { ...inputs, open_24h_usd: "1", open_24h_until_ms: 1800, price_checkpoint: 4 } };
  const next = { ...missing, change_24h_from_ms: 1200, live_inputs: { ...inputs, open_24h_usd: "2", open_24h_until_ms: 1900, baselines_until_ms: 2100 } };
  const kept = retainMarketValues({ coins: [fullDay] }, { coins: [next] });
  assert.deepEqual(kept.coins[0]!.live_inputs, fullDay.live_inputs);
  assert.equal(kept.coins[0]!.change_24h_from_ms, undefined);
  assert.equal(retainMarketValues({ coins: [before] }, { coins: [{ ...missing, coin_type: "different" }] }).coins[0]!.price_usd, null);
  assert.equal(retainMarketValues({ coins: [before] }, { coins: [{ ...missing, lifecycle: "open" }] }).coins[0]!.price_usd, null);
});

test("partial market failures retain each standalone coin's own observed price", () => {
  const native = (coin_type: string, price_usd: string, price_as_of_ms: number) => ({
    presale_id: null, coin_type, lifecycle: "migrated", price_usd, price_as_of_ms,
    fdv_usd: null, change_24h_bps: null,
  }) as HomeCoin;
  const before = [native("type-cetus", "0.25", 1000), native("type-bluefin", "0.75", 2000)];
  const missing = before.map(coin => ({ ...coin, price_usd: null, price_as_of_ms: null }));
  assert.deepEqual(retainMarketValues({ coins: before }, { coins: missing }).coins, before);
});

test("market retries are bounded, respect Retry-After and refuse auth retries", () => {
  const rate = new QueryRefusal("rate_limited", { httpStatus: 429, retryAfterSeconds: 25 });
  assert.equal(retryMarketRead(0, rate), true);
  assert.equal(marketRetryDelay(0, rate), 25_000);
  assert.equal(retryMarketRead(3, rate), false);
  assert.equal(retryMarketRead(0, new QueryRefusal("auth", { httpStatus: 401 })), false);
  assert.equal(retryMarketRead(2, new QueryTransientError()), false);
});

test("simultaneous automatic and manual market reads share one in-flight query", async () => {
  const client = new QueryClient();
  let resolve: (value: number) => void = () => {};
  let calls = 0;
  const options = { queryKey: ["home", "market"], queryFn: () => { calls += 1; return new Promise<number>(done => { resolve = done; }); }, staleTime: 0 };
  const auto = client.fetchQuery(options);
  const manual = client.fetchQuery(options);
  assert.equal(calls, 1);
  resolve(7);
  assert.deepEqual(await Promise.all([auto, manual]), [7, 7]);
  client.clear();
});
