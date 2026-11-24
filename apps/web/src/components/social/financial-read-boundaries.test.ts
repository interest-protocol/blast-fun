import assert from "node:assert/strict";
import test from "node:test";

import { fetchPrices } from "./prices/price-client.ts";
import { fetchMePresales } from "./profile/profile-client.ts";

const presale = {
  presale_id: `0x${"a".repeat(64)}`, symbol: "COIN", name: "Coin", icon_url: "",
  status: "open", venue: "blast", start_ms: 1, end_ms: 2, fill_pct: 0,
  quote_symbol: "SUI", quote_decimals: 9, launched_ms: null, first_unlock_ms: null,
};

test("prices retain first-party observation times and quote-only history", async (t) => {
  const history = {
    presale_id: null, coin_type: "0x2::coin::COIN", tier: "5m", from_ms: 0,
    points: [], price_usd: null, price_24h_usd: null, change_24h_bps: null,
    day_open_usd: null, day_open_ms: null, price_as_of_ms: 10,
    quote: { coin_type: "0x2::sui::SUI", symbol: "SUI", price: "0.1", as_of_ms: 10, points: [[10, "0.1"]], change_24h_bps: null },
  };
  const body = { window: "24h", clock_ms: 10, prices: [history], as_of: { checkpoint: 1, timestamp_ms: 10, lag_ms: 0 } };
  const mock = t.mock.method(globalThis, "fetch", async () => Response.json(body));
  assert.deepEqual(await fetchPrices({ coins: [history.coin_type] }), body);
  mock.mock.mockImplementation(async () => Response.json({ ...body, prices: [{ ...history, quote: { ...history.quote, points: [[10, "not a price"]] } }] }));
  assert.equal(await fetchPrices({ coins: [history.coin_type] }), null);
});

test("me-presales validates nested cost basis before exposing holdings", async () => {
  const coin = { presale, quantity: "1", value_usd: null, multiple: null, basis_usd: null, basis_complete: false, pnl_usd: null, pnl_multiple: null };
  const body = { positions: [], watchlist: [], coins: [coin], vestings: [], created: [] };
  const options = { getAccessToken: async () => "token", fetch: async () => Response.json(body) };
  const result = await fetchMePresales(options);
  assert.equal(result.status, "ok");
  if (result.status === "ok") assert.deepEqual(result.body, body);
  const malformed = await fetchMePresales({ ...options, fetch: async () => Response.json({ ...body, coins: [{ ...coin, basis_usd: "unknown" }] }) });
  assert.equal(malformed.status, "error");
  if (malformed.status === "error") assert.equal(malformed.code, "invalid_response");
});
