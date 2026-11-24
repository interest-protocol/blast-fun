import assert from "node:assert/strict";
import test from "node:test";

import { CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import { PORTFOLIO_SNAPSHOT_PRICE_MAX_AGE_MS, valuePortfolio, type SnapshotPrice } from "./snapshot-value.ts";

/** OA-25 Q16: one account's value for the daily snapshot, exact, or the reason it cannot be valued. */

const AT = Date.UTC(2026, 9, 6, 0, 0, 5);
const SUI = PORTFOLIO_COIN_TYPES.sui;
const COIN = `0x${"c0".padStart(64, "0")}::coin::KSTL`;
const OTHER = `0x${"c1".padStart(64, "0")}::coin::MRDN`;
const fresh = (usd_price: string, ageMs = 1_000): SnapshotPrice => ({ usd_price, as_of_ms: AT - ageMs });
const prices = (entries: Record<string, SnapshotPrice>) => new Map(Object.entries(entries));
const NO_CASH = { sui: "0", usdc: "0" };

test("OA-25 Q16: the five parts are the gold card's, each exact and rounded once to cents, and the value is their sum", () => {
  const value = valuePortfolio({
    positions: [
      // A USDC sale's commitment counts at face value, open and closed alike in Committed.
      { commitment: "100000000", status: "open", quote_type: USDC_COIN_TYPE, quote_decimals: 6 },
      { commitment: "750000000", status: "closed", quote_type: USDC_COIN_TYPE, quote_decimals: 6 },
      // A cancelled sale refunds 12.5 SUI × $3.4123 = $42.65375 → Claimable $42.65.
      { commitment: "12500000000", status: "claimable", quote_type: SUI, quote_decimals: 9, claimable: { tokens: "0", quote_refund: "12500000000", sale_type: COIN, sale_decimals: 9 } },
      // Delivered: the tokens are in Tokens, never counted twice.
      { commitment: "999000000", status: "delivered", quote_type: USDC_COIN_TYPE, quote_decimals: 6 },
    ],
    // 600,000 KSTL × $0.0021 = $1,260; 1 atom of a 9-decimal coin at $0.000000001234 is far below a cent.
    coins: [{ coin_type: COIN, decimals: 9, balance: "600000000000000" }, { coin_type: OTHER, decimals: 9, balance: "1" }],
    // 860 USDC at face value; 412.38 SUI × $3.4123 = $1,407.164274 → $1,407.16.
    cash: { usdc: "860000000", sui: "412380000000" },
    prices: prices({ [SUI]: fresh("3.4123", 30_000), [COIN]: fresh("0.0021", 5_000), [OTHER]: fresh("0.000000001234", 1_000) }),
    takenAtMs: AT,
  });
  assert.deepEqual(value, {
    kind: "valued",
    value_usd: "4419.81",
    committed_usd: "850.00",
    claimable_usd: "42.65",
    tokens_usd: "1260.00",
    usdc_usd: "860.00",
    sui_usd: "1407.16",
    // The oldest price used (SUI's, 30 s old); USDC at face value has none.
    prices_as_of_ms: AT - 30_000,
  });
});

test("OA-25 Q16: exact where floats are not — 0.1 + 0.2, half-up cents, u64::MAX atoms and a 36-place pool price", () => {
  const value = (balances: readonly string[], price: string) =>
    valuePortfolio({
      positions: [],
      coins: balances.map((balance, index) => ({ coin_type: `${COIN}${index}`, decimals: 9, balance })),
      cash: NO_CASH,
      prices: prices(Object.fromEntries(balances.map((_, index) => [`${COIN}${index}`, fresh(price)]))),
      takenAtMs: AT,
    });
  // 0.1 + 0.2 tokens at $1: exactly $0.30 (a float sum is 0.30000000000000004).
  assert.equal((value(["100000000", "200000000"], "1") as { tokens_usd: string }).tokens_usd, "0.30");
  // Half up at the third place, summed before rounding: 0.005 + 0.004 = 0.009 → 0.01; 0.004 alone → 0.00.
  assert.equal((value(["5000000", "4000000"], "1") as { tokens_usd: string }).tokens_usd, "0.01");
  assert.equal((value(["4000000"], "1") as { tokens_usd: string }).tokens_usd, "0.00");
  // u64::MAX atoms of a 9-decimal coin at $1: 18,446,744,073.709551615 → $18,446,744,073.71.
  assert.equal((value(["18446744073709551615"], "1") as { tokens_usd: string }).tokens_usd, "18446744073.71");
  // A pool price truncated at 36 places, as blast-infra stores it.
  const pool = "0.000123456789012345678901234567890123";
  assert.equal((value(["1000000000000000"], pool) as { tokens_usd: string }).tokens_usd, "123.46");
});

test("OA-25 Q16: a held amount without a fresh price skips the day (never a partial value); zero needs no price", () => {
  const base = { positions: [], cash: NO_CASH, takenAtMs: AT } as const;
  const held = [{ coin_type: COIN, decimals: 9, balance: "1000000000" }];
  // No price at all.
  assert.deepEqual(valuePortfolio({ ...base, coins: held, prices: prices({}) }), { kind: "skipped", reason: "price_missing" });
  // A price older than 15 minutes against the moment valued; exactly 15 minutes is still that moment's price.
  assert.deepEqual(valuePortfolio({ ...base, coins: held, prices: prices({ [COIN]: fresh("2", PORTFOLIO_SNAPSHOT_PRICE_MAX_AGE_MS + 1) }) }), { kind: "skipped", reason: "price_missing" });
  assert.equal(valuePortfolio({ ...base, coins: held, prices: prices({ [COIN]: fresh("2", PORTFOLIO_SNAPSHOT_PRICE_MAX_AGE_MS) }) }).kind, "valued");
  // A malformed price is no price.
  assert.deepEqual(valuePortfolio({ ...base, coins: held, prices: prices({ [COIN]: fresh("-2") }) }), { kind: "skipped", reason: "price_missing" });
  // SUI held with no SUI price; the same wallet with no SUI needs none.
  assert.deepEqual(valuePortfolio({ ...base, coins: [], cash: { usdc: "5000000", sui: "1" }, prices: prices({}) }), { kind: "skipped", reason: "price_missing" });
  assert.deepEqual(valuePortfolio({ ...base, coins: [], cash: { usdc: "5000000", sui: "0" }, prices: prices({}) }), {
    kind: "valued", value_usd: "5.00", committed_usd: "0.00", claimable_usd: "0.00", tokens_usd: "0.00", usdc_usd: "5.00", sui_usd: "0.00", prices_as_of_ms: null,
  });
  // A SUI sale's commitment needs SUI's price.
  assert.deepEqual(
    valuePortfolio({ ...base, coins: [], positions: [{ commitment: "1", status: "open", quote_type: SUI, quote_decimals: 9 }], prices: prices({}) }),
    { kind: "skipped", reason: "price_missing" },
  );
  // Nothing held at all is a real zero.
  assert.deepEqual(valuePortfolio({ ...base, coins: [], prices: prices({}) }), {
    kind: "valued", value_usd: "0.00", committed_usd: "0.00", claimable_usd: "0.00", tokens_usd: "0.00", usdc_usd: "0.00", sui_usd: "0.00", prices_as_of_ms: null,
  });
});

test("OA-25 Q16: without the fullnode's balances the day is skipped, whatever else is known", () => {
  assert.deepEqual(
    valuePortfolio({ positions: [], coins: [], cash: null, prices: prices({ [SUI]: fresh("3") }), takenAtMs: AT }),
    { kind: "skipped", reason: "balances_unavailable" },
  );
});

// Fails if atom or scaled-price digits are rounded through a JavaScript number before cent valuation.
test("OA-25 Q16: portfolio cents retain exact atoms and prices beyond JavaScript precision", () => {
  const value = (balance: string, price: string) => valuePortfolio({
    positions: [],
    coins: [{ coin_type: COIN, decimals: 0, balance }],
    cash: NO_CASH,
    prices: prices({ [COIN]: fresh(price) }),
    takenAtMs: AT,
  });
  const emptyParts = {
    kind: "valued", committed_usd: "0.00", claimable_usd: "0.00",
    usdc_usd: "0.00", sui_usd: "0.00", prices_as_of_ms: AT - 1000,
  } as const;
  assert.deepEqual(value("9007199254740991", "0.01"), {
    ...emptyParts, value_usd: "90071992547409.91", tokens_usd: "90071992547409.91",
  });
  assert.deepEqual(value("9007199254740992", "0.01"), {
    ...emptyParts, value_usd: "90071992547409.92", tokens_usd: "90071992547409.92",
  });
  assert.deepEqual(value("9007199254740993", "0.01"), {
    ...emptyParts, value_usd: "90071992547409.93", tokens_usd: "90071992547409.93",
  });
  assert.deepEqual(value("18446744073709551615", "0.01"), {
    ...emptyParts, value_usd: "184467440737095516.15", tokens_usd: "184467440737095516.15",
  });
  assert.deepEqual(value("9007199254740993", "1.000000000000000001"), {
    ...emptyParts, value_usd: "9007199254740993.01", tokens_usd: "9007199254740993.01",
  });
});


test("unknown claim amounts skip the snapshot rather than using the old commitment", () => {
  for (const claimable of [undefined, { tokens: null, quote_refund: "0", sale_type: COIN, sale_decimals: 9 },
    { tokens: "0", quote_refund: null, sale_type: COIN, sale_decimals: 9 }]) {
    assert.deepEqual(valuePortfolio({ positions: [{ commitment: "100000000", status: "claimable", quote_type: USDC_COIN_TYPE, quote_decimals: 6, claimable }],
      coins: [], cash: NO_CASH, prices: prices({}), takenAtMs: AT }), { kind: "skipped", reason: "balances_unavailable" });
  }
});

test("a wallet holding test SUI gets a snapshot even without a test SUI price", () => {
  assert.deepEqual(valuePortfolio({
    positions: [{ commitment: "1000000000000", status: "open", quote_type: CREATE_TEST_SUI_QUOTE_TYPE, quote_decimals: 9 }],
    coins: [{ coin_type: CREATE_TEST_SUI_QUOTE_TYPE, decimals: null, balance: "2000000000000" }],
    cash: { sui: "2000000000", usdc: "0" },
    prices: prices({ [SUI]: fresh("3") }),
    takenAtMs: AT,
  }), {
    kind: "valued", value_usd: "6.00", committed_usd: "0.00", claimable_usd: "0.00",
    tokens_usd: "0.00", usdc_usd: "0.00", sui_usd: "6.00", prices_as_of_ms: AT - 1_000,
  });
});
