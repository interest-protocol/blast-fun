import assert from "node:assert/strict";
import test from "node:test";

import {
  homeAmountSchema,
  homeCoinMarketReadModelSchema,
  homeCoinMarketSchema,
  homeFollowingRequestContractSchema,
  homeActivityStreamPageSchema,
  homeFollowingRequestSchema,
  homeFollowingResponseSchema,
  homePublishedContracts,
  homeTraderSchema,
} from "./home-schemas.ts";
import { socialHomeActivityPath } from "./home.ts";

test("home amounts validate nested wire values without coercing", () => {
  const amount = {
    quote_type: "SUI",
    quote_symbol: null,
    quote_decimals: null,
    atoms: "0",
    usd: null,
    usd_complete: false,
  };
  assert.deepEqual(homeAmountSchema.parse(amount), amount);
  assert.equal(
    homeAmountSchema.safeParse({ ...amount, atoms: 0 }).success,
    false,
  );
  assert.equal(
    homeAmountSchema.safeParse({ ...amount, quote_decimals: 19 }).success,
    false,
  );
  assert.equal(
    homeAmountSchema.safeParse({ ...amount, extra: true }).success,
    false,
  );
});

test("published following body retains its documented optional mode fields", () => {
  assert.equal(
    homeFollowingRequestContractSchema.safeParse({
      mode: "preview",
      window: "24h",
    }).success,
    true,
  );
  assert.equal(
    homeFollowingRequestContractSchema.safeParse({
      mode: "coins",
      window: "24h",
      page: 1,
    }).success,
    false,
  );
  assert.equal(
    homeFollowingRequestContractSchema.safeParse({
      mode: "coins",
      window: "24h",
      limit: 31,
    }).success,
    false,
  );
});

test("activity stream keeps a negative window start but requires complete nested events", () => {
  const page = {
    window: "1h",
    from_ms: -100,
    to_ms: 0,
    clock_ms: 0,
    events: [],
    next_cursor: null,
    as_of: { checkpoint: 0, timestamp_ms: 0, lag_ms: 0 },
  };
  assert.equal(homeActivityStreamPageSchema.safeParse(page).success, true);
  assert.equal(
    homeActivityStreamPageSchema.safeParse({ ...page, events: [{}] }).success,
    false,
  );
  assert.equal(
    homeActivityStreamPageSchema.safeParse({ ...page, clock_ms: "0" }).success,
    false,
  );
});

test("first-party following modes demand their own payload and retain pagination", () => {
  assert.equal(
    homeFollowingRequestSchema.safeParse({
      mode: "coins",
      window: "24h",
      page: 1,
      limit: 50,
    }).success,
    true,
  );
  assert.equal(
    homeFollowingRequestSchema.safeParse({ mode: "preview", window: "24h" })
      .success,
    false,
  );
  const envelope = {
    mode: "coins",
    window: "24h",
    clock_ms: 0,
    as_of: { checkpoint: 0, timestamp_ms: 0, lag_ms: 0 },
  };
  assert.equal(
    homePublishedContracts["home-following-response"].schema.safeParse(envelope)
      .success,
    true,
  );
  assert.equal(homeFollowingResponseSchema.safeParse(envelope).success, false);
  assert.equal(
    homeFollowingResponseSchema.safeParse({
      ...envelope,
      coins: [],
      page: 1,
      pages: 1,
      total: 0,
      next_cursor: null,
      following: 0,
    }).success,
    true,
  );
});

test("trader holdings must identify a presale or a launch", () => {
  const schema = homeTraderSchema.shape.holdings.unwrap().element;
  const holding = {
    presale_id: null,
    symbol: "COIN",
    icon_url: null,
    decimals: 9,
    balance: "1",
    value_usd: null,
    share_bps: null,
    pnl_usd: null,
  };
  assert.equal(schema.safeParse(holding).success, false);
  assert.equal(
    schema.safeParse({ ...holding, presale_id: "sale" }).success,
    true,
  );
  assert.equal(
    schema.safeParse({ ...holding, launch_id: `0x${"a".repeat(64)}` }).success,
    true,
  );
});

test("standalone discover coins stay distinct from the published following presale shape", () => {
  const activity = {
    scope: "pool",
    window: "24h",
    from_ms: 0,
    to_ms: 1,
    participants: 0,
    events: 0,
    buyers: 0,
    sellers: 0,
    backers: 0,
    claimers: 0,
    bought: [],
    sold: [],
    committed: [],
    latest_ms: null,
    preview: [],
  };
  const coin = {
    presale_id: null,
    coin_type: "coin",
    symbol: "COIN",
    name: "Coin",
    icon_url: null,
    decimals: 9,
    lifecycle: "live",
    venue: "cetus",
    tradable: true,
    opened_ms: null,
    launched_ms: null,
    launch_id: null,
    quote: { type: "quote", symbol: "SUI", decimals: 9 },
    price_usd: null,
    price_as_of_ms: null,
    change_24h_bps: null,
    spark: [],
    holders: null,
    holders_as_of_ms: null,
    fdv_usd: null,
    activity,
    discussion: { posts: 0 },
    rank: { score: 0, why: "activity" },
    sale: null,
    top_holders: { holders: [], share_bps: null },
  };
  assert.equal(
    homePublishedContracts["home-coins-page"].definitions.coin.safeParse(coin)
      .success,
    true,
  );
  assert.equal(
    homePublishedContracts[
      "home-following-response"
    ].definitions.coin.safeParse(coin).success,
    false,
  );
  assert.equal(
    homePublishedContracts["home-coins-page"].definitions.coin.safeParse({
      ...coin,
      spark: [[1, "0.1", "extra"]],
    }).success,
    false,
  );
});

test("indexed market pool venues retain open-string read-model semantics", () => {
  const venue: string = "another-indexed-venue";
  const pool: NonNullable<import("./coin-market.ts").HomeCoinMarket["pool"]> = {
    id: `0x${"a".repeat(64)}`,
    venue,
    coin_atoms: "1",
    quote_atoms: "2",
    as_of_ms: 0,
  };
  assert.equal(
    homeCoinMarketReadModelSchema.shape.pool.safeParse(pool).success,
    true,
  );
  assert.equal(homeCoinMarketSchema.shape.pool.safeParse(pool).success, false);
  assert.equal(
    homeCoinMarketSchema.shape.pool.safeParse({ ...pool, venue: "cetus" })
      .success,
    true,
  );
  assert.equal(
    homeCoinMarketReadModelSchema.shape.pool.safeParse({ ...pool, venue: 1 })
      .success,
    false,
  );
});

test("the activity path asks a sale by presale id and a curve coin by coin type", () => {
  const sale = `0x${"ab".repeat(32)}`;
  const curve = `0x${"cd".repeat(32)}::curve::CURVE`;
  assert.equal(socialHomeActivityPath(sale, "24h"), `/api/social/home/activity?presale=${sale}`);
  assert.equal(socialHomeActivityPath(curve, "1h", "next"), `/api/social/home/activity?coin=${encodeURIComponent(curve)}&window=1h&cursor=next`);
});
