import { testClient } from "../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import { CORE_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import {
  seedChainRead,
  type ChainActivityRow,
  type ChainPresalePositionRow,
  type ChainPresaleRow,
} from "../../../../../../packages/core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { NO_COST_BASIS, type SocialPortfolio } from "@blast/core/modules/social/contracts/portfolio.ts";
import { CREATE_USDSUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { FEED_STORY_ACCOUNTS, FEED_STORY_PRESALES, FEED_STORY_QUOTE_TYPE, FEED_STORY_WALLETS, seedFeedStory, type FeedStory } from "../../../../../../packages/core/test/fixtures/modules/social/feed/feed-story.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { readCostBasisLedger, UNKNOWN_BASIS } from "@blast/server/modules/social/portfolio/cost-basis.ts";
import type { SocialPnl } from "@blast/core/modules/social/contracts/pnl.ts";
import { createSocialPnlRoutes } from "@blast/server/modules/social/portfolio/pnl-route.ts";
import { readTraderPortfolios } from "@blast/server/modules/social/home/traders.ts";
import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import { createSocialPortfolioRoute } from "@blast/server/modules/social/portfolio/route.ts";
import { isSocialPortfolio } from "#web/components/social/portfolio-client.ts";
import { portfolioCoverage, portfolioFigures } from "#web/components/social/portfolio/portfolio-model.ts";
import { PORTFOLIO_TREND_STATEMENTS, readPortfolioSnapshots } from "@blast/server/modules/social/portfolio/trend.ts";
import { hex } from "../../../../../../packages/core/test/kit.ts";

/**
 * Social-feed T-019: `GET /api/social/me/portfolio` over a disposable
 * database with the fixture `chain_read_v1` and the feed story. Kai (A) has
 * two wallets and positions in presales in every state; Nova (B) has one
 * wallet and one position; an unowned wallet has positions too. Indexed wallet
 * balances include cash and arbitrary tokens. Every read runs as `blast_web` on
 * the primary pool the route is given.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-portfolio-app";
const PEPPER = "social-portfolio-fixture-pepper-0123456789abcdef";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 6, statementTimeoutMs: 5_000 };
const NOW = Date.now();
const DAY = 86_400_000;
const PRIVATE = "private, no-store";
const SUI = PORTFOLIO_COIN_TYPES.sui;
const USDC = PORTFOLIO_COIN_TYPES.usdc;

const KAI_SECOND_WALLET = hex("ca2");
const ENDED_PRESALE = hex("5eed0");
const P = FEED_STORY_PRESALES;
const W = FEED_STORY_WALLETS;

function bearer(did: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: did });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}
const KAI = bearer("did:privy:feed-story-kai");
const NOVA = bearer("did:privy:feed-story-nova");

/** On-chain balances by `owner|coinType`; an owner with nothing gets "0". */
const BALANCES: Readonly<Record<string, string>> = {
  [`${W.kai}|${SUI}`]: "1500000000",
  [`${KAI_SECOND_WALLET}|${SUI}`]: "2000000000",
  [`${W.kai}|${USDC}`]: "10000000",
  [`${KAI_SECOND_WALLET}|${USDC}`]: "5500000",
  [`${W.nova}|${SUI}`]: "1000000000",
  [`${W.anon}|${SUI}`]: "999000000000",
  [`${W.anon}|${USDC}`]: "999000000",
};

function presale(id: string, symbol: string, lifecycle: ChainPresaleRow["lifecycle"], endMs: number): ChainPresaleRow {
  return {
    presale_id: id, sale_token: `${id}::coin::${symbol}`, quote_type: USDC, sale_symbol: symbol,
    sale_name: symbol, sale_icon_url: `https://i.blast.test/${symbol.toLowerCase()}.png`, sale_decimals: 9,
    quote_symbol: "USDC", quote_decimals: 6, lifecycle, start_ms: NOW - 20 * DAY, end_ms: endMs, raise_target: "100000000000",
    min_commitment: "1000000", wallet_cap: null, total_commitments: "0", participants: 0, venue: "cetus", pool_id: null,
    updated_checkpoint: 20_000,
  };
}

function position(
  presaleId: string,
  wallet: string,
  commitment: string,
  minutesAgo: number,
  claim: Readonly<{ tokens: string; refund: string }> | null = null,
): ChainPresalePositionRow {
  return {
    presale_id: presaleId, wallet, commitment, last_commit_ms: NOW - minutesAgo * 60_000,
    claim_digest: claim ? `Claim${presaleId.slice(-4)}${wallet.slice(-4)}`.padEnd(44, "1") : null,
    claimed_tokens: claim?.tokens ?? null, claimed_quote_refund: claim?.refund ?? null, claimed_ms: claim ? NOW - 60_000 : null,
  };
}

/**
 * Kai's positions: open (both wallets, summed), an ended open sale, funded,
 * migrated and cancelled (unclaimed) and an old migrated sale (claimed).
 * Nova: one open position. The unowned wallet: two positions.
 */
async function seedPortfolio(admin: Pool): Promise<void> {
  const since = new Date(NOW - 60 * DAY).toISOString();
  await admin.query("INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, $3)", [
    KAI_SECOND_WALLET, FEED_STORY_ACCOUNTS.kai, since,
  ]);
  await seedChainRead(admin, {
    presales: [presale(ENDED_PRESALE, "DONE", "open", NOW - 60_000)],
    presale_positions: [
      position(P.open, W.kai, "20000000", 10),
      position(P.open, KAI_SECOND_WALLET, "30000000", 5),
      position(ENDED_PRESALE, KAI_SECOND_WALLET, "7000000", 2 * 24 * 60),
      position(P.funded, W.kai, "11000000", 3 * 24 * 60),
      position(P.migratedRecently, W.kai, "40000000", 4 * 24 * 60),
      position(P.cancelled, KAI_SECOND_WALLET, "9000000", 5 * 24 * 60),
      position(P.migratedLongAgo, W.kai, "25000000", 12 * 24 * 60, { tokens: "250000000000", refund: "5000000" }),
      position(P.open, W.nova, "20000000", 8),
      position(P.migratedRecently, W.anon, "5000000000", 30),
      position(P.open, W.anon, "1000000", 15),
    ],
    prices: [
      { coin_type: SUI, usd_price: "3.5", as_of_ms: NOW - 10_000, source: "pyth" },
      // 121 s old at NOW: too old for USD.
      { coin_type: USDC, usd_price: "0.9998", as_of_ms: NOW - 121_000, source: "pyth" },
    ],
  });
}

type Fixture = Readonly<{
  admin: Pool;
  /** The test's own database. */
  url: string;
  story: FeedStory;
  get(headers?: Record<string, string>, query?: string): Promise<Response>;
  getCoins(headers?: Record<string, string>, query?: string): Promise<Response>;
  getPnl(headers?: Record<string, string>, query?: string): Promise<Response>;
  publicPnl(callsign: string): Promise<Response>;
  pnlDown(): Promise<Response>;
  /** The same route over a database whose every read fails. */
  getWithDatabaseDown(headers: Record<string, string>): Promise<Response>;
}>;

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  const story = await seedFeedStory(admin, { nowMs: NOW });
  await admin.query("UPDATE blast_infra_fixture.presales SET quote_type = $1 WHERE quote_type = $2", [USDC, FEED_STORY_QUOTE_TYPE]);
  await seedPortfolio(admin);
  const webPool = createRuntimePool(urlAs(url, "blast_web"), POOL, "social-portfolio-web");
  try {
    assert.equal((await webPool.query("SELECT current_user AS role")).rows[0]?.role, "blast_web");
    const accounts = new PostgresSocialAccounts(() => webPool);
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({
        appId: APP_ID,
        verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      }),
      limiter: new PostgresRateLimitEnforcer({ pool: webPool, subjectPepper: PEPPER }),
      accounts,
      primary: () => webPool,
    });
    for (const [key, balance] of Object.entries(BALANCES)) {
      const [owner, coin] = key.split("|");
      await admin.query("INSERT INTO blast_infra_fixture.coin_balances VALUES ($1,$2,$3,80001) ON CONFLICT (coin_type,owner) DO UPDATE SET balance=excluded.balance", [coin, owner, balance]);
      await admin.query("INSERT INTO blast_infra_fixture.wallet_sync(owner,timestamp_ms) VALUES ($1,$2) ON CONFLICT DO NOTHING", [owner,NOW]);
    }
    const primary = autocommitReader(webPool, "social", { prepare: true });
    const route = createSocialPortfolioRoute({
      kit, wallets: accounts, database: () => primary, now: () => NOW,
    });
    const down: ReadableDatabase = {
      read: () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })),
    };
    const routeDown = createSocialPortfolioRoute({ kit, wallets: accounts, database: () => down, now: () => NOW });
    const pnlRoutes = createSocialPnlRoutes({ kit, wallets: accounts, database: () => primary, now: () => NOW });
    const pnlDown = createSocialPnlRoutes({ kit, wallets: accounts, database: () => down, now: () => NOW });
    const request = (headers: Record<string, string>, query = "") =>
      new Request(`${ORIGIN}/api/social/me/portfolio${query}`, { headers: { "x-forwarded-for": "203.0.113.9", ...headers } });
    await run({
      admin,
      url,
      story,
      get: (headers = {}, query = "") => route.GET(request(headers, query), testClient()),
      getCoins: (headers = {}, query = "") => route.COINS(new Request(`${ORIGIN}/api/social/me/portfolio/coins${query}`, { headers }), testClient()),
      getPnl: (headers = {}, query = "") => pnlRoutes.GET(new Request(`${ORIGIN}/api/social/me/pnl${query}`, { headers }), testClient()),
      publicPnl: (callsign) => pnlRoutes.PUBLIC(new Request(`${ORIGIN}/api/social/profiles/${callsign}/pnl`), testClient()),
      pnlDown: () => pnlDown.GET(new Request(`${ORIGIN}/api/social/me/pnl`, { headers: { authorization: NOVA } }), testClient()),
      getWithDatabaseDown: (headers) => routeDown.GET(request(headers), testClient()),
    });
  } finally {
    await Promise.all([admin.end(), webPool.end()]);
    await database.drop();
  }
}

async function ok(response: Response): Promise<SocialPortfolio> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate("portfolio-response", body).errors, []);
  assert.equal(response.headers.get("cache-control"), PRIVATE);
  assert.ok(response.headers.get("x-request-id"));
  return body as SocialPortfolio;
}

async function refused(response: Response, status: number, code: string, cache = PRIVATE): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error: { code: string } } & Record<string, unknown>;
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  assert.deepEqual(validator.validate("error", body).errors, []);
  assert.equal(response.headers.get("cache-control"), cache);
  assert.ok(response.headers.get("x-request-id"));
  return body;
}

const PORTFOLIO_KEYS = ["balances", "positions", "coins", "vesting", "totals", "trend", "wallet_sync", "commitments", "prices_as_of_ms", "unavailable"];

test("T-019-AC-1 (AC-110): A and B each get only their own wallets' data; no parameter selects another account", { skip }, async () => {
  await withFixture(async ({ get }) => {
    const kai = await ok(await get({ authorization: KAI }));
    assert.equal(kai.balances?.sui.atoms, "3500000000");
    assert.deepEqual(kai.positions?.map((p) => p.presale_id).sort(), [
      P.open, ENDED_PRESALE, P.funded, P.migratedRecently, P.cancelled, P.migratedLongAgo,
    ].sort());

    const nova = await ok(await get({ authorization: NOVA }));
    assert.deepEqual(nova.balances, { sui: { atoms: "1000000000", usd: "3.50" }, usdc: { atoms: "0", usd: null } });
    assert.deepEqual(nova.positions?.map((p) => [p.presale_id, p.commitment, p.status]), [[P.open, "20000000", "open"]]);
    // Nova authored nothing anyone acted through.
    assert.deepEqual(nova.totals, { people: 0, volume_usd: "0.00" });

    const selected = await ok(await get({ authorization: KAI }, `?wallet=${KAI_SECOND_WALLET}`));
    assert.equal(selected.balances?.sui.atoms, "2000000000");
    assert.equal(selected.positions?.find(p => p.presale_id === P.open)?.commitment, "30000000");
    await refused(await get({ authorization: NOVA }, `?wallet=${W.kai}`), 404, "not_found");

    // An account id, callsign or unrecognized wallet parameter cannot change the owner.
    for (const query of [
      "?callsign=kai", `?account_id=${FEED_STORY_ACCOUNTS.kai}`, `?address=${W.anon}&owner=kai`, "?account=kai",
    ]) {
      assert.deepEqual(await ok(await get({ authorization: NOVA }, query)), nova, query);
    }
    // Never the unowned wallet's data, for anyone.
    for (const body of [kai, nova]) {
      assert.ok(!JSON.stringify(body).includes("999000000"));
      assert.ok(body.positions?.every((p) => p.commitment !== "5000000000" && p.commitment !== "1000000"));
    }
  });
});

test("T-019-AC-2 (AC-111, AC-124): private, no-store; 401 without a valid token with no portfolio field; 409 without an account; 503 when the database is down", { skip }, async () => {
  await withFixture(async ({ get, getWithDatabaseDown }) => {
    for (const headers of [{}, { authorization: "Bearer not-a-token" }, { authorization: "Basic a2FpOmthaQ==" }, { authorization: `${KAI.slice(0, -12)}${KAI.slice(-12) === "A".repeat(12) ? "B" : "A"}${"A".repeat(11)}` }] as Record<string, string>[]) {
      const body = await refused(await get(headers), 401, "unauthorized");
      assert.deepEqual(Object.keys(body), ["error"]);
      assert.ok(PORTFOLIO_KEYS.every((key) => !JSON.stringify(body).includes(`"${key}"`)));
    }
    // Signed in, but no Blast Account: nothing to show and nothing read.
    await refused(await get({ authorization: bearer("did:privy:no-account-yet") }), 409, "account_required");

    const response = await get({ authorization: KAI });
    assert.equal(response.headers.get("cache-control"), PRIVATE);
    assert.deepEqual(Object.keys(await ok(response)), PORTFOLIO_KEYS);

    const down = await getWithDatabaseDown({ authorization: KAI });
    await refused(down.clone(), 503, "service_unavailable");
    assert.ok(Number(down.headers.get("retry-after")) > 0);
  });
});

test("T-019-AC-3 (AC-112, AC-117): balances sum across wallets; a 121 s old price gives no USD; an incomplete wallet snapshot makes balances unavailable", { skip }, async () => {
  await withFixture(async ({ admin, get }) => {
    const kai = await ok(await get({ authorization: KAI }));
    assert.deepEqual(kai.balances, {
      // 1.5 + 2 SUI at $3.50.
      sui: { atoms: "3500000000", usd: "12.25" },
      // 10 + 5.5 USDC; the USDC price is 121 s old.
      usdc: { atoms: "15500000", usd: null },
    });
    assert.equal(kai.prices_as_of_ms, NOW - 10_000);
    assert.deepEqual(kai.unavailable, []);

    // Exactly 120 s old is still fresh.
    await admin.query("UPDATE blast_infra_fixture.prices SET as_of_ms = $1 WHERE coin_type = $2", [NOW - 120_000, USDC]);
    const fresh = await ok(await get({ authorization: KAI }));
    // 15.5 USDC at $0.9998 = 15.4969 → 15.50.
    assert.deepEqual(fresh.balances?.usdc, { atoms: "15500000", usd: "15.50" });
    assert.equal(fresh.prices_as_of_ms, NOW - 120_000);

    // No price row at all: atoms, no USD, no as-of.
    await admin.query("DELETE FROM blast_infra_fixture.prices");
    const unpriced = await ok(await get({ authorization: KAI }));
    assert.deepEqual(unpriced.balances, { sui: { atoms: "3500000000", usd: null }, usdc: { atoms: "15500000", usd: null } });
    assert.equal(unpriced.prices_as_of_ms, null);

    for (const mode of ["syncing", "stale"] as const) {
      await admin.query("UPDATE blast_infra_fixture.wallet_sync SET status=$1 WHERE owner=$2", [mode,W.kai]);
      const failed = await ok(await get({ authorization: KAI }));
      assert.equal(failed.balances, null, mode);
      assert.equal(failed.prices_as_of_ms, null, mode);
      assert.deepEqual(failed.unavailable, ["balances"], mode);
      // The other parts are still there, never zeroed.
      assert.equal(failed.positions?.length, 6, mode);
      assert.deepEqual(failed.totals, kai.totals, mode);
    }
  });
});

test("T-019-AC-4 (AC-113): open, ended, migrated-unclaimed, cancelled-unclaimed and claimed presales are open, closed, claimable, claimable and delivered", { skip }, async () => {
  await withFixture(async ({ get }) => {
    const kai = await ok(await get({ authorization: KAI }));
    assert.deepEqual(
      kai.positions?.map((p) => [p.symbol, p.status, p.commitment, p.claimed_tokens, p.claimed_quote_refund]),
      [
        // Newest commit first; both wallets' commitments summed.
        ["OPEN", "open", "50000000", null, null],
        ["DONE", "closed", "7000000", null, null],
        ["FUND", "closed", "11000000", null, null],
        ["MIGR", "claimable", "40000000", null, null],
        ["CANC", "claimable", "9000000", null, null],
        ["AGED", "delivered", "25000000", "250000000000", "5000000"],
      ],
    );
    assert.ok(kai.positions?.every((p) => p.quote_symbol === "USDC" && p.quote_decimals === 6 && p.sale_decimals === 9));
  });
});

test("T-019-AC-5 (AC-104): totals count distinct non-voided actors over all the owner's items and sum their known USD", { skip }, async () => {
  await withFixture(async ({ admin, story, get }) => {
    const insert = `INSERT INTO social_attributions
        (tx_digest, entry_id, author_account_id, actor_account_id, action, presale_id, quote_amount, usd_value, occurred_at_ms)
      VALUES ($1, $2, $3, $4, 'commit', $5, '1000000', $6, $7)`;
    // The story: Nova ($100) and Mallory ($50) acted through Kai's why commit.
    // A second item of Kai's: Nova again (no USD), Ghost ($7.25).
    await admin.query(insert, ["FsAttr3".padEnd(44, "1"), story.ids.kaiTieHigh, FEED_STORY_ACCOUNTS.kai, FEED_STORY_ACCOUNTS.nova, P.open, null, NOW - 60_000]);
    await admin.query(insert, ["FsAttr4".padEnd(44, "1"), story.ids.kaiTieHigh, FEED_STORY_ACCOUNTS.kai, FEED_STORY_ACCOUNTS.ghost, P.open, "7.25", NOW - 50_000]);
    // Kai acting through Nova's item counts for Nova, not Kai.
    await admin.query(insert, ["FsAttr5".padEnd(44, "1"), story.ids.novaPlainCommit, FEED_STORY_ACCOUNTS.nova, FEED_STORY_ACCOUNTS.kai, P.open, "30", NOW - 40_000]);
    assert.deepEqual((await ok(await get({ authorization: KAI }))).totals, { people: 3, volume_usd: "157.25" });

    // Void Mallory's and Ghost's: one person (Nova) and only her known USD remain.
    await admin.query(
      "UPDATE social_attributions SET voided_at = now(), void_reason = 'reorg' WHERE tx_digest = ANY($1::text[])",
      [["FsAttr2".padEnd(44, "1"), "FsAttr4".padEnd(44, "1")]],
    );
    assert.deepEqual((await ok(await get({ authorization: KAI }))).totals, { people: 1, volume_usd: "100.00" });
    assert.deepEqual((await ok(await get({ authorization: NOVA }))).totals, { people: 1, volume_usd: "30.00" });
  });
});

const MIGR_COIN = `${P.migratedRecently}::coin::MIGR`;
const AGED_COIN = `${P.migratedLongAgo}::coin::AGED`;
const OPEN_COIN = `${P.open}::coin::OPEN`;

/** Sale coins: Kai holds MIGR in both wallets and AGED in one (a stale price), and no OPEN (a zero row). */
async function seedHoldings(admin: Pool): Promise<void> {
  await seedChainRead(admin, {
    coin_balances: [
      { coin_type: MIGR_COIN, owner: W.kai, balance: "1500000000", updated_checkpoint: 30_100 },
      { coin_type: MIGR_COIN, owner: KAI_SECOND_WALLET, balance: "2500000000", updated_checkpoint: 30_101 },
      { coin_type: AGED_COIN, owner: KAI_SECOND_WALLET, balance: "250000000000", updated_checkpoint: 30_102 },
      { coin_type: OPEN_COIN, owner: W.kai, balance: "0", updated_checkpoint: 30_103 },
      { coin_type: MIGR_COIN, owner: W.nova, balance: "7000000000", updated_checkpoint: 30_104 },
      { coin_type: MIGR_COIN, owner: W.anon, balance: "999000000000", updated_checkpoint: 30_105 },
      // Not a presale's sale coin.
      // A nonzero holding without metadata or a USD price is unknown, not zero dollars.
      { coin_type: `${hex("0ff")}::other::OTHER`, owner: W.kai, balance: "5", updated_checkpoint: 30_106 },
    ],
    prices: [
      { coin_type: MIGR_COIN, usd_price: "0.21", as_of_ms: NOW - 5_000, source: "pool" },
      // 121 s old at NOW: no USD.
      { coin_type: AGED_COIN, usd_price: "0.03", as_of_ms: NOW - 121_000, source: "pool" },
    ],
    vesting_schedules: [
      {
        schedule_id: hex("7e5701"), presale_id: P.migratedRecently, beneficiary: KAI_SECOND_WALLET, total: "100000000000",
        claimed: "0", start_ms: NOW - 3 * DAY, cliff_ms: "0", end_ms: String(NOW + 177 * DAY),
      },
    ],
  });
}

test("T-020-AC-1 (AC-114): sale coins across two wallets are listed once each, balances summed, with USD at a fresh price; a zero balance is absent", { skip }, async () => {
  await withFixture(async ({ admin, get }) => {
    await seedHoldings(admin);
    const kai = await ok(await get({ authorization: KAI }));
    assert.deepEqual(kai.coins, [
      // 1.5 + 2.5 MIGR at $0.21. R3-32: the story's claim of MIGR has no commitment behind it, so its cost is
      // unknown; of the 1,150 MIGR the ledger saw arrive (a $12.50 buy too) 4 are held, at the known part's average.
      { coin_type: MIGR_COIN, symbol: "MIGR", name: "Migr", decimals: 9, icon_url: "https://i.blast.test/migr.png", presale_id: P.migratedRecently, balance: "4000000000", value_usd: "0.84", value_usd_exact: "0.84", basis_usd: "0.04", basis_complete: false, pnl_usd: null, pnl_multiple: null },
      { coin_type: `${hex("0ff")}::other::OTHER`, symbol: "OTHER", name: null, decimals: null, icon_url: null, presale_id: null, balance: "5", value_usd: null, value_usd_exact: null, ...UNKNOWN_BASIS },
      // The AGED price is 121 s old: atoms, no USD. Held with no acquisition at all: an unknown basis.
      { coin_type: AGED_COIN, symbol: "AGED", name: "Aged", decimals: 9, icon_url: "https://i.blast.test/aged.png", presale_id: P.migratedLongAgo, balance: "250000000000", value_usd: null, value_usd_exact: null, ...UNKNOWN_BASIS },
    ]);
    assert.ok(!kai.unavailable.includes("coins"));
    // The coin prices join the oldest price shown (SUI's, 10 s, is older than MIGR's 5 s).
    assert.equal(kai.prices_as_of_ms, NOW - 10_000);
    await admin.query("UPDATE blast_infra_fixture.prices SET as_of_ms = $1 WHERE coin_type = $2", [NOW - 60_000, MIGR_COIN]);
    assert.equal((await ok(await get({ authorization: KAI }))).prices_as_of_ms, NOW - 60_000);

    // Nova sees only her own MIGR; nobody sees the unowned wallet's.
    const nova = await ok(await get({ authorization: NOVA }));
    assert.deepEqual(nova.coins, [{ coin_type: MIGR_COIN, symbol: "MIGR", name: "Migr", decimals: 9, icon_url: "https://i.blast.test/migr.png", presale_id: P.migratedRecently, balance: "7000000000", value_usd: "1.47", value_usd_exact: "1.47", ...UNKNOWN_BASIS }]);
    for (const body of [kai, nova]) assert.ok(!JSON.stringify(body).includes("999000000000"));

    // The coins view failing (absent here) makes coins unavailable on its own.
    await admin.query("ALTER VIEW chain_read_v1.wallet_balances RENAME TO wallet_balances_gone");
    const failed = await ok(await get({ authorization: KAI }));
    assert.equal(failed.coins, null);
    assert.deepEqual(failed.unavailable, ["balances", "coins"]);
    assert.equal(failed.positions?.length, 6);
    assert.deepEqual(failed.vesting, { has_schedule: true, href: null });
    await admin.query("ALTER VIEW chain_read_v1.wallet_balances_gone RENAME TO wallet_balances");
  });
});

test("T-020-AC-2 (AC-115): a schedule for one wallet gives has_schedule and the link; with the view absent or failing, vesting is null and listed", { skip }, async () => {
  await withFixture(async ({ admin, get }) => {
    await seedHoldings(admin);
    const kai = await ok(await get({ authorization: KAI }));
    assert.deepEqual(kai.vesting, { has_schedule: true, href: null });
    // Nova is nobody's beneficiary.
    assert.deepEqual((await ok(await get({ authorization: NOVA }))).vesting, { has_schedule: false, href: null });

    // blast-infra has not published the view (S-4): vesting is unavailable on its own.
    await admin.query("ALTER VIEW chain_read_v1.vesting_schedules RENAME TO vesting_schedules_gone");
    const absent = await ok(await get({ authorization: KAI }));
    assert.equal(absent.vesting, null);
    assert.deepEqual(absent.unavailable, ["vesting"]);
    assert.equal(absent.coins?.length, 3);
    assert.equal(absent.positions?.length, 6);
    await admin.query("ALTER VIEW chain_read_v1.vesting_schedules_gone RENAME TO vesting_schedules");

    // The view failing at read time (here: its rows cannot be read as the web role).
    await admin.query("REVOKE SELECT ON chain_read_v1.vesting_schedules FROM blast_web");
    const failing = await ok(await get({ authorization: KAI }));
    assert.equal(failing.vesting, null);
    assert.deepEqual(failing.unavailable, ["vesting"]);
    await admin.query("GRANT SELECT ON chain_read_v1.vesting_schedules TO blast_web");
    assert.deepEqual((await ok(await get({ authorization: KAI }))).vesting, { has_schedule: true, href: null });
  });
});

test("R3-24-AC-11 (OA-21): the vesting entry links to the paying sale's website once it has one, and to nothing before", { skip }, async () => {
  await withFixture(async ({ admin, get }) => {
    await seedHoldings(admin);
    const metadata = (presaleId: string, site: string) => admin.query(
      `INSERT INTO social_sale_metadata (presale_id, site, updated_by_operator, updated_at_ms) VALUES ($1, $2, 'fixture', 1)
       ON CONFLICT (presale_id) DO UPDATE SET site = EXCLUDED.site`,
      [presaleId, site],
    );
    // Another sale's website is not Kai's link: only the sale paying his schedule counts.
    await metadata(P.open, "https://other.example");
    assert.deepEqual((await ok(await get({ authorization: KAI }))).vesting, { has_schedule: true, href: null });
    await metadata(P.migratedRecently, "https://meridian.finance");
    assert.deepEqual((await ok(await get({ authorization: KAI }))).vesting, { has_schedule: true, href: "https://meridian.finance" });
    // Nova is nobody's beneficiary: no entry link, whatever the sales store.
    assert.deepEqual((await ok(await get({ authorization: NOVA }))).vesting, { has_schedule: false, href: null });
    // The site cleared: the entry is back to no link.
    await admin.query("UPDATE social_sale_metadata SET site = NULL WHERE presale_id = $1", [P.migratedRecently]);
    assert.deepEqual((await ok(await get({ authorization: KAI }))).vesting, { has_schedule: true, href: null });
  });
});

/*
 * R3-32: the cost basis behind every P&L. Nova's ledger (the story gives her
 * commits to the open and funded sales and a refund-only claim of the
 * cancelled one) gains five migrated sales of her own, each one state, all
 * priced in the fixture's `chain_read_v1.activity` exactly as blast-infra
 * writes it (commits and claims by the presale pipeline, trades by the
 * market pipeline with the sale's `presale_id`).
 */
const ONLY_CLAIM = hex("b1");
const TRADED = hex("b2");
const GIFTED = hex("b3");
const UNPRICED = hex("b4");
const FREE = hex("b5");
/** T-043: a hidden test sale (no `presales` row), whose activity and coin are still in the views. */
const HIDDEN = hex("b6");
const coinOf = (presaleId: string) => `${presaleId}::coin::C${presaleId.slice(-2)}`;
let ledgerCheckpoint = 70_000;

function ledgerRow(kind: string, presaleId: string, extra: Partial<ChainActivityRow>): ChainActivityRow {
  ledgerCheckpoint += 1;
  const trade = kind.startsWith("trade_");
  return {
    // A trade's `event_slot` is u32::MAX in blast-infra (its transaction's balance slot); the fixture's column is int4.
    checkpoint: ledgerCheckpoint, tx_slot: 0, event_slot: trade ? 1 : 0, part: 0,
    timestamp_ms: NOW - DAY + (ledgerCheckpoint - 70_000) * 60_000, digest: `Cb${ledgerCheckpoint}`.padEnd(44, "1"),
    kind, product: trade ? "market" : "presale", actor: W.nova, tx_sender: W.nova, presale_id: presaleId, coin_type: coinOf(presaleId),
    quote_type: USDC, quote_amount: "0", coin_amount: null, quote_refund: null, usd_value: null, usd_price_as_of_ms: null,
    venue: trade ? "cetus" : null, participants_after: null, total_commitments_after: null, ...extra,
  };
}
const priced = (usd: string) => ({ usd_value: usd, usd_price_as_of_ms: NOW - DAY });
const commitRow = (presaleId: string, quote: string, usd: string) => ledgerRow("presale_commit", presaleId, { quote_amount: quote, ...priced(usd) });
const claimRow = (presaleId: string, tokens: string, refund: string) => ledgerRow("presale_claim", presaleId, { coin_amount: tokens, quote_refund: refund });
const tradeRow = (side: "buy" | "sell", presaleId: string, tokens: string, usd: string) =>
  ledgerRow(`trade_${side}`, presaleId, { coin_amount: tokens, quote_amount: String(BigInt(usd.split(".")[0]!) * 1_000_000n + 1n), ...priced(usd) });
const holdingRow = (presaleId: string, balance: string) => ({ coin_type: coinOf(presaleId), owner: W.nova, balance, updated_checkpoint: ledgerCheckpoint });

async function setBalance(admin: Pool, presaleId: string, balance: string): Promise<void> {
  await admin.query(
    `INSERT INTO blast_infra_fixture.coin_balances (coin_type, owner, balance, updated_checkpoint) VALUES ($1, $2, $3, $4)
     ON CONFLICT (coin_type, owner) DO UPDATE SET balance = EXCLUDED.balance, updated_checkpoint = EXCLUDED.updated_checkpoint`,
    [coinOf(presaleId), W.nova, balance, ledgerCheckpoint],
  );
}

async function seedBasis(admin: Pool): Promise<void> {
  const migrated = (id: string) => ({ ...presale(id, `C${id.slice(-2).toUpperCase()}`, "migrated", NOW - 5 * DAY), sale_token: coinOf(id) });
  const claimed = (id: string, commitment: string, tokens: string) => ({
    ...position(id, W.nova, commitment, 3 * 24 * 60, { tokens, refund: "0" }),
  });
  await seedChainRead(admin, {
    presales: [migrated(ONLY_CLAIM), migrated(TRADED), migrated(GIFTED), migrated(UNPRICED), migrated(FREE)],
    presale_positions: [claimed(ONLY_CLAIM, "1000000000", "1000000000000000"), claimed(TRADED, "100000000", "1000000000000")],
    activity: [
      // AC-1: $1,000 of USDC worth $999.80 at event time, all of it filled: 1,000,000 tokens.
      commitRow(ONLY_CLAIM, "600000000", "599.88"), commitRow(ONLY_CLAIM, "400000000", "399.92"),
      claimRow(ONLY_CLAIM, "1000000000000000", "0"),
      // AC-2's first step: 1,000 tokens claimed for $100.
      commitRow(TRADED, "100000000", "100"), claimRow(TRADED, "1000000000000", "0"),
      tradeRow("buy", UNPRICED, "1000000000000", "300"),
      tradeRow("buy", FREE, "1000000000000", "0"),
      // T-043: a hidden sale's trade is in the log; it is never a basis.
      tradeRow("buy", HIDDEN, "5000000000000", "900"),
    ],
    coin_balances: [
      holdingRow(ONLY_CLAIM, "1000000000000000"), holdingRow(TRADED, "1000000000000"), holdingRow(GIFTED, "5000000000"),
      holdingRow(UNPRICED, "1000000000000"), holdingRow(FREE, "1000000000000"), holdingRow(HIDDEN, "5000000000000"),
    ],
    prices: [
      { coin_type: coinOf(ONLY_CLAIM), usd_price: "0.0042", as_of_ms: NOW - 5_000, source: "pool" },
      { coin_type: coinOf(TRADED), usd_price: "0.5", as_of_ms: NOW - 5_000, source: "pool" },
      { coin_type: coinOf(GIFTED), usd_price: "2", as_of_ms: NOW - 5_000, source: "pool" },
      { coin_type: coinOf(FREE), usd_price: "0.5", as_of_ms: NOW - 5_000, source: "pool" },
      { coin_type: coinOf(HIDDEN), usd_price: "1", as_of_ms: NOW - 5_000, source: "pool" },
    ],
  });
}

const coinRow = (body: SocialPortfolio, presaleId: string) => body.coins?.find((coin) => coin.coin_type === coinOf(presaleId));
const positionRow = (body: SocialPortfolio, presaleId: string) => body.positions?.find((row) => row.presale_id === presaleId);
const basisOf = (row: { basis_usd: string | null; basis_complete: boolean; pnl_usd: string | null; pnl_multiple: string | null } | undefined) =>
  row && { basis_usd: row.basis_usd, basis_complete: row.basis_complete, pnl_usd: row.pnl_usd, pnl_multiple: row.pnl_multiple };

test("summary selection preserves the full wallet history bound and truncation", { skip }, async () => {
  await withFixture(async ({ admin, url }) => {
    await seedBasis(admin);
    const pool = createRuntimePool(urlAs(url, "blast_web"), POOL, "summary-ledger-bound");
    try {
      const db = autocommitReader(pool, "social");
      // FREE has just one event, after several unrelated events. Its summary
      // must not look beyond the full ledger's cap to manufacture complete basis.
      const full = await readCostBasisLedger(db, [W.nova], 3);
      const scoped = await readCostBasisLedger(db, [W.nova], 3, [FREE]);
      assert.equal(full.truncated, true);
      assert.equal(scoped.truncated, full.truncated);
      assert.deepEqual(scoped.rows, full.rows.filter((row) => row.presale_id === FREE));
      const complete = await readCostBasisLedger(db, [W.nova], 100, [FREE]);
      assert.equal(complete.truncated, false);
      assert.equal(complete.rows.length, 1);
      assert.equal(complete.rows[0]?.presale_id, FREE);
      assert.deepEqual(await readCostBasisLedger({ async read() { throw new Error("No positions must skip history entirely"); } }, [W.nova], 3, []), { rows: [], truncated: false });
    } finally {
      await pool.end();
    }
  });
});

test("R3-32-AC-1: a claim alone is based on the commitment's USD at event time, and the multiple is value ÷ basis", { skip }, async () => {
  await withFixture(async ({ admin, get }) => {
    await seedBasis(admin);
    const nova = await ok(await get({ authorization: NOVA }));
    // 1,000,000 at $0.0042 = $4,200 over $999.80: +$3,200.20, 4.20084…×. The position carries its coin's figures.
    const expected = { basis_usd: "999.80", basis_complete: true, pnl_usd: "3200.20", pnl_multiple: "4.2008" };
    assert.deepEqual(basisOf(coinRow(nova, ONLY_CLAIM)), expected);
    assert.equal(coinRow(nova, ONLY_CLAIM)?.value_usd, "4200.00");
    assert.deepEqual(basisOf(positionRow(nova, ONLY_CLAIM)), expected);
    // Hidden sale details stay hidden, but a coin in the wallet remains visible.
    assert.deepEqual(basisOf(positionRow(nova, P.open)), NO_COST_BASIS);
    assert.equal(coinRow(nova, HIDDEN)?.presale_id, null);
    assert.equal(coinRow(nova, HIDDEN)?.balance, "5000000000000");
    assert.equal(coinRow(nova, HIDDEN)?.basis_complete, false);
  });
});

test("R3-32-AC-2, AC-3: buys average, sells take their share at the average, and a full sell leaves `–` (read after every step)", { skip }, async () => {
  await withFixture(async ({ admin, get }) => {
    await seedBasis(admin);
    // [rows added, balance after, coin figures at $0.50] — worked by hand: average cost, sells at the average.
    const steps: ReadonlyArray<readonly [ChainActivityRow[], string, Record<string, unknown>]> = [
      // Claimed 1,000 for $100: worth $500.
      [[], "1000000000000", { basis_usd: "100.00", basis_complete: true, pnl_usd: "400.00", pnl_multiple: "5.0000" }],
      // Bought 1,000 for $300: 2,000 for $400, $0.20 each.
      [[tradeRow("buy", TRADED, "1000000000000", "300")], "2000000000000", { basis_usd: "400.00", basis_complete: true, pnl_usd: "600.00", pnl_multiple: "2.5000" }],
      // Bought 500 for $250: 2,500 for $650, $0.26 each.
      [[tradeRow("buy", TRADED, "500000000000", "250")], "2500000000000", { basis_usd: "650.00", basis_complete: true, pnl_usd: "600.00", pnl_multiple: "1.9231" }],
      // Sold 1,000 for $500: they cost 1,000 × $0.26 = $260; 1,500 left for $390, still $0.26 each.
      [[tradeRow("sell", TRADED, "1000000000000", "500")], "1500000000000", { basis_usd: "390.00", basis_complete: true, pnl_usd: "360.00", pnl_multiple: "1.9231" }],
    ];
    for (const [rows, balance, expected] of steps) {
      await seedChainRead(admin, { activity: rows });
      await setBalance(admin, TRADED, balance);
      const nova = await ok(await get({ authorization: NOVA }));
      assert.deepEqual(basisOf(coinRow(nova, TRADED)), expected, balance);
      assert.deepEqual(basisOf(positionRow(nova, TRADED)), expected, balance);
    }
    // Sold the last 1,500: nothing held, a zero basis, and no P&L or multiple (never infinity or zero).
    await seedChainRead(admin, { activity: [tradeRow("sell", TRADED, "1500000000000", "800")] });
    await setBalance(admin, TRADED, "0");
    const sold = await ok(await get({ authorization: NOVA }));
    assert.equal(coinRow(sold, TRADED), undefined);
    assert.deepEqual(basisOf(positionRow(sold, TRADED)), { basis_usd: "0.00", basis_complete: true, pnl_usd: null, pnl_multiple: null });
  });
});

test("R3-32-AC-4 and the other states: a transfer in, a coin with no price, a zero basis, and an unreadable ledger", { skip }, async () => {
  await withFixture(async ({ admin, get }) => {
    await seedBasis(admin);
    const nova = await ok(await get({ authorization: NOVA }));
    // 5 GFT held with no priced acquisition: incomplete, no multiple, though its value is known.
    assert.equal(coinRow(nova, GIFTED)?.value_usd, "10.00");
    assert.deepEqual(basisOf(coinRow(nova, GIFTED)), UNKNOWN_BASIS);
    // Half again of what TRADED's ledger accounts for arrives by transfer: the known $100 stays, flagged.
    await setBalance(admin, TRADED, "1500000000000");
    assert.deepEqual(basisOf(coinRow(await ok(await get({ authorization: NOVA })), TRADED)), {
      basis_usd: "100.00", basis_complete: false, pnl_usd: null, pnl_multiple: null,
    });
    // Bought for $300, no price row: the basis, and no P&L.
    assert.deepEqual(basisOf(coinRow(nova, UNPRICED)), { basis_usd: "300.00", basis_complete: true, pnl_usd: null, pnl_multiple: null });
    // Bought at $0: a known zero basis, so no P&L and no multiple.
    assert.deepEqual(basisOf(coinRow(nova, FREE)), { basis_usd: "0.00", basis_complete: true, pnl_usd: null, pnl_multiple: null });

    // The activity view failing: every basis is unknown, and the portfolio still answers every part.
    await admin.query("ALTER VIEW chain_read_v1.activity RENAME TO activity_gone");
    const failed = await ok(await get({ authorization: NOVA }));
    assert.deepEqual(failed.unavailable, []);
    assert.ok(failed.coins!.length > 0 && failed.coins!.every((coin) => JSON.stringify(basisOf(coin)) === JSON.stringify(UNKNOWN_BASIS)));
    assert.ok(failed.positions!.every((row) => JSON.stringify(basisOf(row)) === JSON.stringify(UNKNOWN_BASIS)));
    await admin.query("ALTER VIEW chain_read_v1.activity_gone RENAME TO activity");
  });
});

/** The account's day `daysAgo` before today (UTC), as the daily snapshot writes it: valued at `value_usd`, or skipped. */
async function snapshotRow(admin: Pool, accountId: string, daysAgo: number, value_usd: string | null): Promise<void> {
  const day = new Date((Math.floor(NOW / DAY) - daysAgo) * DAY).toISOString().slice(0, 10);
  const takenAt = Date.parse(`${day}T00:05:00.000Z`);
  await admin.query(
    `INSERT INTO social_portfolio_snapshots (account_id, day, value_usd, committed_usd, claimable_usd, tokens_usd, usdc_usd, sui_usd,
       skipped, taken_at_ms, checkpoint, prices_as_of_ms)
     SELECT $1::uuid, $2::date, v.value, v.value, v.zero, v.zero, v.zero, v.zero, CASE WHEN v.value IS NULL THEN 'price_missing' END, $4::bigint, 1,
       CASE WHEN v.value IS NULL THEN NULL ELSE $4::bigint - 1000 END
     FROM (SELECT $3::numeric AS value, CASE WHEN $3::numeric IS NULL THEN NULL ELSE 0 END AS zero) v`,
    [accountId, day, value_usd, takenAt],
  );
}

test("OA-25 Q16: the portfolio's trend is the account's daily snapshots: empty until a month exists, then 30 days and the exact change", { skip }, async () => {
  await withFixture(async ({ admin, get }) => {
    const empty = { days: 30, points: [], change_bps: null };
    assert.deepEqual((await ok(await get({ authorization: KAI }))).trend, empty);
    // 30 valued days, today back to 29 days ago: not a month yet (no day 30 days before the newest).
    for (let daysAgo = 0; daysAgo < 30; daysAgo += 1) await snapshotRow(admin, FEED_STORY_ACCOUNTS.kai, daysAgo, `${1000 + (29 - daysAgo) * 6}.00`);
    assert.deepEqual((await ok(await get({ authorization: KAI }))).trend, empty);
    // The 31st day back: the line, oldest first, and the change from $1,000.00 to $1,174.00 (+17.40%).
    await snapshotRow(admin, FEED_STORY_ACCOUNTS.kai, 30, "1000.00");
    const kai = await ok(await get({ authorization: KAI }));
    assert.equal(kai.trend?.points.length, 31);
    assert.deepEqual([kai.trend?.points[0]?.value_usd, kai.trend?.points.at(-1)?.value_usd, kai.trend?.change_bps], ["1000.00", "1174.00", "1740"]);
    assert.deepEqual(kai.unavailable, []);
    // Another account's snapshots are never in it, and Nova's own (fewer than a month) give her no line.
    await snapshotRow(admin, FEED_STORY_ACCOUNTS.nova, 0, "5.00");
    await snapshotRow(admin, FEED_STORY_ACCOUNTS.nova, 30, "1.00");
    assert.deepEqual((await ok(await get({ authorization: KAI }))).trend, kai.trend);
    assert.deepEqual((await ok(await get({ authorization: NOVA }))).trend, { days: 30, points: [{ day: kai.trend!.points[0]!.day, value_usd: "1.00" }, { day: kai.trend!.points[30]!.day, value_usd: "5.00" }], change_bps: "40000" });
    // Today skipped (a missing price): yesterday's line, never today's holdings at an old price.
    await admin.query("DELETE FROM social_portfolio_snapshots WHERE account_id = $1 AND day = $2::date", [FEED_STORY_ACCOUNTS.kai, kai.trend!.points[30]!.day]);
    await snapshotRow(admin, FEED_STORY_ACCOUNTS.kai, 0, null);
    await snapshotRow(admin, FEED_STORY_ACCOUNTS.kai, 31, "900.00");
    const yesterday = await ok(await get({ authorization: KAI }));
    assert.deepEqual([yesterday.trend?.points.length, yesterday.trend?.points[0]?.value_usd, yesterday.trend?.points.at(-1)?.value_usd], [31, "900.00", "1168.00"]);
    // The snapshots unreadable (a grant revoked): the trend is unavailable on its own, never an empty line.
    await admin.query("REVOKE SELECT ON social_portfolio_snapshots FROM blast_web");
    const unreadable = await ok(await get({ authorization: KAI }));
    assert.deepEqual([unreadable.trend, unreadable.unavailable], [null, ["trend"]]);
    assert.equal(unreadable.positions?.length, 6);
    await admin.query("GRANT SELECT ON social_portfolio_snapshots TO blast_web");
  });
});

test("OA-25 Q16: the trend read pages an account's 400 days newest first by keyset, as blast_web and blast_replica, index-only", { skip }, async () => {
  await withFixture(async ({ admin, url }) => {
    // 400 days for Kai, every 7th skipped; a year for Nova in the same key range.
    await admin.query(
      `INSERT INTO social_portfolio_snapshots (account_id, day, value_usd, committed_usd, claimable_usd, tokens_usd, usdc_usd, sui_usd, skipped, taken_at_ms, checkpoint)
       SELECT a.account_id, d.day, v.value, v.value, v.zero, v.zero, v.zero, v.zero, CASE WHEN v.value IS NULL THEN 'price_missing' END,
         (extract(epoch FROM d.day) * 1000)::bigint + 300000, 1
       FROM (VALUES ($1::uuid, 400), ($2::uuid, 365)) AS a(account_id, days)
       CROSS JOIN LATERAL generate_series(0, a.days - 1) AS g(n)
       CROSS JOIN LATERAL (SELECT (to_timestamp($3::bigint / 1000.0) AT TIME ZONE 'UTC')::date - g.n AS day) d
       CROSS JOIN LATERAL (SELECT CASE WHEN g.n % 7 = 3 THEN NULL ELSE (1000 + g.n)::numeric(20, 2) END AS value,
         CASE WHEN g.n % 7 = 3 THEN NULL ELSE 0 END AS zero) v`,
      [FEED_STORY_ACCOUNTS.kai, FEED_STORY_ACCOUNTS.nova, NOW],
    );
    await admin.query("VACUUM ANALYZE social_portfolio_snapshots");
    const expected = (await admin.query<{ day: string; value_usd: string }>(
      "SELECT day::text AS day, value_usd::text AS value_usd FROM social_portfolio_snapshots WHERE account_id = $1 AND value_usd IS NOT NULL ORDER BY day DESC",
      [FEED_STORY_ACCOUNTS.kai],
    )).rows;
    assert.equal(expected.length, 400 - 57);
    const tomorrow = new Date((Math.floor(NOW / DAY) + 1) * DAY).toISOString().slice(0, 10);
    for (const role of ["blast_web", "blast_replica"] as const) {
      const pool = createRuntimePool(urlAs(url, role), POOL, `snapshot-paging-${role}`);
      try {
        const db = autocommitReader(pool, "social", { prepare: true });
        const walked: Array<{ day: string; value_usd: string }> = [];
        let before = tomorrow;
        for (;;) {
          const page = await readPortfolioSnapshots(db, FEED_STORY_ACCOUNTS.kai, { before, since: null, limit: 50 });
          walked.push(...page);
          if (page.length < 50) break;
          before = page.at(-1)!.day;
        }
        assert.deepEqual(walked, expected, role);
        // A bounded window: `since` is inclusive, `before` exclusive.
        const window = await readPortfolioSnapshots(db, FEED_STORY_ACCOUNTS.kai, { before: expected[0]!.day, since: expected[9]!.day, limit: 50 });
        assert.deepEqual(window, expected.slice(1, 10), role);
      } finally {
        await pool.end();
      }
    }
    // One range of the key, answered from the index alone (sequential scans off, so a small table still shows the access path;
    // the launch-scale plan is `loadtest/social-portfolio-snapshot-scale.ts`'s).
    const client = await admin.connect();
    let plan: string;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL enable_seqscan = off");
      plan = (await client.query<{ "QUERY PLAN": string }>(`EXPLAIN ${PORTFOLIO_TREND_STATEMENTS.snapshots}`, [FEED_STORY_ACCOUNTS.kai, tomorrow, "-infinity", 32]))
        .rows.map((row) => row["QUERY PLAN"]).join("\n");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    assert.match(plan, /Index Only Scan Backward using social_portfolio_snapshots_pkey/);
    assert.doesNotMatch(plan, /Seq Scan|Sort/);
  });
});


test("claimable dollars use only remaining tokens and refunds across partially claimed wallets", { skip }, () =>
  withFixture(async ({ admin, get }) => {
    const saleToken = (await admin.query("SELECT sale_token FROM chain_read_v1.presales WHERE presale_id = $1", [P.migratedRecently])).rows[0].sale_token;
    await admin.query("UPDATE blast_infra_fixture.presale_positions SET claimable_tokens = 12500000000, claimable_quote_refund = 5000000 WHERE presale_id = $1 AND wallet = $2", [P.migratedRecently, W.kai]);
    await admin.query("UPDATE blast_infra_fixture.presale_positions SET claimable_tokens = 0, claimable_quote_refund = commitment WHERE presale_id = $1", [P.cancelled]);
    await seedChainRead(admin, {
      presale_positions: [{ ...position(P.migratedRecently, KAI_SECOND_WALLET, "80000000", 10, { tokens: "42000000000", refund: "0" }), claimable_tokens: "0", claimable_quote_refund: "0" }],
      prices: [{ coin_type: saleToken, usd_price: "2", as_of_ms: NOW - 1_000, source: "pool" }],
      coin_balances: [{ coin_type: saleToken, owner: KAI_SECOND_WALLET, balance: "42000000000", updated_checkpoint: 20_000 }],
    });
    const body = await ok(await get({ authorization: KAI }));
    assert.deepEqual(body.commitments, { committed_usd: "68.00", claimable_usd: "39.00" });
    assert.equal(body.coins?.find((coin) => coin.coin_type === saleToken)?.value_usd, "84.00");
    assert.ok(body.positions?.every((row) => !("claimable" in row))); // Internal pricing inputs stay out of the response contract.
    await admin.query("UPDATE blast_infra_fixture.presale_positions SET claimable_tokens = NULL WHERE presale_id = $1 AND wallet = $2", [P.migratedRecently, W.kai]);
    assert.equal((await ok(await get({ authorization: KAI }))).commitments?.claimable_usd, null);
  }),
);

test("older infra views leave claimable dollars unknown while the rest of the portfolio still loads", { skip }, () =>
  withFixture(async ({ admin, get }) => {
    await admin.query("ALTER VIEW chain_read_v1.presale_positions RENAME TO presale_positions_new");
    await admin.query(`CREATE VIEW chain_read_v1.presale_positions AS SELECT presale_id, wallet, commitment, last_commit_ms,
      claim_digest, claimed_tokens, claimed_quote_refund, claimed_ms FROM blast_infra_fixture.presale_positions`);
    await admin.query("GRANT SELECT ON chain_read_v1.presale_positions TO blast_web");
    const body = await ok(await get({ authorization: KAI }));
    assert.deepEqual(body.commitments, { committed_usd: "68.00", claimable_usd: null, known_claimable_usd: "0.00" });
    assert.equal(body.positions?.length, 6);
  }),
);

test("USDsui commitments and refunds count at par even when the indexed price expires", { skip }, () =>
  withFixture(async ({ admin, get }) => {
    await admin.query("UPDATE blast_infra_fixture.presales SET quote_type=$1,quote_symbol='USDSUI' WHERE presale_id = ANY($2::text[])", [CREATE_USDSUI_QUOTE_TYPE, [P.open, P.cancelled]]);
    await admin.query("UPDATE blast_infra_fixture.presale_positions SET claimable_tokens=0,claimable_quote_refund=5000000 WHERE presale_id=$1", [P.migratedRecently]);
    await admin.query("UPDATE blast_infra_fixture.presale_positions SET claimable_tokens=0,claimable_quote_refund=commitment WHERE presale_id=$1", [P.cancelled]);
    await seedChainRead(admin, {
      prices: [{ coin_type: CREATE_USDSUI_QUOTE_TYPE, usd_price: "0.98", as_of_ms: NOW - 1_000, source: "pyth" }],
      coin_balances: [{ coin_type: CREATE_USDSUI_QUOTE_TYPE, owner: W.kai, balance: "400000000", updated_checkpoint: 20_000 }],
    });

    const full = await ok(await get({ authorization: KAI }));
    assert.equal(full.positions?.find((row) => row.presale_id === P.open)?.commitment, "50000000");
    assert.equal(full.coins?.find((coin) => coin.coin_type === CREATE_USDSUI_QUOTE_TYPE)?.value_usd, "392.00");
    assert.deepEqual(full.commitments, { committed_usd: "68.00", claimable_usd: "14.00" });
    assert.equal(portfolioFigures(full).total?.toFixed(2), "501.75");

    const summary = await ok(await get({ authorization: KAI }, "?view=summary"));
    assert.deepEqual(summary.commitments, { committed_usd: "68.00", claimable_usd: "14.00" });
    assert.equal(portfolioFigures(summary).total?.toFixed(2), "501.75");

    await admin.query("UPDATE blast_infra_fixture.prices SET as_of_ms=$1 WHERE coin_type=$2", [NOW - 121_000, CREATE_USDSUI_QUOTE_TYPE]);
    const stale = await ok(await get({ authorization: KAI }));
    assert.deepEqual(stale.commitments, { committed_usd: "68.00", claimable_usd: "14.00" });
  }),
);

test("mixed priced positions and claim refunds retain known subtotals in full and summary responses", { skip }, async () => {
  await withFixture(async ({ admin, get }) => {
    await admin.query("UPDATE blast_infra_fixture.presales SET quote_type=$1,quote_symbol='TSUI',quote_decimals=9 WHERE presale_id=$2", [`${hex("123")}::test_sui::TEST_SUI`, P.open]);
    await admin.query("UPDATE blast_infra_fixture.presale_positions SET claimable_tokens=1000000000,claimable_quote_refund=5000000 WHERE presale_id=$1", [P.migratedRecently]);
    await admin.query("UPDATE blast_infra_fixture.presale_positions SET claimable_tokens=0,claimable_quote_refund=commitment WHERE presale_id=$1", [P.cancelled]);
    for (const query of ["", "?view=summary"]) {
      const body = await ok(await get({ authorization: KAI }, query));
      assert.equal(isSocialPortfolio(body), true);
      assert.deepEqual(body.commitments, { committed_usd: null, claimable_usd: null, known_committed_usd: "18.00", known_claimable_usd: "14.00" });
      assert.equal(portfolioFigures(body).total, null);
      assert.deepEqual(portfolioCoverage(body), { knownUsd: 59.75 });
    }
  });
});

test("TEST_SUI aggregates linked wallets at zero dollars; unlinked funds never appear", { skip }, async () => {
  await withFixture(async ({ admin, get, getCoins }) => {
    const coin = "0x963331df9a26c8674c33eb97655fe44807d5ff1aa4092bcbe2bdbe044b17b03d::test_sui::TEST_SUI";
    await admin.query("INSERT INTO blast_infra_fixture.coin_metadata(coin_type,name,symbol,decimals) VALUES ($1,'TEST_SUI','TSUI',9)", [coin]);
    await seedChainRead(admin, { coin_balances: [
      { coin_type: coin, owner: W.kai, balance: "6000000000000000", updated_checkpoint: 80001 },
      { coin_type: coin, owner: KAI_SECOND_WALLET, balance: "4000000000000000", updated_checkpoint: 80001 },
      { coin_type: coin, owner: W.anon, balance: "999000000000000000", updated_checkpoint: 80001 },
    ] });
    const portfolio = await ok(await get({ authorization: KAI }));
    const token = portfolio.coins?.find((row) => row.coin_type === coin);
    assert.equal(token?.balance, "10000000000000000");
    assert.equal(token?.name, "TEST_SUI");
    assert.equal(token?.decimals, 9);
    assert.equal(token?.value_usd, "0.00");
    assert.equal(token?.value_usd_exact, "0");
    const page = await (await getCoins({ authorization: KAI }, "?q=TSUI")).json();
    assert.equal(page.coins[0].value_usd, "0.00");
    assert.equal(page.coins[0].value_usd_exact, "0");
    await admin.query("INSERT INTO blast_infra_fixture.coin_unavailable(coin_type,scope) VALUES ($1,'pool_price')", [coin]);
    assert.equal((await ok(await get({ authorization: KAI }))).coins?.find((row) => row.coin_type === coin)?.value_usd, "0.00");
    assert.equal((await (await getCoins({ authorization: KAI }, "?q=TSUI")).json()).coins[0].value_usd, "0.00");
    await admin.query("DELETE FROM blast_infra_fixture.coin_unavailable WHERE coin_type=$1", [coin]);
    assert.equal(token?.presale_id, null);
    assert.equal(portfolio.wallet_sync?.status, "ready");
    await admin.query("DELETE FROM social_account_wallets WHERE address=$1", [KAI_SECOND_WALLET]);
    const unlinked = await ok(await get({ authorization: KAI }));
    assert.equal(unlinked.coins?.find((row) => row.coin_type === coin)?.balance, "6000000000000000");
    await admin.query("DELETE FROM blast_infra_fixture.wallet_sync WHERE owner=$1", [W.kai]);
    const pending = await ok(await get({ authorization: KAI }));
    assert.equal(pending.wallet_sync?.status, "syncing");
    assert.equal(pending.balances, null);
    assert.equal(pending.coins?.find((row) => row.coin_type === coin)?.balance, "6000000000000000");
  });
});

test("unpriced pool quotes remain unavailable in full, summary and paginated holdings", { skip }, async () => {
  await withFixture(async ({ admin, get, getCoins }) => {
    await seedHoldings(admin);
    await admin.query("UPDATE blast_infra_fixture.presales SET quote_type=$1,pool_id=$2 WHERE presale_id=$3", [`${hex("123")}::test_sui::TEST_SUI`, hex("777"), P.migratedRecently]);
    await admin.query("DELETE FROM blast_infra_fixture.prices WHERE coin_type=$1", [MIGR_COIN]);
    const full = await ok(await get({ authorization: KAI }));
    assert.equal(full.coins?.find((coin) => coin.coin_type === MIGR_COIN)?.value_usd, null);
    const summary = await ok(await get({ authorization: KAI }, "?view=summary"));
    assert.equal(summary.coin_summary?.value_usd, null);
    assert.equal(Number(summary.coin_summary?.known_value_usd), (full.coins ?? []).reduce((sum, coin) => sum + Number(coin.value_usd ?? 0), 0));
    assert.equal((await (await getCoins({ authorization: KAI }, "?q=MIGR")).json()).coins.find((coin: { coin_type: string }) => coin.coin_type === MIGR_COIN).value_usd, null);
    await admin.query("UPDATE blast_infra_fixture.presales SET quote_type=$1 WHERE presale_id=$2", [SUI, P.migratedRecently]);
    assert.equal((await ok(await get({ authorization: KAI }))).coins?.find((coin) => coin.coin_type === MIGR_COIN)?.value_usd, null);
    assert.equal((await (await getCoins({ authorization: KAI }, "?q=MIGR")).json()).coins.find((coin: { coin_type: string }) => coin.coin_type === MIGR_COIN).value_usd, null);
  });
});



test("coin pages rank linked wallets, limit transfer, and search beyond the first page", { skip }, async () => {
  await withFixture(async ({ admin, getCoins, get }) => {
    const headers = { authorization: KAI };
    await admin.query("DELETE FROM blast_infra_fixture.prices WHERE coin_type=$1", [USDC]);
    assert.equal((await (await getCoins(headers, "?q=USDC")).json()).coins[0].value_usd, "15.50");
    const types = Array.from({ length: 103 }, (_, i) => `${hex(String(i + 1000))}::coin::C${i + 1}`);
    for (let i = 0; i < types.length; i++) {
      await admin.query("INSERT INTO blast_infra_fixture.coin_metadata(coin_type,name,symbol,decimals) VALUES ($1,$2,$3,0)", [types[i], i === 102 ? "Literal%coin" : `Holding ${i + 1}`, `C${i + 1}`]);
      await admin.query("INSERT INTO blast_infra_fixture.coin_balances VALUES ($1,$2,$3,80001)", [types[i], W.kai, i + 1]);
      await admin.query("INSERT INTO blast_infra_fixture.prices VALUES ($1,1,$2,'fixture')", [types[i], i === 0 ? NOW - 121_000 : NOW]);
    }
    await admin.query("INSERT INTO blast_infra_fixture.coin_balances VALUES ($1,$2,10000,80001)", [types[0], KAI_SECOND_WALLET]);
    await admin.query("INSERT INTO blast_infra_fixture.coin_balances VALUES ($1,$2,20000,80001)", [types[1], KAI_SECOND_WALLET]);
    await admin.query("UPDATE blast_infra_fixture.coin_balances SET balance=20002 WHERE coin_type=$1 AND owner=$2", [types[2], W.kai]);
    await admin.query("UPDATE blast_infra_fixture.coin_metadata SET decimals=6 WHERE coin_type=$1", [types[96]]);
    await admin.query("UPDATE blast_infra_fixture.coin_balances SET balance=999999 WHERE coin_type=$1", [types[96]]);
    assert.equal((await (await getCoins(headers, "?q=holding%2097&hide_small=true")).json()).total, 0);
    assert.equal((await (await getCoins(headers, "?q=holding%2097&hide_small=false")).json()).total, 1);
    await admin.query("INSERT INTO blast_infra_fixture.coin_balances VALUES ($1,$2,1,80001)", [types[96], KAI_SECOND_WALLET]);
    assert.equal((await (await getCoins(headers, "?q=holding%2097&hide_small=true")).json()).coins[0].balance, "1000000", "linked balances aggregate before the whole-coin cutoff");
    const response = await getCoins(headers);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), PRIVATE);
    const first = await response.json();
    assert.equal(first.page_size, 20);
    assert.equal(first.coins.length, 20);
    const others = first.coins.filter((coin: { coin_type: string }) => types.includes(coin.coin_type));
    assert.equal(first.coins[0].coin_type, types[1]);
    assert.equal(others[0].coin_type, types[1]);
    assert.equal(others[0].balance, "20002");
    assert.equal(others[0].value_usd, "20002.00");
    assert.equal(others[1].coin_type, types[2]);
    assert.equal(others[1].value_usd, "20002.00");
    assert.ok(others.slice(0, -1).every((coin: {value_usd: string | null}, index: number) => Number(coin.value_usd ?? -1) >= Number(others[index + 1].value_usd ?? -1)));
    const seen = new Set<string>();
    let previousValue = Infinity;
    for (let page = 1; page <= Math.ceil(first.total / 20); page++) {
      const body = await (await getCoins(headers, `?page=${page}`)).json();
      assert.equal(body.total, first.total);
      assert.ok(body.coins.length <= 20);
      for (const coin of body.coins) {
        const value = coin.value_usd === null ? -1 : Number(coin.value_usd);
        assert.ok(previousValue >= value, "USD ordering continues across page boundaries");
        previousValue = value;
        assert.ok(!seen.has(coin.coin_type));
        seen.add(coin.coin_type);
      }
    }
    assert.equal(seen.size, first.total);
    const match = await (await getCoins(headers, "?page=99&q=holding%2097")).json();
    assert.equal(match.total, 1);
    assert.equal(match.page, 1);
    assert.equal(match.coins[0].coin_type, types[96]);
    assert.equal((await (await getCoins(headers, "?q=%25")).json()).total, 1);
    assert.equal((await (await getCoins(headers, "?q=no-such-coin")).json()).total, 0);
    const unpriced = await (await getCoins(headers, "?q=C1")).json();
    assert.ok(unpriced.coins.some((coin: {coin_type: string; value_usd: string | null}) => coin.coin_type === types[0] && coin.value_usd === null));
    assert.equal(unpriced.coins.at(-1).value_usd, null);
    const full = await ok(await get(headers));
    const summary = await ok(await get(headers, "?view=summary"));
    assert.deepEqual(summary.coins, []);
    assert.deepEqual(summary.positions, full.positions, "summary retains exact position cost basis");
    assert.deepEqual(summary.balances, full.balances);
    assert.deepEqual(summary.commitments, full.commitments);
    assert.equal(summary.coin_summary?.value_usd, null);
    assert.equal(summary.coin_summary?.today, null);
    assert.equal(Number(summary.coin_summary?.known_value_usd), (full.coins ?? []).reduce((sum, coin) => sum + Number(coin.value_usd ?? 0), 0));
    assert.ok(JSON.stringify(summary).length < JSON.stringify(full).length / 2);
    assert.equal((await getCoins()).status, 401);
    for (const query of ["?page=0", "?page=-1", "?page=1.5", "?page=2147483648", "?hide_small=yes", `?q=${"x".repeat(201)}`]) assert.equal((await getCoins(headers, query)).status, 400);
    const nova = await (await getCoins({ authorization: NOVA })).json();
    assert.ok(!nova.coins.some((coin: { coin_type: string }) => types.includes(coin.coin_type)));
    assert.deepEqual(await (await getCoins(headers, "?page=999999999&q=no-such-coin")).json(), { total: 0, page: 1, page_size: 20, wallet_has_coins: true, coins: [] });
  });
});


test("canonical positive balances bypass cutoff before paging, but zero and copycat tickers do not", { skip }, async () => {
  await withFixture(async ({ admin, getCoins }) => {
    const core = CORE_COINS.filter(coin => coin.symbol !== "USDC" && coin.symbol !== "SUI");
    for (const coin of core) {
      await admin.query("INSERT INTO blast_infra_fixture.coin_metadata(coin_type,name,symbol,decimals) VALUES ($1,$2,$2,9)", [coin.coinType, coin.symbol]);
      await admin.query("INSERT INTO blast_infra_fixture.coin_balances VALUES ($1,$2,1,80001)", [coin.coinType, W.kai]);
    }
    const fake = `${hex("dead") }::coin::WAL`;
    await admin.query("INSERT INTO blast_infra_fixture.coin_metadata(coin_type,name,symbol,decimals) VALUES ($1,'Walrus','WAL',9)", [fake]);
    await admin.query("INSERT INTO blast_infra_fixture.coin_balances VALUES ($1,$2,1,80001)", [fake, W.kai]);
    const headers = { authorization: KAI };
    assert.equal((await (await getCoins(headers, `?hide_small=true&q=${fake}`)).json()).total, 0);
    const first = await (await getCoins(headers, "?hide_small=true")).json();
    const later = await Promise.all(Array.from({ length: Math.ceil(CORE_COINS.length / 20) - 1 }, async (_, index) => (await getCoins(headers, `?hide_small=true&page=${index + 2}`)).json()));
    assert.equal(first.coins.length, 20);
    assert.equal(first.total, CORE_COINS.length);
    assert.deepEqual(first.coins.slice(0, 2).map((coin: { symbol: string }) => coin.symbol), ["USDC", "SUI"]);
    const types = new Set([first, ...later].flatMap((page: { coins: { coin_type: string }[] }) => page.coins).map(coin => coin.coin_type));
    for (const coin of CORE_COINS) assert.ok(types.has(coin.coinType));
    const found = await (await getCoins(headers, "?hide_small=true&q=vsui")).json();
    assert.equal(found.total, 1);
    assert.equal(found.coins[0].balance, "1");
    await admin.query("UPDATE blast_infra_fixture.coin_balances SET balance=0 WHERE coin_type=$1", [core[1]!.coinType]);
    assert.equal((await (await getCoins(headers, `?hide_small=true&q=${core[1]!.coinType}`)).json()).total, 0);
  });
});


test("empty wallets list no coins so the client can show its empty state", { skip }, async () => {
  await withFixture(async ({ admin, getCoins }) => {
    await admin.query("DELETE FROM blast_infra_fixture.coin_balances WHERE owner = ANY($1::text[])", [[W.kai, KAI_SECOND_WALLET]]);
    for (const query of ["", "?hide_small=true", "?q=usdsui&hide_small=true"]) {
      assert.deepEqual(await (await getCoins({ authorization: KAI }, query)).json(), { total: 0, page: 1, page_size: 20, wallet_has_coins: false, coins: [] });
    }
  });
});

test("PnL since launch includes outside-venue trades of Blast coins for external wallets, excludes unrelated coins, and gates public reads", { skip }, async () => {
  await withFixture(async ({ admin, getPnl, publicPnl, pnlDown }) => {
    await refused(await getPnl(), 401, "unauthorized");
    await refused(await pnlDown(), 503, "service_unavailable");
    await seedBasis(admin);
    await admin.query("DELETE FROM blast_infra_fixture.activity");
    const buy = { ...tradeRow("buy", TRADED, "1000000000000", "300"), digest: "B".repeat(44) };
    const sell = { ...tradeRow("sell", TRADED, "1000000000000", "200"), digest: "S".repeat(44) };
    const outside = { ...tradeRow("buy", ONLY_CLAIM, "1000000000000", "999"), presale_id: null, coin_type: `${hex("dead")}::coin::UNRELATED` };
    await seedChainRead(admin, { activity: [buy, sell, outside] });
    await setBalance(admin, TRADED, "0");
    const read = async (query = ""): Promise<SocialPnl> => {
      const response = await getPnl({ authorization: NOVA }, query);
      const body = await response.json();
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(response.headers.get("cache-control"), PRIVATE);
      assert.deepEqual(validator.validate("pnl-response", body).errors, []);
      return body as SocialPnl;
    };
    await admin.query("UPDATE blast_infra_fixture.presales SET sale_icon_url = $1 WHERE presale_id = $2", ["https://i.blast.test/coin.png", TRADED]);
    // All indexed trades of Blast coins count without a Blast submission record.
    const outsideVenue = await read();
    assert.deepEqual(outsideVenue.assets.map((asset) => asset.presale_id), [TRADED]);
    assert.deepEqual(outsideVenue.totals, { realized_usd: "-100.00", unrealized_usd: "0.00", total_usd: "-100.00" });
    for (const activity of [buy, sell]) {
      await admin.query(`INSERT INTO social_transactions (tx_id, account_id, kind, digest, idempotency_key, usd_value)
        VALUES (gen_random_uuid(), $1, $2, $3, $3, 9999)`, [FEED_STORY_ACCOUNTS.nova, activity.kind, activity.digest]);
    }
    // A logged quote of $9,999 cannot replace the chain's $300 cost and $200 proceeds.
    const scoped = await read(`?account_id=${FEED_STORY_ACCOUNTS.kai}&wallet=${W.kai}`);
    assert.deepEqual(scoped, outsideVenue, "Blast volume records do not alter coin PnL");
    assert.deepEqual(scoped.assets.map((asset) => asset.presale_id), [TRADED]);
    assert.equal(scoped.assets[0].icon_url, "https://i.blast.test/coin.png");
    assert.deepEqual(scoped.totals, { realized_usd: "-100.00", unrealized_usd: "0.00", total_usd: "-100.00" });
    assert.doesNotMatch(JSON.stringify(scoped), new RegExp(W.nova));
    await refused(await publicPnl("nova"), 403, "portfolio_private", "no-store");
    await admin.query("UPDATE social_accounts SET portfolio_public = true, portfolio_public_since = now(), privacy = 'public' WHERE account_id = $1", [FEED_STORY_ACCOUNTS.nova]);
    const publicResponse = await publicPnl("nova");
    assert.equal(publicResponse.status, 200);
    assert.equal(publicResponse.headers.get("cache-control"), "public, s-maxage=10");
    assert.deepEqual(await publicResponse.json(), scoped);
    await admin.query("UPDATE social_accounts SET privacy = 'private', sharing_since = NULL, portfolio_public_since = NULL WHERE account_id = $1", [FEED_STORY_ACCOUNTS.nova]);
    await refused(await publicPnl("nova"), 403, "portfolio_private", "no-store");
    await refused(await publicPnl("nobody"), 404, "not_found", "no-store");
  });
});

test("launch readiness and the checkpoint boundary exclude prelaunch profit from the real PnL route", { skip }, async () => {
  await withFixture(async ({ admin, getPnl }) => {
    await seedBasis(admin);
    await admin.query("DELETE FROM blast_infra_fixture.activity");
    await setBalance(admin, TRADED, "0");
    await admin.query("UPDATE blast_infra_fixture.pnl_accounting_period SET first_checkpoint=NULL");
    await refused(await getPnl({ authorization: NOVA }), 503, "service_unavailable");
    await seedChainRead(admin, { activity: [
      { ...tradeRow("buy", TRADED, "1000000000000", "1"), checkpoint: 89999, tx_slot: 0, timestamp_ms: NOW - 3000 },
      { ...tradeRow("sell", TRADED, "1000000000000", "1000"), checkpoint: 90000, tx_slot: 0, timestamp_ms: NOW - 2000 },
      { ...tradeRow("buy", TRADED, "1000000000000", "100"), checkpoint: 90001, tx_slot: 0, timestamp_ms: NOW - 1000 },
      { ...tradeRow("sell", TRADED, "1000000000000", "120"), checkpoint: 90001, tx_slot: 1, timestamp_ms: NOW - 1000 },
    ] });
    await admin.query("UPDATE blast_infra_fixture.pnl_accounting_period SET first_checkpoint=90001");
    const response = await getPnl({ authorization: NOVA });
    const answer = await response.json() as SocialPnl;
    assert.equal(response.status, 200);
    assert.equal(answer.period, "since_launch");
    assert.deepEqual(answer.totals, { realized_usd: "20.00", unrealized_usd: "0.00", total_usd: "20.00" });
    const source = await admin.query("SELECT count(*)::int AS count FROM blast_infra_fixture.activity");
    assert.equal(source.rows[0].count, 4, "the route preserves excluded source history");
  });
});

test("curve coin PnL includes pre- and post-graduation trades, with the original launch identity", { skip }, async () => {
  await withFixture(async ({ admin, getPnl, url }) => {
    await seedBasis(admin);
    await admin.query("DELETE FROM blast_infra_fixture.activity");
    const launch = hex("c001");
    const coin = `${launch}::coin::CURVE`;
    const migratedPool = `cetus:${hex("c002")}`;
    await admin.query(`INSERT INTO coins (coin_type, decimals, launcher, creator, metadata, pool_key, created_checkpoint, created_at_ms)
      VALUES ($1, 9, $2, $2, $3, $4, 900, $5)`,
    [coin, W.nova, JSON.stringify({ name: "Curve coin", symbol: "CURVE" }), migratedPool, NOW - DAY]);
    for (const [key, venue, lifecycle] of [[`blast_curve:${launch}`, "blast_curve", "migrated"], [migratedPool, "cetus", "active"]]) {
      await admin.query(`INSERT INTO pools (pool_key, venue, coin_type, quote_type, lifecycle, created_checkpoint, created_at_ms)
        VALUES ($1, $2, $3, $4, $5, 900, $6)`, [key, venue, coin, USDC, lifecycle, NOW - DAY]);
    }
    await seedChainRead(admin, {
      activity: [
        { ...tradeRow("buy", TRADED, "100000000000", "100"), presale_id: null, coin_type: coin, venue: "blast_curve" },
        { ...tradeRow("sell", TRADED, "40000000000", "80"), presale_id: null, coin_type: coin, venue: "cetus" },
        { ...tradeRow("buy", TRADED, "100000000000", "999"), presale_id: null, coin_type: `${hex("dead")}::coin::OTHER`, venue: "cetus" },
      ],
      coin_balances: [{ coin_type: coin, owner: W.nova, balance: "60000000000", updated_checkpoint: ledgerCheckpoint }],
      prices: [{ coin_type: coin, usd_price: "2", as_of_ms: NOW - 5_000, source: "pool" }],
    });
    const response = await getPnl({ authorization: NOVA });
    const body = await response.json() as SocialPnl;
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.deepEqual(validator.validate("pnl-response", body).errors, []);
    assert.equal(body.assets.length, 1);
    assert.deepEqual(body.assets[0], {
      presale_id: null, launch_id: launch, coin_type: coin, symbol: "CURVE", icon_url: null,
      tracked_balance: "60000000000", basis_usd: "60.00", realized_usd: "40.00", unrealized_usd: "60.00", total_usd: "100.00",
    });
    assert.deepEqual(body.totals, { realized_usd: "40.00", unrealized_usd: "60.00", total_usd: "100.00" });
    const pool = createRuntimePool(urlAs(url, "blast_web"), POOL, "curve-holdings");
    try {
      const { readWalletHoldings } = await import("@blast/server/modules/social/portfolio/wallet-holdings.ts");
      const holding = (await readWalletHoldings(autocommitReader(pool, "social"), [W.nova])).holdings.find(row => row.coin_type === coin);
      assert.equal(holding?.presale_id, null);
      assert.equal(holding?.launch_id, launch);
      assert.equal(holding?.symbol, "CURVE");
      await admin.query("UPDATE social_accounts SET portfolio_public = true, portfolio_public_since = now(), privacy = 'public' WHERE account_id = $1", [FEED_STORY_ACCOUNTS.nova]);
      const db = autocommitReader(pool, "social");
      const portfolios = await readTraderPortfolios(db, { db, wallets: { async wallets() { return [{ address: W.nova, kind: "external", linked_at_ms: 0 }]; } } }, [FEED_STORY_ACCOUNTS.nova], NOW);
      const portfolio = portfolios.get(FEED_STORY_ACCOUNTS.nova)!;
      assert.equal(portfolio.pnl_usd, body.totals.total_usd, "Home and profile include the same curve PnL");
      assert.equal(portfolio.holdings?.find(row => row.launch_id === launch)?.launch_id, launch);
      assert.equal(portfolio.holdings?.find(row => row.launch_id === launch)?.pnl_usd, "60.00", "holding rows show unrealized PnL; the leaderboard includes realized gains too");
      await admin.query("DELETE FROM blast_infra_fixture.prices WHERE coin_type = $1", [coin]);
      const missingMark = await (await getPnl({ authorization: NOVA })).json() as SocialPnl;
      assert.deepEqual(missingMark.totals, { realized_usd: "40.00", unrealized_usd: null, total_usd: null });
      const unpriced = await readTraderPortfolios(db, { db, wallets: { async wallets() { return [{ address: W.nova, kind: "external", linked_at_ms: 0 }]; } } }, [FEED_STORY_ACCOUNTS.nova], NOW);
      assert.equal(unpriced.get(FEED_STORY_ACCOUNTS.nova)?.pnl_usd, null, "unpriced curve holdings cannot enter the PnL ranking");
      await seedChainRead(admin, { prices: [{ coin_type: coin, usd_price: "0", as_of_ms: NOW - 5_000, source: "pool" }] });
      const zeroMark = await (await getPnl({ authorization: NOVA })).json() as SocialPnl;
      assert.deepEqual(zeroMark.totals, { realized_usd: "40.00", unrealized_usd: "-60.00", total_usd: "-20.00" });
      const zeroPriced = await readTraderPortfolios(db, { db, wallets: { async wallets() { return [{ address: W.nova, kind: "external", linked_at_ms: 0 }]; } } }, [FEED_STORY_ACCOUNTS.nova], NOW);
      assert.equal(zeroPriced.get(FEED_STORY_ACCOUNTS.nova)?.pnl_usd, "-20.00", "an explicit zero mark remains a known loss");
      for (const [buyVenue, sellVenue] of [["blast_curve", "cetus"], ["cetus", "blast_curve"]]) {
        await admin.query("DELETE FROM blast_infra_fixture.activity");
        const buy = { ...tradeRow("buy", TRADED, "100000000000", "100"), presale_id: null, coin_type: coin, checkpoint: 80000, tx_slot: 0, event_slot: 0, venue: buyVenue };
        const sell = { ...tradeRow("sell", TRADED, "100000000000", "120"), presale_id: null, coin_type: coin, checkpoint: 80000, tx_slot: 0, event_slot: 1, venue: sellVenue };
        // The outside acquisition precedes the native disposal in one direction;
        // reverse the venue assignments while retaining the actual buy-before-sell chronology.
        await seedChainRead(admin, { activity: [
          buy, sell,
        ] });
        const closed = await (await getPnl({ authorization: NOVA })).json() as SocialPnl;
        assert.equal(closed.totals.realized_usd, "20.00");
      }
      await admin.query("UPDATE blast_infra_fixture.activity SET event_slot = 4294967295 WHERE kind = 'trade_sell'");
      const incomplete = await (await getPnl({ authorization: NOVA })).json() as SocialPnl;
      assert.equal(incomplete.history_complete, false, "ambiguous mixed routes explicitly invalidate indexed PnL");
      assert.equal(incomplete.totals.total_usd, null);
      const unranked = await readTraderPortfolios(db, { db, wallets: { async wallets() { return [{ address: W.nova, kind: "external", linked_at_ms: 0 }]; } } }, [FEED_STORY_ACCOUNTS.nova], NOW);
      assert.equal(unranked.get(FEED_STORY_ACCOUNTS.nova)?.pnl_usd, null, "incomplete accounts cannot enter the PnL ranking");
    } finally {
      await pool.end();
    }
  });
});

test("PnL history readiness only rejects unordered opposite-side trades of the same coin", { skip }, async () => {
  await withFixture(async ({ admin }) => {
    await admin.query("DELETE FROM blast_infra_fixture.activity");
    const mixes = [
      ["buy", "buy", "same", true],
      ["sell", "sell", "same", true],
      ["buy", "sell", "different", true],
      ["buy", "sell", "same", false],
      ["sell", "buy", "same", false],
    ] as const;
    const activity = mixes.flatMap(([native, outside, coin], txSlot) => [
      { ...tradeRow(native, TRADED, "100", "100"), checkpoint: 90000, tx_slot: txSlot, event_slot: 0 },
      { ...tradeRow(outside, TRADED, "100", "100"), checkpoint: 90000, tx_slot: txSlot, event_slot: 4294967295,
        coin_type: coin === "same" ? coinOf(TRADED) : `${hex("dead")}::coin::OTHER` },
    ]);
    await seedChainRead(admin, { activity });
    const { rows } = await admin.query<{ accounting_complete: boolean }>(
      "SELECT accounting_complete FROM chain_read_v1.blast_pnl_activity WHERE event_slot = 4294967295 ORDER BY tx_slot",
    );
    assert.deepEqual(rows.map(row => row.accounting_complete), mixes.map(mix => mix[3]));
  });
});

test("embedded Privy wallets include indexed activity since creation without Blast transaction logs", { skip }, async () => {
  await withFixture(async ({ admin, getPnl }) => {
    await seedBasis(admin);
    await admin.query("DELETE FROM blast_infra_fixture.activity");
    // Provider-resolved embedded origin, independent of how this request authenticated.
    await admin.query("INSERT INTO presale_embedded_wallets (privy_did, address) VALUES ('did:privy:feed-story-nova', $1)", [W.nova]);
    await seedChainRead(admin, { activity: [tradeRow("buy", TRADED, "1000000000000", "300"), tradeRow("sell", TRADED, "1000000000000", "500")] });
    await setBalance(admin, TRADED, "0");
    const response = await getPnl({ authorization: NOVA });
    assert.equal(response.status, 200);
    const body = await response.json() as SocialPnl;
    assert.deepEqual(body.totals, { realized_usd: "200.00", unrealized_usd: "0.00", total_usd: "200.00" });
  });
});

test("unpriced core coins precede other unpriced holdings and zero balances are not listed", { skip }, async () => {
  await withFixture(async ({ admin, getCoins }) => {
    await admin.query("DELETE FROM blast_infra_fixture.coin_balances WHERE owner = ANY($1::text[])", [[W.kai, KAI_SECOND_WALLET]]);
    const wal = CORE_COINS.find(coin => coin.symbol === "WAL")!;
    const other = `${hex("1")}::coin::TIE`;
    for (const [type, symbol] of [[wal.coinType, "WAL"], [other, "TIE"]]) {
      await admin.query("INSERT INTO blast_infra_fixture.coin_metadata(coin_type,name,symbol,decimals) VALUES ($1,$2,$2,9)", [type, symbol]);
      await admin.query("INSERT INTO blast_infra_fixture.coin_balances VALUES ($1,$2,1000000000,80001)", [type, W.kai]);
    }
    for (const query of ["", "?hide_small=true"]) {
      const page = await (await getCoins({ authorization: KAI }, query)).json();
      assert.deepEqual(page.coins.map((coin: { symbol: string }) => coin.symbol), ["WAL", "TIE"]);
      assert.ok(page.coins.every((coin: { value_usd: string | null; value_usd_exact: string | null }) => coin.value_usd === null && coin.value_usd_exact === null));
    }
  });
});
