import assert from "node:assert/strict";
import test from "node:test";

import { socialPortfolioSchema, socialPortfolioHistorySchema } from "./portfolio.ts";
import { socialPublishedPricesResponseSchema, socialPricesResponseSchema } from "./prices.ts";
import { socialRewardsPageSchema } from "./rewards.ts";
import { socialSearchResponseSchema } from "./search.ts";
import {
  socialPublishedTransactionsPageSchema,
  socialTransactionsPageSchema,
} from "./transactions.ts";
import { createSocialValidator } from "./validate.ts";

const id = `0x${"a".repeat(64)}`;
const asOf = { checkpoint: 1, timestamp_ms: 1, lag_ms: 0 };
const payout = {
  presale_id: id,
  round_id: id,
  round_number: "0",
  meme_amount: "1",
  quote_amount: "0",
  digest: "a".repeat(32),
  timestamp_ms: 0,
  relayed_by: id,
  self_claimed: true,
};
const transaction = {
  tx_id: "00000000-0000-0000-0000-000000000000",
  kind: "commit",
  state: "submitted",
  digest: null,
  failure_code: null,
  presale_id: null,
  coin_type: null,
  amount: null,
  quote_type: null,
  quote_amount: null,
  usd_value: null,
  recipient: null,
  created_at_ms: 1,
  settled_at_ms: null,
  explorer_url: null,
};
const history = {
  presale_id: id,
  coin_type: "0x2::sui::SUI",
  tier: "5m",
  from_ms: 0,
  points: [[0, "1"]],
  price_usd: "1",
  price_24h_usd: null,
  change_24h_bps: null,
  day_open_usd: null,
  day_open_ms: null,
};
const prices = { window: "24h", clock_ms: 1, prices: [history], as_of: asOf };

test("portfolio families agree with published acceptance at their boundary cases", () => {
  const validator = createSocialValidator();
  const portfolio = {
    balances: null,
    positions: null,
    commitments: null,
    coins: null,
    vesting: null,
    totals: null,
    trend: null,
    prices_as_of_ms: null,
    unavailable: ["balances", "positions", "coins", "vesting", "totals", "trend"],
  };
  const fixtures = [
    {
      name: "portfolio-response",
      schema: socialPortfolioSchema,
      valid: portfolio,
      invalid: [
        { ...portfolio, unavailable: ["coins", "coins"] },
        {
          ...portfolio,
          balances: {
            sui: { atoms: "1", usd: null },
            usdc: { atoms: "0", usd: "0.00", usd_subcent: 0 },
          },
        },
      ],
    },
    {
      name: "portfolio-history-response",
      schema: socialPortfolioHistorySchema,
      valid: { range: "1w", points: [{ day: "2026-11-12", value_usd: "0.00" }], change_bps: "-10" },
      invalid: [
        { range: "1d", points: [], change_bps: null },
        { range: "all", points: [], change_bps: "01" },
      ],
    },
    {
      name: "rewards-page",
      schema: socialRewardsPageSchema,
      valid: { coins: null, payouts: [payout], next_cursor: null },
      invalid: [
        { coins: null, payouts: [{ ...payout, presale_id: null }], next_cursor: null },
        { coins: null, payouts: [{ ...payout, meme_amount: "1".repeat(41) }], next_cursor: null },
      ],
    },
    {
      name: "transactions-page",
      schema: socialPublishedTransactionsPageSchema,
      valid: { transactions: [transaction], next_cursor: null, explorer: "suiscan" },
      invalid: [
        {
          transactions: [{ ...transaction, created_at_ms: 0 }],
          next_cursor: null,
          explorer: "suiscan",
        },
      ],
    },
    {
      name: "prices-response",
      schema: socialPublishedPricesResponseSchema,
      valid: prices,
      invalid: [
        { ...prices, prices: [{ ...history, price_usd: "1.0" }] },
        { ...prices, prices: [{ ...history, points: [[0, "1", "extra"]] }] },
      ],
    },
    {
      name: "search-response",
      schema: socialSearchResponseSchema,
      valid: { query: "", presales: [], people: [], as_of: asOf },
      invalid: [
        { query: "", presales: [], people: [] },
        { query: "x".repeat(65), presales: [], people: [], as_of: asOf },
      ],
    },
  ] as const;
  for (const fixture of fixtures) {
    assert.equal(validator.validate(fixture.name, fixture.valid).valid, true, fixture.name);
    assert.equal(fixture.schema.safeParse(fixture.valid).success, true, fixture.name);
    for (const value of [...fixture.invalid, { ...fixture.valid, extra: true }]) {
      assert.equal(validator.validate(fixture.name, value).valid, false, fixture.name);
      assert.equal(fixture.schema.safeParse(value).success, false, fixture.name);
    }
  }
});

test("first-party prices keep observation times and genuine pool quote histories", () => {
  const quote = {
    coin_type: "0x2::sui::SUI",
    symbol: "SUI",
    price: "0.5",
    as_of_ms: 1,
    points: [[1, "0.5"]],
    change_24h_bps: null,
  };
  const body = { ...prices, prices: [{ ...history, price_as_of_ms: 1, quote }] };
  assert.deepEqual(socialPricesResponseSchema.parse(body), body);
  assert.equal(socialPublishedPricesResponseSchema.safeParse(body).success, false);
  const partner = { ...prices, prices: [{ ...history, quote }] };
  assert.equal(socialPublishedPricesResponseSchema.safeParse(partner).success, true);
  assert.equal(createSocialValidator().validate("prices-response", partner).valid, true);
});

test("first-party transaction types retain all four utility vesting operations", () => {
  for (const kind of ["vesting_create", "vesting_claim", "vesting_cancel", "vesting_close"]) {
    const page = {
      transactions: [{ ...transaction, kind }],
      next_cursor: null,
      explorer: "suiscan",
    };
    assert.equal(socialTransactionsPageSchema.safeParse(page).success, true);
    assert.equal(socialPublishedTransactionsPageSchema.safeParse(page).success, false);
  }
});

test("standalone reward sources need both source identifiers", () => {
  const standalone = { ...payout, presale_id: null, vault_id: id, source_id: id };
  assert.equal(
    socialRewardsPageSchema.safeParse({ coins: null, payouts: [standalone], next_cursor: null })
      .success,
    true,
  );
});

test("search length follows JSON Schema Unicode code points", () => {
  const body = { query: "😀".repeat(64), presales: [], people: [], as_of: asOf };
  assert.equal(createSocialValidator().validate("search-response", body).valid, true);
  assert.equal(socialSearchResponseSchema.safeParse(body).success, true);
  assert.equal(
    socialSearchResponseSchema.safeParse({ ...body, query: `${body.query}x` }).success,
    false,
  );
});
