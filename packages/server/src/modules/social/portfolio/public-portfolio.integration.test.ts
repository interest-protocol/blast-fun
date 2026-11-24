import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { seedChainRead, type ChainPresalePositionRow } from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { createSocialSettingsRoute } from "@blast/server/modules/social/accounts/settings-route.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import type { SocialPortfolio } from "@blast/core/modules/social/contracts/portfolio.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { FEED_STORY_ACCOUNTS, FEED_STORY_PRESALES, FEED_STORY_WALLETS, seedFeedStory } from "../../../../../core/test/fixtures/modules/social/feed/feed-story.ts";
import { createSocialRouteKit, SOCIAL_PUBLIC_FRESH_CACHE_CONTROL } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialPublicPortfolioRoute } from "@blast/server/modules/social/portfolio/public-route.ts";
import { readAccountAddresses } from "@blast/server/modules/social/accounts/read-wallet-addresses.ts";
import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import { createSocialPortfolioRoute } from "@blast/server/modules/social/portfolio/route.ts";
import { hex } from "../../../../../core/test/kit.ts";

/**
 * Social-feed UI-07 (owner decision OA-10): `GET
 * /api/social/profiles/{callsign}/portfolio`, the opt-in public read of a
 * portfolio, over the feed story. The public route reads as the replica role
 * (`blast_replica`); the owner's `/me/portfolio` and the settings route as
 * the web role (`blast_web`). Wallet balances are indexed fixture rows.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-public-portfolio-app";
const PEPPER = "social-public-portfolio-pepper-0123456789abcdef";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 6, statementTimeoutMs: 5_000 };
const NOW = Date.now();
const SUI = PORTFOLIO_COIN_TYPES.sui;
const USDC = PORTFOLIO_COIN_TYPES.usdc;
const W = FEED_STORY_WALLETS;
const P = FEED_STORY_PRESALES;
/** Kai's second proven wallet and his presale embedded wallet. */
const KAI_SECOND = hex("ca2");
const KAI_EMBEDDED = hex("ce1");
/** An address Kai and a Mission Control member both claim: it belongs to neither. */
const CONTESTED = hex("c0c0");
const AGED_COIN = `${P.migratedLongAgo}::coin::AGED`;

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
const GHOST = bearer("did:privy:feed-story-ghost");

const BALANCES: Readonly<Record<string, string>> = {
  [`${W.kai}|${SUI}`]: "1500000000",
  [`${KAI_SECOND}|${SUI}`]: "2000000000",
  [`${KAI_EMBEDDED}|${USDC}`]: "10000000",
  [`${W.nova}|${SUI}`]: "1000000000",
  [`${CONTESTED}|${SUI}`]: "999000000000",
};

function position(presaleId: string, wallet: string, commitment: string, minutesAgo: number): ChainPresalePositionRow {
  return {
    presale_id: presaleId, wallet, commitment, last_commit_ms: NOW - minutesAgo * 60_000,
    claim_digest: null, claimed_tokens: null, claimed_quote_refund: null, claimed_ms: null,
  };
}

type Fixture = Readonly<{
  admin: Pool;
  replica: Pool;
  /** The public read, with optional headers (a token is never read). */
  read(callsign: string, headers?: Record<string, string>): Promise<Response>;
  /** The owner's own portfolio. */
  own(token: string): Promise<Response>;
  settings(token: string, body: unknown): Promise<Response>;
}>;

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  await seedFeedStory(admin, { nowMs: NOW });
  const since = new Date(NOW - 30 * 86_400_000).toISOString();
  await admin.query("INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, $3), ($4, $2, $3)", [
    KAI_SECOND, FEED_STORY_ACCOUNTS.kai, since, CONTESTED,
  ]);
  // Kai's presale embedded wallet (by his own Privy DID); a member (below) also holds the contested address.
  await admin.query("INSERT INTO presale_embedded_wallets (privy_did, address, resolved_at) VALUES ($1, $2, $3)", [
    "did:privy:feed-story-kai", KAI_EMBEDDED, since,
  ]);
  await admin.query(
    `INSERT INTO mission_control_profiles (profile_id, privy_did, x_subject, sui_address, provider_wallet_reference, callsign, disclosure_version, disclosure_accepted_at)
     VALUES ('00000000-0000-4000-8000-00000000c0c0', 'did:privy:contested', 'x-contested', $1, 'ref-contested', 'contested', 'fixture-v1', now())`,
    [hex("9c0c0")],
  );
  await admin.query(
    `INSERT INTO social_accounts (account_id, profile_id, onboarded_at) VALUES ('00000000-0000-4000-8000-00000000c0c1', '00000000-0000-4000-8000-00000000c0c0', now())`,
  );
  await admin.query(
    `INSERT INTO mission_control_account_wallets (wallet_id, profile_id, wallet_kind, sui_address, provider_wallet_reference, is_primary, verified_at)
     VALUES ('00000000-0000-4000-8000-00000000c0c2', '00000000-0000-4000-8000-00000000c0c0', 'slush', $1, 'ref-c0c0', true, $2)`,
    [CONTESTED, since],
  );
  await seedChainRead(admin, {
    // R3-32: Kai bought 1,000 AGED for $300 from his second wallet and holds them; they trade at $0.50.
    activity: [{
      checkpoint: 80_001, tx_slot: 0, event_slot: 1, part: 0, timestamp_ms: NOW - 60_000, digest: "Pb1".padEnd(44, "1"),
      kind: "trade_buy", product: "market", actor: KAI_SECOND, tx_sender: KAI_SECOND, presale_id: P.migratedLongAgo,
      coin_type: AGED_COIN, quote_type: USDC, quote_amount: "300000000", coin_amount: "1000000000000", quote_refund: null,
      usd_value: "300", usd_price_as_of_ms: NOW - 60_000, venue: "cetus", participants_after: null, total_commitments_after: null,
    }],
    coin_balances: [{ coin_type: AGED_COIN, owner: KAI_SECOND, balance: "1000000000000", updated_checkpoint: 80_001 }],
    presale_positions: [
      position(P.open, W.kai, "20000000", 10),
      position(P.open, KAI_EMBEDDED, "30000000", 5),
      position(P.funded, KAI_SECOND, "11000000", 3 * 24 * 60),
      position(P.open, W.nova, "20000000", 8),
      position(P.migratedRecently, CONTESTED, "5000000000", 30),
    ],
    prices: [
      { coin_type: SUI, usd_price: "3.5", as_of_ms: NOW - 10_000, source: "pyth" },
      { coin_type: USDC, usd_price: "1", as_of_ms: NOW - 10_000, source: "pyth" },
      { coin_type: AGED_COIN, usd_price: "0.5", as_of_ms: NOW - 10_000, source: "pool" },
    ],
  });
  const web = createRuntimePool(urlAs(url, "blast_web"), POOL, "social-public-portfolio-web");
  const replica = createRuntimePool(urlAs(url, "blast_replica"), POOL, "social-public-portfolio-replica");
  try {
    assert.equal((await replica.query("SELECT current_user AS role")).rows[0]?.role, "blast_replica");
    const accounts = new PostgresSocialAccounts(() => web);
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({
        appId: APP_ID,
        verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      }),
      limiter: new PostgresRateLimitEnforcer({ pool: web, subjectPepper: PEPPER }),
      accounts,
      primary: () => web,
    });
    for (const [key, balance] of Object.entries(BALANCES)) {
      const [owner, coin] = key.split("|");
      await admin.query("INSERT INTO blast_infra_fixture.coin_balances VALUES ($1,$2,$3,80001) ON CONFLICT (coin_type,owner) DO UPDATE SET balance=excluded.balance", [coin, owner, balance]);
      await admin.query("INSERT INTO blast_infra_fixture.wallet_sync(owner,timestamp_ms) VALUES ($1,$2) ON CONFLICT DO NOTHING", [owner,NOW]);
    }
    const replicaDb = autocommitReader(replica, "social", { prepare: true });
    const publicRoute = createSocialPublicPortfolioRoute({ kit, database: () => replicaDb, now: () => NOW });
    const webDb = autocommitReader(web, "social", { prepare: true });
    const ownRoute = createSocialPortfolioRoute({ kit, wallets: accounts, database: () => webDb, now: () => NOW });
    const settingsRoute = createSocialSettingsRoute({ kit });
    await run({
      admin,
      replica,
      read: (callsign, headers = {}) =>
        publicRoute.GET(new Request(`${ORIGIN}/api/social/profiles/${callsign}/portfolio`, { headers: { "x-forwarded-for": "203.0.113.5", ...headers } }), testClient("203.0.113.5")),
      own: (token) => ownRoute.GET(new Request(`${ORIGIN}/api/social/me/portfolio`, { headers: { authorization: token } }), testClient()),
      settings: (token, body) =>
        settingsRoute.PUT(new Request(`${ORIGIN}/api/social/me/settings`, {
          method: "PUT",
          headers: { authorization: token, "content-type": "application/json" },
          body: JSON.stringify(body),
        }), testClient()),
    });
  } finally {
    await Promise.all([admin.end(), web.end(), replica.end()]);
    await database.drop();
  }
}

async function refused(response: Response, status: number, code: string): Promise<void> {
  const body = (await response.json()) as { error: { code: string } };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  assert.deepEqual(validator.validate("error", body).errors, []);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.ok(response.headers.get("x-request-id"));
}

async function portfolio(response: Response, cacheControl: string): Promise<SocialPortfolio> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate("portfolio-response", body).errors, []);
  assert.equal(response.headers.get("cache-control"), cacheControl);
  return body as SocialPortfolio;
}

test("UI-07 (OA-10): a portfolio is public only while its owner opted in and the account is public", { skip }, () =>
  withFixture(async ({ admin, read, own, settings }) => {
    // Off by default: refused, and errors are never cached.
    await refused(await read("kai"), 403, "portfolio_private");
    await refused(await read("ghost"), 403, "portfolio_private");
    await refused(await read("nobody_here"), 404, "not_found");
    await refused(await read("Not%20A%20Callsign"), 400, "invalid_parameter");

    // Kai opts in: anyone reads exactly what Kai's own read shows, shared at the edge 10 s (OA-30), naming no wallet.
    assert.equal((await settings(KAI, { public_portfolio: true })).status, 200);
    const shared = await portfolio(await read("kai"), SOCIAL_PUBLIC_FRESH_CACHE_CONTROL);
    const mine = await portfolio(await own(KAI), "private, no-store");
    assert.deepEqual(shared, mine);
    const text = JSON.stringify(shared);
    for (const address of [W.kai, KAI_SECOND, KAI_EMBEDDED, CONTESTED]) assert.equal(text.includes(address.slice(2)), false);
    // 1.5 + 2 SUI at $3.50 and 10 USDC; positions in the open (both wallets) and funded sales; the contested address counts for nobody.
    assert.deepEqual(shared.balances, { sui: { atoms: "3500000000", usd: "12.25" }, usdc: { atoms: "10000000", usd: "10.00" } });
    assert.deepEqual(shared.positions?.map((row) => [row.presale_id, row.commitment, row.status]), [
      [P.open, "50000000", "open"],
      [P.funded, "11000000", "closed"],
    ]);

    // A token changes nothing: the read never looks at the caller.
    assert.deepEqual(await portfolio(await read("kai", { authorization: NOVA }), SOCIAL_PUBLIC_FRESH_CACHE_CONTROL), shared);

    // Going private closes it even with the switch on; public again (switch still on) reopens it.
    assert.equal((await settings(KAI, { private: true })).status, 200);
    await refused(await read("kai"), 403, "portfolio_private");
    assert.equal((await settings(KAI, { private: false })).status, 200);
    await portfolio(await read("kai"), SOCIAL_PUBLIC_FRESH_CACHE_CONTROL);
    // Switching it off closes it.
    assert.equal((await settings(KAI, { public_portfolio: false })).status, 200);
    await refused(await read("kai"), 403, "portfolio_private");

    // A private account cannot be read even after opting in (Ghost is private; onboard him first).
    await admin.query("UPDATE social_accounts SET onboarded_at = now() WHERE account_id = $1", [FEED_STORY_ACCOUNTS.ghost]);
    assert.equal((await settings(GHOST, { public_portfolio: true })).status, 200);
    await refused(await read("ghost"), 403, "portfolio_private");
  }));

test("R3-32-AC-7 (amended by OA-30): a public portfolio carries the cost basis, a private one carries none; only the public one is shared, 10 s", { skip }, () =>
  withFixture(async ({ read, own, settings }) => {
    // Private (the default): a refusal with no portfolio field at all, never cached.
    const closed = await read("kai");
    const refusal = await closed.clone().json() as Record<string, unknown>;
    await refused(closed, 403, "portfolio_private");
    assert.deepEqual(Object.keys(refusal), ["error"]);
    for (const field of ["basis_usd", "basis_complete", "pnl_usd", "pnl_multiple", "coins", "positions"]) {
      assert.equal(JSON.stringify(refusal).includes(field), false, field);
    }

    // The owner's read: 1,000 AGED for $300, worth $500. Every position carries its coin's figures too.
    const mine = await portfolio(await own(KAI), "private, no-store");
    const figures = { basis_usd: "300.00", basis_complete: true, pnl_usd: "200.00", pnl_multiple: "1.6667" };
    assert.deepEqual(mine.coins, [{ coin_type: AGED_COIN, symbol: "AGED", name: "Aged", decimals: 9, icon_url: "https://i.blast.test/aged.png", presale_id: P.migratedLongAgo, balance: "1000000000000", value_usd: "500.00", value_usd_exact: "500", ...figures }]);
    assert.ok(mine.positions!.every((row) => "basis_usd" in row && "basis_complete" in row && "pnl_usd" in row && "pnl_multiple" in row));

    // Public: the same fields and figures, shared at the edge 10 s and never stale (OA-30).
    assert.equal((await settings(KAI, { public_portfolio: true })).status, 200);
    const shared = await portfolio(await read("kai"), SOCIAL_PUBLIC_FRESH_CACHE_CONTROL);
    assert.deepEqual(shared.coins, mine.coins);
    assert.deepEqual(shared.positions, mine.positions);
  }));

test("OA-30 (amending R3-32-AC-7): the opted-in portfolio is shared 10 s and never stale; /me/portfolio stays private, no-store; a refusal is never cached", { skip }, () =>
  withFixture(async ({ read, own, settings }) => {
    const closed = await read("kai");
    assert.equal(closed.status, 403);
    assert.equal(closed.headers.get("cache-control"), "no-store");
    assert.equal((await settings(KAI, { public_portfolio: true })).status, 200);
    const shared = await read("kai");
    assert.equal(shared.status, 200);
    assert.equal(shared.headers.get("cache-control"), "public, s-maxage=10");
    const mine = await own(KAI);
    assert.equal(mine.status, 200);
    assert.equal(mine.headers.get("cache-control"), "private, no-store");
    // A token on the public read changes nothing: still the shared answer.
    assert.equal((await read("kai", { authorization: NOVA })).headers.get("cache-control"), "public, s-maxage=10");
  }));

test("OA-25 Q16: a public portfolio's trend shows only its public history; the owner's own view shows all of it", { skip }, () =>
  withFixture(async ({ admin, read, own, settings }) => {
    // A month of Kai's daily snapshots, from $2,000.00 30 days back to $2,300.00 today (+15%).
    await admin.query(
      `INSERT INTO social_portfolio_snapshots (account_id, day, value_usd, committed_usd, claimable_usd, tokens_usd, usdc_usd, sui_usd, taken_at_ms, checkpoint)
       SELECT $1::uuid, d.day, v.value, v.value, 0, 0, 0, 0, (extract(epoch FROM d.day) * 1000)::bigint + 300000, 1
       FROM generate_series(0, 30) AS g(n)
       CROSS JOIN LATERAL (SELECT (to_timestamp($2::bigint / 1000.0) AT TIME ZONE 'UTC')::date - g.n AS day) d
       CROSS JOIN LATERAL (SELECT (2000 + (30 - g.n) * 10)::numeric(20, 2) AS value) v`,
      [FEED_STORY_ACCOUNTS.kai, NOW],
    );
    const closed = await read("kai");
    const refusal = JSON.stringify(await closed.clone().json());
    await refused(closed, 403, "portfolio_private");
    assert.equal(refusal.includes("trend"), false);
    const full = { days: 30, change_bps: "1500" };
    const mine = await portfolio(await own(KAI), "private, no-store");
    assert.deepEqual([mine.trend?.points.length, mine.trend?.points[0]?.value_usd, mine.trend?.points.at(-1)?.value_usd, mine.trend?.change_bps], [31, "2000.00", "2300.00", "1500"]);
    const empty = { days: 30, points: [], change_bps: null };

    // Opting in now: no day before today is public, so no line yet; the owner still sees the month.
    assert.equal((await settings(KAI, { public_portfolio: true })).status, 200);
    const since = async () => (await admin.query<{ since: Date | null }>("SELECT portfolio_public_since AS since FROM social_accounts WHERE account_id = $1", [FEED_STORY_ACCOUNTS.kai])).rows[0]!.since;
    const opted = await since();
    assert.ok(opted && Math.abs(opted.getTime() - Date.now()) < 60_000);
    assert.deepEqual((await portfolio(await read("kai"), SOCIAL_PUBLIC_FRESH_CACHE_CONTROL)).trend, empty);
    assert.deepEqual((await portfolio(await own(KAI), "private, no-store")).trend, mine.trend);

    // Public since `daysAgo` days (at 01:00 UTC that day): the window starts that UTC day, and the month must fit in it.
    const publicFor = (daysAgo: number) =>
      admin.query("UPDATE social_accounts SET portfolio_public_since = to_timestamp($2::bigint / 1000.0) WHERE account_id = $1", [
        FEED_STORY_ACCOUNTS.kai, (Math.floor(NOW / 86_400_000) - daysAgo) * 86_400_000 + 3_600_000,
      ]);
    await publicFor(20);
    assert.deepEqual((await portfolio(await read("kai"), SOCIAL_PUBLIC_FRESH_CACHE_CONTROL)).trend, empty);
    await publicFor(29);
    assert.deepEqual((await portfolio(await read("kai"), SOCIAL_PUBLIC_FRESH_CACHE_CONTROL)).trend, empty);
    // Thirty days of public history: the same line the owner sees.
    await publicFor(30);
    const shared = await portfolio(await read("kai"), SOCIAL_PUBLIC_FRESH_CACHE_CONTROL);
    assert.deepEqual(shared.trend, mine.trend);
    assert.deepEqual({ days: shared.trend?.days, change_bps: shared.trend?.change_bps }, full);
    // A longer public history shows the same 30 days.
    await publicFor(90);
    assert.deepEqual((await portfolio(await read("kai"), SOCIAL_PUBLIC_FRESH_CACHE_CONTROL)).trend, mine.trend);

    // Going private closes it and forgets the public history; public again (the switch still on) starts over today.
    assert.equal((await settings(KAI, { private: true })).status, 200);
    assert.equal(await since(), null);
    await refused(await read("kai"), 403, "portfolio_private");
    assert.equal((await settings(KAI, { private: false })).status, 200);
    assert.ok(((await since())?.getTime() ?? 0) > opted.getTime() - 1);
    assert.deepEqual((await portfolio(await read("kai"), SOCIAL_PUBLIC_FRESH_CACHE_CONTROL)).trend, empty);
    // So does switching the portfolio off and on.
    await publicFor(30);
    assert.equal((await settings(KAI, { public_portfolio: false })).status, 200);
    assert.equal(await since(), null);
    assert.equal((await settings(KAI, { public_portfolio: true })).status, 200);
    assert.deepEqual((await portfolio(await read("kai"), SOCIAL_PUBLIC_FRESH_CACHE_CONTROL)).trend, empty);
    // The owner's view never changed.
    assert.deepEqual((await portfolio(await own(KAI), "private, no-store")).trend, mine.trend);
  }));

test("UI-07: the public read's address list is the owner's, indexed by account and checked against social_wallet_owners", { skip }, () =>
  withFixture(async ({ admin, replica }) => {
    const db = autocommitReader(replica, "social", { prepare: true });
    const owners = async (accountId: string) =>
      (await admin.query<{ address: string }>("SELECT address FROM social_wallet_owners WHERE account_id = $1 ORDER BY address", [accountId]))
        .rows.map((row) => row.address);
    for (const accountId of [FEED_STORY_ACCOUNTS.kai, FEED_STORY_ACCOUNTS.nova, FEED_STORY_ACCOUNTS.ghost]) {
      assert.deepEqual(await readAccountAddresses(db, accountId), await owners(accountId));
    }
    assert.equal((await readAccountAddresses(db, FEED_STORY_ACCOUNTS.kai)).includes(CONTESTED), false);
    assert.equal((await readAccountAddresses(db, FEED_STORY_ACCOUNTS.nova)).includes(CONTESTED), false);
  }));
