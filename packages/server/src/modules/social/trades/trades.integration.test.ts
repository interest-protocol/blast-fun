import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { rebuildChainRead, type ChainPresaleRow } from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { SOCIAL_TRADE_COINS_PATH, SOCIAL_TRADE_QUOTE_PATH, type SocialTradeCoinPage, type SocialTradeQuote } from "@blast/core/modules/social/contracts/trades.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import type { TradeRouter } from "@blast/server/modules/social/trades/aggregator.ts";
import { AFTERMATH_DAO_PROVIDER, routeByVenue } from "@blast/server/modules/social/trades/aftermath.ts";
import { recordedAftermathRouter, YUM, YUM_POOL, YUM_WRAPPER } from "../../../../test/fixtures/modules/social/trades/aftermath-fixtures.ts";
import {
  balanceKey,
  offlineTradeChain,
  recordedData,
  replayDryRuns,
  replayRouter,
  SALE_A,
  SALE_B,
  SALE_B_POOL,
  SENDER,
  simulationSuccess,
  SUI,
  unreachableRouter,
  USDC,
} from "../../../../test/fixtures/modules/social/trades/fixtures.ts";
import { openTradeQuote, tradeQuoteKey } from "@blast/server/modules/social/trades/quote-token.ts";
import { createSocialTradeRoutes } from "@blast/server/modules/social/trades/route.ts";

/**
 * Social feed R3-30 (AC-1, AC-2, AC-5, AC-9, AC-126): the quote route over a
 * disposable database with the fixture `chain_read_v1` (two migrated Blast
 * sales whose coins are the owner's mainnet test coins, and R3-20 prices),
 * running as `blast_web`, with the Cetus aggregator's recorded mainnet
 * answers and an in-memory fullnode whose dry runs of the recorded SALE_B
 * route are mainnet's own (OA-29's impact). Fixture-only by construction:
 * R3-72 re-checks it against the live indexer.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-trades-app";
const PEPPER = "social-trades-fixture-pepper-0123456789ab";
const KEY = tradeQuoteKey(PEPPER);
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 8, statementTimeoutMs: 10_000 };
const NOW = Date.now();
const DID = "did:privy:trader";
const ACCOUNT = "00000000-0000-4000-8000-00000000a11c";

function bearer(subject: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: subject });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}

function presale(
  id: string,
  token: string,
  symbol: string,
  lifecycle: ChainPresaleRow["lifecycle"],
  venue: Readonly<{ venue: ChainPresaleRow["venue"]; pool: string | null }> = { venue: "cetus", pool: lifecycle === "migrated" ? SALE_B_POOL : null },
): ChainPresaleRow {
  return {
    presale_id: id, sale_token: token, quote_type: SUI, sale_symbol: symbol, sale_name: symbol, sale_icon_url: "",
    sale_decimals: 9, quote_symbol: "SUI", quote_decimals: 9, lifecycle, start_ms: NOW - 86_400_000, end_ms: NOW - 3_600_000,
    raise_target: "100000000000", min_commitment: "1000000", wallet_cap: null, total_commitments: "100000000000",
    participants: 3, venue: venue.venue, pool_id: venue.pool, updated_checkpoint: 900,
  };
}

const OPEN_SALE = `0x${"c0de".padStart(64, "0")}`;
const OPEN_COIN = "0x00000000000000000000000000000000000000000000000000000000000c0de0::open::OPEN";
/** A sale migrated through the Aftermath vendor whose pool the indexer has not bound: not a coin a trade can name. */
const UNBOUND_COIN = "0x00000000000000000000000000000000000000000000000000000000000af0af::unbound::UNBOUND";

type Fixture = Readonly<{
  admin: Pool;
  /** `GET /api/social/trades/coins` with `query` (R3-33). */
  coins(query?: string): Promise<Response>;
  quote(body: Readonly<Record<string, unknown>>, init?: { auth?: string | null; router?: TradeRouter }): Promise<Response>;
}>;

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  await rebuildChainRead(admin, {
    presales: [
      presale(`0x${"b0b".padStart(64, "0")}`, SALE_B, "BEE", "migrated"),
      presale(`0x${"a0a".padStart(64, "0")}`, SALE_A, "AYE", "migrated"),
      presale(OPEN_SALE, OPEN_COIN, "OPEN", "open"),
      // Aftermath DAO-fee sales (contracts ADR 0104): YUM's pool is the recorded mainnet pool.
      presale(`0x${"a1a1".padStart(64, "0")}`, YUM, "YUM", "migrated", { venue: "aftermath", pool: YUM_POOL }),
      presale(`0x${"af0af".padStart(64, "0")}`, UNBOUND_COIN, "UNB", "migrated", { venue: "aftermath", pool: null }),
    ],
    prices: [
      { coin_type: SUI, usd_price: "1.19", as_of_ms: NOW - 5_000, source: "pyth" },
      { coin_type: SALE_B, usd_price: "0.00000000006", as_of_ms: NOW - 5_000, source: "pool" },
    ],
  });
  await admin.query(
    `INSERT INTO social_accounts (account_id, privy_did, callsign, onboarded_at, privacy, sharing_since)
     VALUES ($1, $2, 'trader', now(), 'public', now())`,
    [ACCOUNT, DID],
  );

  const webPool = createRuntimePool(urlAs(url, "blast_web"), POOL, "social-trades-web");
  try {
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({
        appId: APP_ID,
        verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      }),
      // Keep the quote-budget test in one window, even across a wall-clock minute.
      limiter: new PostgresRateLimitEnforcer({ pool: webPool, subjectPepper: PEPPER, clock: () => new Date(NOW) }),
      accounts: new PostgresSocialAccounts(() => webPool),
      primary: () => webPool,
      metricSampleRate: 0,
    });
    // Swaps with a recorded mainnet dry run answer with it; any other passes with no balance change to read.
    const chain = offlineTradeChain({
      balances: { [balanceKey(SENDER, SUI)]: 10n ** 12n, [balanceKey(SENDER, USDC)]: 10n ** 9n },
      simulation: replayDryRuns(() => simulationSuccess()),
    });
    const routesFor = (router: TradeRouter) =>
      createSocialTradeRoutes({
        kit,
        database: () => autocommitReader(webPool, "social"),
        router: () => router,
        chain: () => chain,
        quoteKey: () => KEY,
        blastWallet: async (caller) => (caller.kind === "privy" ? SENDER : caller.address),
      });
    // The app's router: Cetus and Bluefin over the recordings, Aftermath DAO-fee pools over the recorded pool.
    const replay = routesFor(routeByVenue(replayRouter().router, recordedAftermathRouter(null)));
    await run({
      admin,
      coins: (query = "") => replay.coins.GET(new Request(`${ORIGIN}${SOCIAL_TRADE_COINS_PATH}${query}`), testClient()),
      quote: (body, init = {}) =>
        (init.router ? routesFor(init.router) : replay).quote.POST(
          new Request(`${ORIGIN}${SOCIAL_TRADE_QUOTE_PATH}`, {
            method: "POST",
            headers: {
              origin: ORIGIN,
              "content-type": "application/json",
              ...(init.auth === null ? {} : { authorization: init.auth ?? bearer(DID) }),
            },
            body: JSON.stringify(body),
          }), testClient()
        ),
    });
  } finally {
    await webPool.end();
    await admin.end();
    await database.drop();
  }
}

async function quoteOf(response: Response): Promise<SocialTradeQuote> {
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const body = (await response.json()) as SocialTradeQuote;
  const checked = validator.validate("trade-quote-response", body);
  assert.ok(checked.valid, JSON.stringify(checked.errors));
  return body;
}

test("a coin with a direct pool is quoted over that one pool, dry-run and offered (R3-30-AC-1)", { skip }, async () => {
  await withFixture(async ({ quote }) => {
    const body = { in_coin: SUI, out_coin: SALE_B, side: "buy", amount_in: "100000000" };
    assert.ok(validator.validate("trade-quote-request", body).valid);
    const answer = await quoteOf(await quote(body));
    const recorded = recordedData("sui-sale-b");
    assert.equal(answer.amount_out, recorded.amountOut);
    assert.equal(answer.min_out, "330341965386371467");
    assert.equal(answer.fee_bps, 100);
    // OA-27: the aggregator has no market price for this sale coin; OA-29: the same route dry-run again at 1%
    // (mainnet's fills: 332,001,975,262,684,891 and 18,793,099,960,001,698 SALE_B) measures 8233 bp.
    assert.equal(answer.price_impact_bps, 8_233);
    assert.equal(answer.price_impact_unavailable, null);
    assert.deepEqual(answer.route.map((hop) => [hop.pool_id, hop.venue]), [[SALE_B_POOL, "cetus"]]);
    assert.equal(answer.route_label, "SUI → BEE · Cetus");
    assert.equal(answer.dry_run, "passed");
    assert.deepEqual(answer.network_fee, { payer: "blast", label: "Paid by Blast", estimate_mist: "2565136" });
    const sealed = openTradeQuote(KEY, answer.quote_id!)!;
    assert.equal(sealed.accountId, ACCOUNT, "the quote is bound to the caller's account");
    assert.equal(sealed.sender, SENDER, "and to the wallet it was dry-run from");
  });
});

test("the picker identifies open presales with any quote coin as purchases and removes them when their sale closes", { skip }, async () => {
  await withFixture(async ({ admin, coins }) => {
    for (const [type, symbol, decimals] of [[USDC, "USDC", 6], [SUI, "SUI", 9], [`0x${"9".repeat(64)}::test_sui::TEST_SUI`, "TSUI", 9]] as const) {
      await admin.query("UPDATE blast_infra_fixture.presales SET quote_type = $1, quote_symbol = $2, quote_decimals = $3, end_ms = $4 WHERE sale_token = $5", [type, symbol, decimals, NOW + 3_600_000, OPEN_COIN]);
      const response = await coins("?q=OPEN");
      assert.equal(response.status, 200);
      const body = await response.json() as SocialTradeCoinPage;
      assert.equal(validator.validate("trade-coin-page", body).valid, true);
      assert.equal(body.coins.length, 1);
      assert.equal(body.coins[0]!.in_presale, true, symbol);
      assert.equal(body.coins[0]!.quote_symbol, symbol);
      assert.equal(body.coins[0]!.quote_type, type);
    }
    await admin.query("UPDATE blast_infra_fixture.presales SET end_ms = $1 WHERE sale_token = $2", [NOW - 1, OPEN_COIN]);
    const closed = await (await coins("?q=OPEN")).json() as SocialTradeCoinPage;
    assert.deepEqual(closed.coins, []);
  });
});

test("TSUI and its presales stay out of both public coin searches", { skip }, async () => {
  await withFixture(async ({ admin, coins }) => {
    await admin.query(
      "UPDATE blast_infra_fixture.presales SET quote_type = $1, quote_symbol = 'TSUI', quote_decimals = 9, end_ms = $2 WHERE sale_token = $3",
      [CREATE_TEST_SUI_QUOTE_TYPE, NOW + 3_600_000, OPEN_COIN],
    );

    assert.deepEqual((await coinPageOf(await coins("?q=OPEN"))).coins, []);
    assert.deepEqual((await coinPageOf(await coins("?q=OPEN&include_launch=1"))).coins, []);
    const exact = `?q=${encodeURIComponent(OPEN_COIN)}`;
    assert.deepEqual((await coinPageOf(await coins(exact))).coins, []);
    assert.deepEqual((await coinPageOf(await coins(`${exact}&include_launch=1`))).coins, []);

    await admin.query("INSERT INTO blast_infra_fixture.coin_metadata (coin_type, name, symbol, decimals) VALUES ($1, 'Test Sui', 'TSUI', 9)", [CREATE_TEST_SUI_QUOTE_TYPE]);
    assert.deepEqual((await coinPageOf(await coins(`?q=${encodeURIComponent(CREATE_TEST_SUI_QUOTE_TYPE)}`))).coins, []);
  });
});

test("a coin with no direct pool is quoted over the aggregator's legs, the gate's two-hop wording (R3-30-AC-2)", { skip }, async () => {
  await withFixture(async ({ quote }) => {
    const answer = await quoteOf(await quote({ in_coin: USDC, out_coin: SALE_B, side: "buy", amount_in: "1000000" }));
    assert.equal(answer.amount_out, recordedData("usdc-sale-b").amountOut);
    assert.equal(answer.route.length, 3);
    assert.equal(answer.route.at(-1)!.pool_id, SALE_B_POOL);
    // The intermediate the aggregator chose has no Blast symbol, so the coins read USDC → SUI → BEE.
    assert.equal(answer.route_label, "USDC → SUI → BEE · Sui pools and Cetus");
    assert.ok(answer.fee_bps! >= 100, "every leg's fee compounds");
    // No aggregator market price for the sale coin (OA-27), and no recorded fill for this route's dry runs to compare
    // (the in-memory fullnode shows no balance change): null, and why, never a guess.
    assert.equal(answer.price_impact_bps, null);
    assert.equal(answer.price_impact_unavailable, "reference_failed");
    assert.ok(answer.quote_id);
  });
});

test("no pool, an unreachable aggregator and a coin that is not trading each answer a code and no numbers (R3-30-AC-5)", { skip }, async () => {
  await withFixture(async ({ quote }) => {
    const none = await quoteOf(await quote({ in_coin: SUI, out_coin: SALE_A, side: "buy", amount_in: "100000000" }));
    assert.equal(none.unavailable_reason, "no_pool");
    const down = await quoteOf(await quote({ in_coin: SUI, out_coin: SALE_B, side: "buy", amount_in: "100000000" }, { router: unreachableRouter }));
    assert.equal(down.unavailable_reason, "pool_unavailable");
    const open = await quoteOf(await quote({ in_coin: SUI, out_coin: OPEN_COIN, side: "buy", amount_in: "100000000" }));
    assert.equal(open.unavailable_reason, "not_tradable");
    for (const answer of [none, down, open]) {
      assert.deepEqual(
        [answer.quote_id, answer.amount_out, answer.min_out, answer.price_impact_bps, answer.price_impact_unavailable, answer.fee_bps, answer.route.length],
        [null, null, null, null, null, null, 0],
      );
    }
  });
});

test("indexed non-Blast metadata reaches the router without a USD price; no liquidity remains no_pool", { skip }, async () => {
  await withFixture(async ({ admin, coins, quote }) => {
    await admin.query("DELETE FROM blast_infra_fixture.presales WHERE sale_token = $1", [SALE_B]);
    await admin.query("INSERT INTO blast_infra_fixture.coin_metadata (coin_type, name, symbol, decimals) VALUES ($1, 'DeepBook', 'DEEP', 9)", [SALE_B]);
    await admin.query("DELETE FROM blast_infra_fixture.prices WHERE coin_type = $1", [SALE_B]);
    const offered = await quoteOf(await quote({ in_coin: SUI, out_coin: SALE_B, side: "buy", amount_in: "100000000" }));
    assert.equal(offered.unavailable_reason, null);
    assert.equal(offered.dry_run, "passed");
    assert.equal(offered.price_per_out, null);
    assert.match(offered.route_label!, /DEEP/);
    assert.ok(offered.quote_id);
    let searches = 0;
    const router: TradeRouter = { ...replayRouter().router, findRoute: async () => { searches += 1; return { status: "no_route" }; } };
    const empty = await quoteOf(await quote({ in_coin: SALE_B, out_coin: SUI, side: "sell", amount_in: "100000000" }, { router }));
    assert.equal(searches, 1);
    assert.equal(empty.unavailable_reason, "no_pool");
    assert.equal(empty.quote_id, null);
    assert.equal(empty.amount_out, null);
    // Indexed metadata never bypasses an open Blast sale's lifecycle.
    await admin.query("INSERT INTO blast_infra_fixture.coin_metadata (coin_type, name, symbol, decimals) VALUES ($1, 'Open', 'OPEN', 9)", [OPEN_COIN]);
    const open = await quoteOf(await quote({ in_coin: SUI, out_coin: OPEN_COIN, side: "buy", amount_in: "100000000" }, { router }));
    assert.equal(open.unavailable_reason, "not_tradable");
    assert.equal(searches, 1);
    // A logo stored inline past the wire's bound is dropped, not a page the picker rejects.
    await admin.query("UPDATE blast_infra_fixture.coin_metadata SET icon_url = $1 WHERE coin_type = $2", [`data:image/png;base64,${"A".repeat(20_000)}`, SALE_B]);
    const exact = await coinPageOf(await coins(`?q=${encodeURIComponent(SALE_B)}`));
    assert.deepEqual(exact.coins.map((coin) => [coin.symbol, coin.icon_url]), [["DEEP", null]]);
  });
});

test("search finds a graduated Blast coin by name, ticker and exact type", { skip }, async () => {
  await withFixture(async ({ admin, coins }) => {
    const coinType = "0xbcd73dc8d774982c2da4e07cd1c6803ec29e128821d1ade9e9a7ce4975b44944::joey::JOEY";
    const launchId = `0x${"cd".repeat(32)}`;
    const curveKey = `blast_curve:${launchId}`;
    const poolKey = `cetus:0x${"ef".repeat(32)}`;
    await admin.query("INSERT INTO blast_infra_fixture.coin_metadata (coin_type, name, symbol, decimals) VALUES ($1, 'Little Joey', 'JOEY', 9)", [coinType]);
    await admin.query("INSERT INTO coins (coin_type, decimals, launcher, pool_key, created_checkpoint, created_at_ms, metadata) VALUES ($1, 9, '0xc0ffee', $2, 900, $3, jsonb_build_object('name', 'Little Joey', 'symbol', 'JOEY'))", [coinType, poolKey, NOW]);
    await admin.query(
      `INSERT INTO pools (pool_key, venue, coin_type, quote_type, lifecycle, created_checkpoint, created_at_ms)
       VALUES ($1, 'blast_curve', $3, $4, 'migrated', 900, $5), ($2, 'cetus', $3, $4, 'trading', 901, $5)`,
      [curveKey, poolKey, coinType, SUI, NOW],
    );
    const query = `?q=${encodeURIComponent(coinType)}`;
    assert.equal((await coinPageOf(await coins(query))).coins[0]?.launch_id, undefined);
    const result = await coinPageOf(await coins(`${query}&include_launch=1`));
    assert.deepEqual(result.coins.map((coin) => [coin.coin_type, coin.launch_id]), [[coinType, launchId]]);
    const byTicker = await coinPageOf(await coins("?q=Joey&limit=1&include_launch=1"));
    const byName = await coinPageOf(await coins("?q=Little%20Joey&include_launch=1"));
    assert.deepEqual(byTicker.coins.map((coin) => [coin.coin_type, coin.launch_id]), [[coinType, launchId]]);
    assert.deepEqual(byName.coins.map((coin) => [coin.symbol, coin.name]), [["JOEY", "Little Joey"]]);
    assert.deepEqual((await coinPageOf(await coins("?q=Joey"))).coins, [], "the trade picker stays unchanged");
    await admin.query("UPDATE blast_infra_fixture.presales SET sale_name = 'Sui sale' WHERE sale_token = ANY($1::text[])", [[SALE_A, SALE_B]]);
    await admin.query("UPDATE coins SET metadata = jsonb_set(metadata, '{name}', to_jsonb($2::text)) WHERE coin_type = $1", [coinType, "Sui Joey"]);
    const smallPage = await coinPageOf(await coins("?q=SUI&limit=2&include_launch=1"));
    assert.deepEqual(smallPage.coins.map((coin) => coin.symbol), ["SUI", "AYE"]);
    const secondPage = await coinPageOf(await coins(`?q=SUI&limit=2&include_launch=1&cursor=${smallPage.next_cursor}`));
    assert.deepEqual(secondPage.coins.map((coin) => coin.symbol), ["BEE"]);

    await admin.query("UPDATE pools SET quote_type = $1 WHERE pool_key = $2", [CREATE_TEST_SUI_QUOTE_TYPE, curveKey]);
    assert.deepEqual((await coinPageOf(await coins("?q=Joey&include_launch=1"))).coins, [], "test launches are hidden in text search");
    assert.deepEqual((await coinPageOf(await coins(`${query}&include_launch=1`))).coins, []);
    assert.deepEqual((await coinPageOf(await coins(query))).coins, []);

    const testLaunch = "0xbb95f095a7601a3500ee0a6983459a21ed1c91253ea2a2599eeb1e1ead76ef83::tsui::TSUI";
    await admin.query("UPDATE pools SET coin_type = $1, quote_type = $2 WHERE pool_key IN ($3, $4)", [testLaunch, SUI, curveKey, poolKey]);
    await admin.query("UPDATE coins SET coin_type = $1, metadata = '{\"name\":\"Test Sui\",\"symbol\":\"TSUI\"}' WHERE coin_type = $2", [testLaunch, coinType]);
    await admin.query("UPDATE blast_infra_fixture.coin_metadata SET coin_type = $1, symbol = 'TSUI' WHERE coin_type = $2", [testLaunch, coinType]);
    assert.deepEqual((await coinPageOf(await coins("?q=TSUI&include_launch=1"))).coins.map((coin) => coin.symbol), ["stSUI"]);
    assert.deepEqual((await coinPageOf(await coins(`?q=${encodeURIComponent(testLaunch)}&include_launch=1`))).coins, []);
  });
});

test("a pasted type finds the presale page even after commitments closed", { skip }, async () => {
  await withFixture(async ({ coins }) => {
    const query = `?q=${encodeURIComponent(OPEN_COIN)}`;
    assert.deepEqual((await coinPageOf(await coins(query))).coins, [], "the trade picker excludes the closed sale");
    const result = await coinPageOf(await coins(`${query}&include_launch=1`));
    assert.deepEqual(result.coins.map((coin) => [coin.coin_type, coin.presale_id, coin.in_presale]), [[OPEN_COIN, OPEN_SALE, undefined]]);
  });
});

test("Aftermath: a coin whose sale migrated to a DAO-fee pool is quoted through that pool, dry-run and offered; never not_tradable", { skip }, async () => {
  await withFixture(async ({ quote }) => {
    const answer = await quoteOf(await quote({ in_coin: SUI, out_coin: YUM, side: "buy", amount_in: "1000000000" }));
    assert.equal(answer.unavailable_reason, null);
    assert.equal(answer.amount_out, "5924377913536", "mainnet's own fill of 1 SUI (fixture)");
    assert.deepEqual(answer.route.map((hop) => [hop.pool_id, hop.venue]), [[YUM_WRAPPER, "aftermath"]]);
    assert.equal(answer.route_label, "SUI → YUM · Aftermath");
    assert.equal(answer.fee_bps, 334, "the DAO fee, Aftermath's protocol fee and the pool's swap fee, compounded");
    assert.equal(answer.dry_run, "passed");
    const sealed = openTradeQuote(KEY, answer.quote_id!)!;
    assert.equal(sealed.route.paths[0]!.provider, AFTERMATH_DAO_PROVIDER);
    assert.ok(sealed.route.paths[0]!.lpType, "the DAO-fee swap's LP type is sealed with it");

    const sell = await quoteOf(await quote({ in_coin: YUM, out_coin: SUI, side: "sell", amount_in: "2000000000000" }, { auth: null }));
    assert.equal(sell.amount_out, "303071360");
    assert.equal(sell.offer_refused, "sign_in");

    // Migrated through the vendor, but no pool bound yet: nothing to route through.
    const unbound = await quoteOf(await quote({ in_coin: SUI, out_coin: UNBOUND_COIN, side: "buy", amount_in: "1000000000" }));
    assert.equal(unbound.unavailable_reason, "not_tradable");
  });
});

test("a signed-out visitor sees a price and is not offered a quote", { skip }, async () => {
  await withFixture(async ({ quote }) => {
    const answer = await quoteOf(await quote({ in_coin: SUI, out_coin: SALE_B, side: "buy", amount_in: "100000000" }, { auth: null }));
    assert.equal(answer.offer_refused, "sign_in");
    assert.equal(answer.quote_id, null);
    assert.equal(answer.network_fee, null);
    assert.equal(answer.price_per_out, "0.00000000006");
    // OA-29: no dry run for a visitor, so no impact for a sale coin.
    assert.equal(answer.price_impact_bps, null);
    assert.equal(answer.price_impact_unavailable, "no_dry_run");
  });
});

test("a signed-in sale-coin quote dry-runs twice (OA-29) and counts once in each bucket", { skip }, async () => {
  await withFixture(async ({ admin, quote }) => {
    const answer = await quoteOf(await quote({ in_coin: SUI, out_coin: SALE_B, side: "buy", amount_in: "100000000" }));
    assert.equal(answer.price_impact_bps, 8_233, "the reference run happened");
    const counted = await admin.query<{ policy_name: string; count: number }>(
      `SELECT policy_name, max(request_count)::int AS count FROM mission_control_rate_limit_windows GROUP BY policy_name ORDER BY policy_name`,
    );
    assert.deepEqual(counted.rows, [
      { policy_name: "social_read_quote", count: 1 },
      { policy_name: "social_trade_quote", count: 1 },
    ]);
  });
});

test("a malformed body is invalid_request: both amounts, neither, a side against the coins, a coin spelled short, slippage 0", { skip }, async () => {
  await withFixture(async ({ quote }) => {
    const base = { in_coin: SUI, out_coin: SALE_B, side: "buy" };
    for (const body of [
      { ...base, amount_in: "1", amount_out: "1" },
      base,
      { ...base, side: "sell", amount_in: "1" },
      { ...base, in_coin: "0x2::sui::SUI", amount_in: "1" },
      { ...base, out_coin: SUI, amount_in: "1" },
      { ...base, amount_in: "0" },
      { ...base, amount_in: "1", slippage_bps: 0 },
      { ...base, amount_in: "1", slippage_bps: 501 },
      { ...base, amount_in: "1", extra: true },
    ]) {
      const response = await quote(body);
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, "invalid_request");
    }
  });
});

test("a signed-in caller past the per-account quote bucket is 429 rate_limited with Retry-After (R3-30-AC-9)", { skip }, async () => {
  await withFixture(async ({ quote }) => {
    // A coin that is not trading answers without the aggregator, so the 120 allowed quotes are quick.
    const body = { in_coin: SUI, out_coin: OPEN_COIN, side: "buy", amount_in: "1" };
    for (let n = 0; n < 120; n += 1) assert.equal((await quote(body)).status, 200, `quote ${n}`);
    const limited = await quote(body);
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.equal(((await limited.json()) as { error: { code: string } }).error.code, "rate_limited");
    // A visitor is counted per IP, not by the account's bucket.
    assert.equal((await quote(body, { auth: null })).status, 200);
  });
});

async function coinPageOf(response: Response): Promise<SocialTradeCoinPage> {
  assert.equal(response.status, 200);
  // Public and the same for every caller: the shared cache may keep it (the kit's public policy).
  assert.match(response.headers.get("cache-control") ?? "", /^public, /);
  const body = (await response.json()) as SocialTradeCoinPage;
  const checked = validator.validate("trade-coin-page", body);
  assert.ok(checked.valid, JSON.stringify(checked.errors));
  return body;
}

test("R3-33: the picker's coins are every migrated sale's coin by ticker, priced only while fresh, searchable and paged by keyset", { skip }, async () => {
  await withFixture(async ({ coins, admin }) => {
    const all = await coinPageOf(await coins());
    // AYE and BEE trade (migrated), and YUM in its Aftermath DAO-fee pool; OPEN is still open, and UNB's pool is not
    // known yet, so neither is a coin a trade can name.
    assert.deepEqual(all.coins.map((coin) => coin.symbol), ["AYE", "BEE", "YUM"]);
    assert.equal(all.next_cursor, null);
    const bee = all.coins.find((coin) => coin.symbol === "BEE")!;
    assert.deepEqual(bee, {
      coin_type: SALE_B, symbol: "BEE", name: "BEE", decimals: 9, icon_url: null, usd_price: "0.00000000006", presale_id: `0x${"b0b".padStart(64, "0")}`,
    });
    assert.equal(all.coins.find((coin) => coin.symbol === "AYE")!.usd_price, null, "no price row: no price, never a guess");

    // Search: ticker or name, case-insensitive, a leading $ ignored; % and _ match themselves.
    assert.deepEqual((await coinPageOf(await coins("?q=%24be"))).coins.map((coin) => coin.symbol), ["BEE"]);
    assert.deepEqual((await coinPageOf(await coins("?q=ay"))).coins.map((coin) => coin.symbol), ["AYE"]);
    assert.deepEqual((await coinPageOf(await coins(`?q=${encodeURIComponent(SALE_B)}`))).coins.map((coin) => coin.symbol), ["BEE"]);
    const paddedType = `0x${"2".padStart(64, "0")}::coin::TOKEN`;
    await admin.query("UPDATE blast_infra_fixture.presales SET sale_token = $1 WHERE sale_token = $2", [paddedType, SALE_B]);
    for (const type of [paddedType, "0x2::coin::TOKEN", "0x2::coin", "0x0002::coin"]) {
      assert.deepEqual((await coinPageOf(await coins(`?q=${encodeURIComponent(type)}`))).coins.map((coin) => coin.symbol), ["BEE"]);
    }
    await admin.query("UPDATE blast_infra_fixture.presales SET sale_token = $1 WHERE sale_token = $2", [SALE_B, paddedType]);
    assert.deepEqual((await coinPageOf(await coins("?q=%25"))).coins, []);
    assert.deepEqual((await coinPageOf(await coins("?q=xyz"))).coins, []);

    // Keyset paging: one at a time, then the rest, and nothing repeats.
    const first = await coinPageOf(await coins("?limit=1"));
    assert.deepEqual(first.coins.map((coin) => coin.symbol), ["AYE"]);
    assert.ok(first.next_cursor);
    const second = await coinPageOf(await coins(`?limit=1&cursor=${first.next_cursor}`));
    assert.deepEqual(second.coins.map((coin) => coin.symbol), ["BEE"]);
    const third = await coinPageOf(await coins(`?limit=5&cursor=${second.next_cursor}`));
    assert.deepEqual(third.coins.map((coin) => coin.symbol), ["YUM"]);
    assert.equal(third.next_cursor, null);

    // A symbol is whatever its publisher wrote: empty, or hundreds of emoji. Every page still passes and the keyset walks them all.
    const ids = (page: SocialTradeCoinPage) => page.coins.map((coin) => coin.presale_id);
    const [ayeId, beeId, yumId] = ids(all);
    await admin.query("UPDATE blast_infra_fixture.presales SET sale_symbol = '' WHERE presale_id = $1", [beeId]);
    await admin.query("UPDATE blast_infra_fixture.presales SET sale_symbol = $1 WHERE presale_id = $2", ["🐳".repeat(500), yumId]);
    const walked: (string | null)[] = [];
    for (let cursor = "", pages = 0; pages < 5; pages += 1) {
      const page = await coinPageOf(await coins(`?limit=1${cursor}`));
      walked.push(...ids(page));
      if (!page.next_cursor) break;
      cursor = `&cursor=${page.next_cursor}`;
    }
    assert.deepEqual(walked, [beeId, ayeId, yumId]);
    const odd = (await coinPageOf(await coins())).coins;
    assert.equal(odd.find((coin) => coin.presale_id === yumId)?.symbol, "🐳".repeat(64));
    assert.ok(odd.find((coin) => coin.presale_id === beeId)?.symbol);
    await admin.query("UPDATE blast_infra_fixture.presales SET sale_symbol = 'BEE' WHERE presale_id = $1", [beeId]);
    await admin.query("UPDATE blast_infra_fixture.presales SET sale_symbol = 'YUM' WHERE presale_id = $1", [yumId]);

    // A price older than 120 s is not shown.
    await admin.query("UPDATE blast_infra_fixture.prices SET as_of_ms = $1 WHERE coin_type = $2", [Date.now() - 121_000, SALE_B]);
    assert.equal((await coinPageOf(await coins("?q=bee"))).coins[0]!.usd_price, null);

    for (const [query, parameter] of [["?limit=0", "limit"], ["?limit=51", "limit"], ["?cursor=nope", "cursor"], ["?q=", "q"], [`?q=${"x".repeat(513)}`, "q"], ["?q=a&q=b", "q"]] as const) {
      const refused = await coins(query);
      assert.equal(refused.status, 400, query);
      const body = (await refused.json()) as { error: { code: string; parameter?: string } };
      assert.equal(body.error.code, "invalid_parameter", query);
      assert.equal(body.error.parameter, parameter, query);
      assert.ok(validator.validate("error", body).valid);
    }
  });
});
