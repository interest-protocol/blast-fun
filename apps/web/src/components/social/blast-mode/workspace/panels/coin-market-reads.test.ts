import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchCoinMarket,
  fetchCoinHolders,
  fetchBigChartTrades,
  fetchMyChartTrades,
} from "./coin-market-reads.ts";
import { proofMarket } from "../../../../../../test/fixtures/workspace/redesign-fixtures.ts";

const coinType = `0x${"a".repeat(64)}::coin::COIN`;
const as_of = { checkpoint: 0, timestamp_ms: 0, lag_ms: 0 };
test("market boundaries retain indexed venues and reject incomplete nested reads", async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const signal = new AbortController().signal;
  const market = proofMarket(coinType);
  let body: unknown = {
    ...market,
    pool: {
      id: `0x${"b".repeat(64)}`,
      venue: "another-indexed-venue",
      coin_atoms: "1",
      quote_atoms: "1",
      as_of_ms: 0,
    },
  };
  globalThis.fetch = async () => Response.json(body);
  assert.deepEqual(await fetchCoinMarket(coinType, signal), body);
  body = { ...market, windows: {} };
  await assert.rejects(
    fetchCoinMarket(coinType, signal),
    /unreadable response/,
  );
  body = {
    coin_type: coinType,
    presale_id: null,
    decimals: 9,
    price_usd: null,
    price_as_of_ms: null,
    holders: [],
    as_of,
  };
  assert.deepEqual(await fetchCoinHolders(coinType, signal), body);
  body = { ...(body as object), holders: [{}] };
  await assert.rejects(
    fetchCoinHolders(coinType, signal),
    /unreadable response/,
  );
  body = {
    coin_type: coinType,
    from_ms: 0,
    to_ms: 1,
    min_usd: 1000,
    trades: [],
    truncated: false,
    as_of,
  };
  assert.deepEqual(await fetchBigChartTrades(coinType, 0, 1, signal), body);
  body = { ...(body as object), min_usd: null };
  assert.deepEqual(
    await fetchMyChartTrades(async () => null, coinType, 0, 1, signal),
    body,
  );
  body = { ...(body as object), trades: [{}] };
  await assert.rejects(
    fetchMyChartTrades(async () => null, coinType, 0, 1, signal),
    /Your trades could not load/,
  );
});
