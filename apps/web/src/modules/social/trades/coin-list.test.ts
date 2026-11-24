import assert from "node:assert/strict";
import test from "node:test";
import { normalizeStructTag } from "@mysten/sui/utils";

import type { QueryResult, QueryResultRow } from "pg";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_TRADE_BASE_COINS, SOCIAL_TRADE_VENUES, tradesInApp } from "@blast/core/modules/social/contracts/trades.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { coreCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { COIN_METADATA_SQL } from "@blast/server/modules/social/portfolio/coin-metadata.ts";
import { isTradeCoinPage } from "#web/components/social/coins/swap-client.ts";
import { TRADE_PRICES_SQL, TRADE_SALE_COINS_SQL } from "@blast/server/modules/social/trades/coins.ts";
import {
  decodeTradeCoinCursor,
  encodeTradeCoinCursor,
  likePattern,
  parseTradeCoinListQuery,
  readTradeCoinPage,
  TRADE_COIN_LIST_SQL,
  TRADE_COIN_TRUST_SQL,
} from "@blast/server/modules/social/trades/coin-list.ts";

/**
 * Social feed R3-33: the picker's coins read (`GET /api/social/trades/coins`)
 * — its query, its keyset cursor and how a row becomes a coin — without a
 * database (the integration test runs it on the fixture `chain_read_v1`).
 */

const NOW = 1_791_000_000_000;
const id = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const url = (query: string) => new URL(`https://blast.fun/api/social/trades/coins${query}`);
const refusal = (run: () => unknown, parameter: string) =>
  assert.throws(run, (error: unknown) => error instanceof SocialRouteError && error.code === "invalid_parameter" && error.extra.parameter === parameter);

test("the query: q trimmed, lowercased and without a leading $; limit 1 to 50; a cursor round-trips; anything else is invalid_parameter", () => {
  assert.deepEqual(parseTradeCoinListQuery(url("")), { q: null, cursor: null, limit: 50 });
  assert.deepEqual(parseTradeCoinListQuery(url("?q=%20%24KSTL%20&limit=20")), { q: "kstl", cursor: null, limit: 20 });
  const cursor = encodeTradeCoinCursor({ symbol: "KSTL", presaleId: id(7) });
  assert.deepEqual(parseTradeCoinListQuery(url(`?cursor=${cursor}`)).cursor, { symbol: "KSTL", presaleId: id(7) });
  assert.deepEqual(decodeTradeCoinCursor(cursor), { symbol: "KSTL", presaleId: id(7) });
  refusal(() => parseTradeCoinListQuery(url("?q=")), "q");
  refusal(() => parseTradeCoinListQuery(url("?q=%24")), "q");
  refusal(() => parseTradeCoinListQuery(url(`?q=${"a".repeat(513)}`)), "q");
  refusal(() => parseTradeCoinListQuery(url("?q=a&q=b")), "q");
  refusal(() => parseTradeCoinListQuery(url("?limit=0")), "limit");
  refusal(() => parseTradeCoinListQuery(url("?limit=51")), "limit");
  refusal(() => parseTradeCoinListQuery(url("?limit=5.5")), "limit");
  refusal(() => parseTradeCoinListQuery(url("?cursor=bm9wZQ")), "cursor");
  refusal(() => decodeTradeCoinCursor(Buffer.from(JSON.stringify(["KSTL", "0x12"])).toString("base64url")), "cursor");
  refusal(() => decodeTradeCoinCursor("x".repeat(401)), "cursor");
});

test("a search's % and _ match themselves", () => {
  assert.equal(likePattern("kstl"), "%kstl%");
  assert.equal(likePattern("50%_off\\"), "%50\\%\\_off\\\\%");
});

test("coin searches accept full types and normalize padded package addresses", () => {
  for (const type of ["0x2::sui::SUI", `${id(2)}::sui::SUI`]) {
    assert.equal(parseTradeCoinListQuery(url(`?q=${encodeURIComponent(type)}`)).q, normalizeStructTag("0x2::sui::SUI"));
  }
  const type = `0x${"a".repeat(64)}::coin::TOKEN`;
  assert.equal(parseTradeCoinListQuery(url(`?q=${type}`)).q, type);
});

test("generic coin searches use the SDK's canonical struct tag", () => {
  const type = "0x0002::coin::Wrapper< 0x000a::token::TOKEN >";
  assert.equal(parseTradeCoinListQuery(url(`?q=${encodeURIComponent(type)}`)).q, normalizeStructTag(type));
});

test("one statement per page through SHOWN_PRESALES; a row is a coin; a price older than 120 s is none; the next cursor is the last row's", async () => {
  const seen: unknown[][] = [];
  const rows = [
    { presale_id: id(1), sale_token: `${id(1)}::coin::AAA`, sale_symbol: "AAA", sale_name: "Aaa", sale_icon_url: "https://i.blast.test/a.png", sale_decimals: 9, usd_price: "0.0021", as_of_ms: String(NOW - 5_000) },
    { presale_id: id(2), sale_token: `${id(2)}::coin::BBB`, sale_symbol: "BBB", sale_name: "Bbb", sale_icon_url: "", sale_decimals: 6, usd_price: "1.5", as_of_ms: String(NOW - 121_000) },
    { presale_id: id(3), sale_token: `${id(3)}::coin::CCC`, sale_symbol: "CCC", sale_name: "Ccc", sale_icon_url: null, sale_decimals: 9, usd_price: null, as_of_ms: null },
  ];
  const db: ReadableDatabase = {
    async read<Row extends QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
      assert.equal(text, TRADE_COIN_LIST_SQL);
      seen.push([...values]);
      const limit = values[3] as number;
      return { rows: rows.slice(0, limit) as unknown as Row[], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
    },
  };
  const page = await readTradeCoinPage(db, { q: "aaa", cursor: null, limit: 2 }, NOW);
  assert.deepEqual(seen, [["%aaa%", null, null, 3, NOW, false, null]], "asks one more than a page to know there is another");
  assert.deepEqual(page.coins, [
    { coin_type: `${id(1)}::coin::AAA`, symbol: "AAA", name: "Aaa", decimals: 9, icon_url: "https://i.blast.test/a.png", usd_price: "0.0021", presale_id: id(1) },
    { coin_type: `${id(2)}::coin::BBB`, symbol: "BBB", name: "Bbb", decimals: 6, icon_url: null, usd_price: null, presale_id: id(2) },
  ]);
  assert.deepEqual(decodeTradeCoinCursor(page.next_cursor!), { symbol: "BBB", presaleId: id(2) });
  const last = await readTradeCoinPage(db, { q: null, cursor: { symbol: "BBB", presaleId: id(2) }, limit: 50 }, NOW);
  assert.deepEqual(seen[1], [null, "BBB", id(2), 51, NOW, false, null]);
  assert.equal(last.next_cursor, null);
  // The read goes through SHOWN_PRESALES (T-020's guard), migrated sales only, keyset ordered.
  assert.match(TRADE_COIN_LIST_SQL, /FROM \(SELECT \* FROM chain_read_v1\.presales\s+WHERE sale_decimals IS NOT NULL/);
  assert.match(TRADE_COIN_LIST_SQL, /p\.lifecycle = 'migrated'/);
  // An Aftermath DAO-fee pool's coin trades in the app through its pool, so it is listed once its pool is known.
  const venues = /p\.venue IN \('cetus', 'bluefin', 'aftermath'\)\s+AND \(p\.venue <> 'aftermath' OR p\.pool_id IS NOT NULL\)/;
  assert.match(TRADE_COIN_LIST_SQL, venues);
  assert.match(TRADE_SALE_COINS_SQL, /p\.lifecycle = 'migrated' AND p\.venue IN/);
  assert.match(TRADE_SALE_COINS_SQL, venues);
  assert.deepEqual([...SOCIAL_TRADE_VENUES], ["cetus", "bluefin", "aftermath"]);
  assert.deepEqual(["cetus", "Bluefin", "aftermath", "Aftermath", "uniswap", null, ""].map(tradesInApp), [true, true, true, true, false, false, false]);
  assert.match(TRADE_COIN_LIST_SQL, /ORDER BY left\(coalesce\(p\.sale_symbol, ''\), 32\) COLLATE "C", p\.presale_id COLLATE "C"/);
  assert.match(TRADE_COIN_LIST_SQL, /\(left\(coalesce\(p\.sale_symbol, ''\), 32\) COLLATE "C", p\.presale_id COLLATE "C"\) > /);
  assert.doesNotMatch(TRADE_COIN_LIST_SQL, /OFFSET/);
});


test("a search's first page leads with the ecosystem coins it names, even with no Blast coin trading", async () => {
  const sale = { lifecycle: "migrated", presale_id: id(5), sale_token: `${id(5)}::coin::SUIMEME`, sale_symbol: "SUIMEME", sale_name: "Sui meme", sale_icon_url: null, sale_decimals: 9, quote_symbol: "SUI", quote_type: SOCIAL_TRADE_BASE_COINS.sui, usd_price: null, as_of_ms: null };
  const dbWith = (sales: readonly unknown[]): ReadableDatabase => ({
    async read<Row extends QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
      const rows = text === TRADE_COIN_LIST_SQL ? sales.slice(0, values[3] as number)
        : text === TRADE_PRICES_SQL ? [{ coin_type: SOCIAL_TRADE_BASE_COINS.sui, usd_price: "3.1", as_of_ms: String(NOW) }] : [];
      return { rows: rows as Row[], rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    },
  });
  const none = await readTradeCoinPage(dbWith([]), parseTradeCoinListQuery(url("?q=SUI")), NOW);
  assert.deepEqual(none.coins[0], { coin_type: SOCIAL_TRADE_BASE_COINS.sui, symbol: "SUI", name: "Sui", decimals: 9, icon_url: coreCoin(SOCIAL_TRADE_BASE_COINS.sui)!.logoUrl, usd_price: "3.1", presale_id: null });
  assert.ok(none.coins.some((coin) => coin.symbol === "haSUI") && none.coins.every((coin) => coin.presale_id === null));
  assert.deepEqual(createSocialValidator().validate("trade-coin-page", none), { valid: true, errors: [] });
  const sales = [5, 6, 7, 8].map((n) => ({ ...sale, presale_id: id(n), sale_token: `${id(n)}::coin::SUI${n}`, sale_symbol: `SUI${n}` }));
  const shared = await readTradeCoinPage(dbWith(sales), { q: "sui", cursor: null, limit: 5 }, NOW);
  assert.deepEqual(shared.coins.map((coin) => coin.symbol), ["SUI", "suiUSDT", "SUI5", "SUI6", "SUI7"], "exact ticker, then ticker prefixes, at most half the page, so Blast coins still show");
  assert.deepEqual(decodeTradeCoinCursor(shared.next_cursor!), { symbol: "SUI7", presaleId: id(7) }, "the next page resumes after the last sale shown");
  for (const q of ["hashi", "hashiBTC", "BTC"]) {
    const page = await readTradeCoinPage(dbWith([]), parseTradeCoinListQuery(url(`?q=${q}`)), NOW);
    assert.equal(page.coins[0]!.symbol, "hashiBTC", `"${q}" finds Hashi BTC by its curated ticker`);
  }
  // A Blast coin whose ticker is exactly "BTC" still follows the curated Bitcoin coins, so it never stands in for one.
  const btc = await readTradeCoinPage(dbWith([{ ...sale, presale_id: id(9), sale_token: `${id(9)}::coin::BTC`, sale_symbol: "BTC", sale_name: "Blast BTC" }]), parseTradeCoinListQuery(url("?q=BTC")), NOW);
  assert.deepEqual(btc.coins.map((coin) => [coin.symbol, coin.presale_id !== null]), [
    ["hashiBTC", false], ["WBTC", false], ["suiWBTC", false], ["xBTC", false], ["LBTC", false], ["tBTC", false], ["BTC", true],
  ]);
});

test("exact wallet-coin lookups share quote eligibility, including base, curated ecosystem and high-precision indexed coins", async () => {
  const wal = coreCoin("0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL")!;
  const validator = createSocialValidator();
  const type = `${id(99)}::coin::TOKEN`;
  const metadata = { coin_type: type, symbol: "TOKEN", name: "Indexed token", decimals: 24, icon_url: "https://blast.test/token.png", is_presale: false };
  const db: ReadableDatabase = {
    async read<Row extends QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
      let rows: unknown[] = [];
      if (text === COIN_METADATA_SQL && (values[0] as string[]).includes(type)) rows = [metadata];
      else assert.ok([TRADE_COIN_LIST_SQL, TRADE_PRICES_SQL, TRADE_SALE_COINS_SQL, COIN_METADATA_SQL, TRADE_COIN_TRUST_SQL].includes(text));
      return { rows: rows as Row[], rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    },
  };
  for (const coinType of [SOCIAL_TRADE_BASE_COINS.sui, SOCIAL_TRADE_BASE_COINS.usdc, wal.coinType, type]) {
    const page = await readTradeCoinPage(db, parseTradeCoinListQuery(url(`?q=${encodeURIComponent(coinType)}`)), NOW);
    assert.equal(page.coins.length, 1, coinType);
    assert.equal(page.coins[0]!.coin_type, coinType);
    assert.equal(page.coins[0]!.presale_id, null);
    assert.equal(page.coins[0]!.usd_price, coinType === SOCIAL_TRADE_BASE_COINS.usdc ? "1" : null);
    assert.equal(isTradeCoinPage(page), true, "the browser accepts the quote server's metadata precision");
    assert.deepEqual(validator.validate("trade-coin-page", page), { valid: true, errors: [] });
    if (coinType === type) assert.equal(page.coins[0]!.decimals, 24);
    if (coinType === wal.coinType) assert.deepEqual([page.coins[0]!.name, page.coins[0]!.decimals, page.coins[0]!.icon_url], [wal.name, 9, wal.logoUrl], "unindexed ecosystem coins use the curated identity");
    assert.equal(page.next_cursor, null);
  }
  for (const excluded of [{ ...metadata, is_presale: true }, { ...metadata, decimals: null }]) {
    Object.assign(metadata, excluded);
    const page = await readTradeCoinPage(db, { q: type, cursor: null, limit: 50 }, NOW);
    assert.deepEqual(page.coins, [], "non-trading presales and unknown decimals remain ineligible");
  }
});


test("exact open-presale lookups retain the commit-flow gate", async () => {
  const type = `${id(7)}::coin::OPEN`;
  const row = { in_presale: true, presale_id: id(7), sale_token: type, sale_symbol: "OPEN", sale_name: "Open sale", sale_icon_url: null, sale_decimals: 9, quote_symbol: "USDC", quote_type: SOCIAL_TRADE_BASE_COINS.usdc, usd_price: null, as_of_ms: null };
  const db: ReadableDatabase = {
    async read<Row extends QueryResultRow>(sql: string): Promise<QueryResult<Row>> {
      assert.equal(sql, TRADE_COIN_LIST_SQL, "an open presale must not fall back to wallet-coin metadata");
      return { rows: [row] as unknown as Row[], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
    },
  };
  const page = await readTradeCoinPage(db, { q: type, cursor: null, limit: 50 }, NOW);
  assert.equal(page.coins[0]!.in_presale, true);
  assert.equal(page.coins[0]!.quote_type, SOCIAL_TRADE_BASE_COINS.usdc);
  assert.equal(page.next_cursor, null);
});
