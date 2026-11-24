import assert from "node:assert/strict";
import test from "node:test";
import { paymentStatus } from "./payment-status";
import type { TradeQuoteSnapshot } from "../trade/trade-quotes.ts";
import { fixtureQuote } from "../../../../test/fixtures/social/coins/swap-fixture.ts";
import { FIXTURE_COINS } from "../../../../test/fixtures/social/coins/coins-fixture-model.ts";
import { SUI_COIN_TYPE, USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";

const quote = fixtureQuote({ in_coin: SUI_COIN_TYPE, out_coin: USDC_COIN_TYPE, side: "sell", amount_in: "1000000000", slippage_bps: 50 }, FIXTURE_COINS, { quote: "ok", trade: "ok", signedIn: true, fee: "sponsored" }, 1000);
const snapshot: TradeQuoteSnapshot = { key: "request", loading: false, error: null, quote, shown: null };
test("payment paths distinguish provider failure, no route, balance, expiry and submission", () => {
  assert.equal(paymentStatus({ ...snapshot, key: null }, 1000), "idle");
  assert.equal(paymentStatus({ ...snapshot, loading: true }, 1000), "quoting");
  assert.equal(paymentStatus(snapshot, 1000), "ready");
  assert.equal(paymentStatus(snapshot, 1000, true), "submitting");
  assert.equal(paymentStatus({ ...snapshot, error: { code: "service_unavailable" } }, 1000), "temporary-error");
  assert.equal(paymentStatus({ ...snapshot, quote: { ...quote, unavailable_reason: "no_pool" } }, 1000), "no-route");
  assert.equal(paymentStatus({ ...snapshot, quote: { ...quote, unavailable_reason: "not_tradable" } }, 1000), "unsupported");
  assert.equal(paymentStatus({ ...snapshot, quote: { ...quote, offer_refused: "insufficient_balance" } }, 1000), "insufficient-balance");
  assert.equal(paymentStatus(snapshot, quote.expires_at_ms!), "expired");
});
