import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test from "node:test";

import { normalizeStructTag } from "@mysten/sui/utils";
import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { seedChainRead } from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import type { SocialTransfer, SocialWallet } from "@blast/core/modules/social/contracts/coins.ts";
import { CREATE_TEST_SUI_QUOTE_TYPE, CREATE_USDSUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { SOCIAL_WALLET_SESSION_COOKIE } from "@blast/core/modules/social/contracts/wallet-sign-in.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { FEED_STORY_PRESALES, FEED_STORY_WALLETS, seedFeedStory } from "../../../../../core/test/fixtures/modules/social/feed/feed-story.ts";
import { PORTFOLIO_COIN_TYPES } from "@blast/core/modules/social/portfolio/read.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialCoinsRoutes, type TransferLookup } from "@blast/server/modules/social/coins/route.ts";
import type { ExecutedTransfer } from "@blast/server/modules/social/coins/transfers.ts";
import type { CoinsFullnode } from "@blast/server/modules/social/coins/wallet.ts";

/**
 * Social feed UI-14: the coins sheet's routes over a disposable database with
 * the fixture `chain_read_v1` and the feed story, as `blast_web` on the
 * primary. Kai signs in with Privy and has an embedded wallet (his story
 * wallet); Nova has none yet. The fullnode is a stub: balances by owner, and
 * executed transactions by digest. Nothing is signed or sent.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-coins-app";
const PEPPER = "social-coins-fixture-pepper-0123456789abcdef0123";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 6, statementTimeoutMs: 5_000 };
const NOW = Date.now();
const PRIVATE = "private, no-store";
const SUI = PORTFOLIO_COIN_TYPES.sui;
const USDC = PORTFOLIO_COIN_TYPES.usdc;
const W = FEED_STORY_WALLETS;
const MIGR = `${FEED_STORY_PRESALES.migratedRecently}::coin::MIGR`;
const SPAM = `0x${"5".repeat(64)}::spam::SPAM`;
const RECIPIENT = `0x${"a3".repeat(32)}`;
const DIGEST = "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi";
const OTHER_DIGEST = "9GmKpXv3uRbT7wYc2LhNq5sDfE8jZa4oiP6Bt1Vy3nWx";
const WALLET_COOKIE_TOKEN = "k".repeat(43);

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
const STRANGER = bearer("did:privy:nobody-here");

/** Embedded wallets by DID: Kai's is his story wallet; Nova has none yet. */
const EMBEDDED: Readonly<Record<string, string | null>> = {
  "did:privy:feed-story-kai": W.kai,
  "did:privy:feed-story-nova": null,
  "did:privy:feed-story-mallory": W.mallory,
};
const MALLORY = bearer("did:privy:feed-story-mallory");

type Stub = CoinsFullnode & TransferLookup & {
  mode: "ok" | "down";
  balances: Record<string, { coinType: string; balance: string }[]>;
  executedBy: Map<string, ExecutedTransfer>;
  lookups: number;
};

function stub(): Stub {
  const fullnode: Stub = {
    mode: "ok",
    lookups: 0,
    balances: {
      [W.kai]: [
        { coinType: "0x2::sui::SUI", balance: "2500000000" },
        { coinType: USDC, balance: "860000000" },
        { coinType: MIGR, balance: "4000000000000" },
        { coinType: SPAM, balance: "1" },
      ],
    },
    executedBy: new Map(),
    async listBalances({ owner, cursor }) {
      if (fullnode.mode === "down") throw new Error("UNAVAILABLE");
      const all = fullnode.balances[owner] ?? [];
      // Two pages: the first two balances, then the rest.
      return cursor === null || cursor === undefined
        ? { balances: all.slice(0, 2), hasNextPage: all.length > 2, cursor: all.length > 2 ? "page-2" : null }
        : { balances: all.slice(2), hasNextPage: false, cursor: null };
    },
    async getBalance({ owner, coinType }) {
      if (fullnode.mode === "down") throw new Error("UNAVAILABLE");
      const atoms = (fullnode.balances[owner] ?? [])
        .filter((entry) => normalizeStructTag(entry.coinType) === coinType)
        .reduce((sum, entry) => sum + BigInt(entry.balance), 0n);
      return { balance: { balance: atoms.toString() } };
    },
    async executed(digest) {
      fullnode.lookups += 1;
      return fullnode.executedBy.get(digest) ?? null;
    },
  };
  return fullnode;
}

type Fixture = Readonly<{
  admin: Pool;
  fullnode: Stub;
  wallet(headers?: Record<string, string>, query?: string): Promise<Response>;
  transfer(id: string, body: unknown, headers?: Record<string, string>): Promise<Response>;
}>;

async function withFixture(run: (fixture: Fixture) => Promise<void>): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  await seedFeedStory(admin, { nowMs: NOW });
  await seedChainRead(admin, {
    prices: [
      { coin_type: SUI, usd_price: "3.42", as_of_ms: NOW - 10_000, source: "pyth" },
      { coin_type: MIGR, usd_price: "0.21", as_of_ms: NOW - 5_000, source: "pool" },
    ],
  });
  const webPool = createRuntimePool(urlAs(database.url, "blast_web"), POOL, "social-coins-web");
  try {
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
      walletSessions: { live: async (token) => (token === WALLET_COOKIE_TOKEN ? { address: W.kai } : null) },
      primary: () => webPool,
    });
    const fullnode = stub();
    const primary = autocommitReader(webPool, "social");
    const routes = createSocialCoinsRoutes({
      // Fixture digests are labels; provenance itself is covered with genuine bytes.
      verifyProvenance: async () => {},
      kit,
      database: () => primary,
      fullnode: () => fullnode,
      transactions: () => fullnode,
      blastWallet: async (caller) => (caller.kind === "privy" ? (EMBEDDED[caller.did] ?? null) : caller.address),
      now: () => NOW,
      fullnodeTimeoutMs: 300,
    });
    const base = { "x-forwarded-for": "203.0.113.14" };
    await run({
      admin,
      fullnode,
      wallet: (headers = {}, query = "") => routes.wallet(new Request(`${ORIGIN}/api/social/me/wallet${query}`, { headers: { ...base, ...headers } }), testClient()),
      transfer: (id, body, headers = {}) =>
        routes.transfer(new Request(`${ORIGIN}/api/social/me/transfers/${id}`, {
          method: "PUT",
          headers: { ...base, origin: ORIGIN, "content-type": "application/json", ...headers },
          body: typeof body === "string" ? body : JSON.stringify(body),
        }), testClient()),
    });
  } finally {
    await Promise.all([admin.end(), webPool.end()]);
    await database.drop();
  }
}

async function answer<Body>(response: Response, status: number, schema: "wallet-coins-response" | "transfer-response"): Promise<Body> {
  const body: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  assert.deepEqual(validator.validate(schema, body).errors, []);
  assert.equal(response.headers.get("cache-control"), PRIVATE);
  return body as Body;
}

async function refused(response: Response, status: number, code: string): Promise<Record<string, unknown>> {
  const body = (await response.json()) as { error: Record<string, unknown> };
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(body.error.code, code);
  assert.deepEqual(validator.validate("error", body).errors, []);
  assert.equal(response.headers.get("cache-control"), PRIVATE);
  return body.error;
}

const withdrawal = (overrides: Record<string, unknown> = {}) => ({ coin_type: USDC, amount: "100000000", recipient: RECIPIENT, ...overrides });

test("UI-14: the Blast wallet: its address, the sponsor pays, USDC and SUI always, all held coins by value, including unknown metadata", { skip }, async () => {
  await withFixture(async ({ wallet }) => {
    const kai = await answer<SocialWallet>(await wallet({ authorization: KAI }), 200, "wallet-coins-response");
    assert.equal(kai.address, W.kai);
    assert.equal(kai.signer, "privy");
    assert.equal(kai.fee, "sponsored");
    assert.deepEqual(kai.coins?.map((coin) => [coin.symbol, coin.atoms, coin.usd_price, coin.value_usd]), [
      ["USDC", "860000000", "1", "860.00"],
      ["SUI", "2500000000", "3.42", "8.55"],
      ["MIGR", "4000000000000", "0.21", "840.00"],
      ["SPAM", "1", null, null],
      ["USDsui", "0", null, "0.00"],
    ]);
    const migr = kai.coins?.[2];
    assert.equal(migr?.coin_type, MIGR);
    assert.equal(migr?.name, "Migr");
    assert.equal(migr?.decimals, 9);
    assert.equal(migr?.icon_url, "https://i.blast.test/migr.png");
    assert.deepEqual({ ...migr?.presale, multiple: null }, { presale_id: FEED_STORY_PRESALES.migratedRecently, venue: "cetus", trading: true, multiple: null });
    assert.equal(kai.coins?.[3]?.decimals, null, "unknown metadata does not drop a holding or invent decimals");

    // A wallet session's Blast wallet is its own address, and Blast pays its fees too.
    const session = await answer<SocialWallet>(
      await wallet({ cookie: `${SOCIAL_WALLET_SESSION_COOKIE}=${WALLET_COOKIE_TOKEN}`, "sec-fetch-site": "same-origin" }),
      200,
      "wallet-coins-response",
    );
    assert.deepEqual([session.address, session.signer, session.fee], [W.kai, "wallet", "sponsored"]);
  });
});

test("the wallet lists indexed WAL and DEEP and every unknown holding, including more than 64 coins", { skip }, async () => {
  await withFixture(async ({ wallet, admin, fullnode }) => {
    const wal = `0x${"8".repeat(64)}::wal::WAL`;
    const deep = `0x${"9".repeat(64)}::deep::DEEP`;
    await admin.query(`INSERT INTO blast_infra_fixture.coin_metadata (coin_type, name, symbol, decimals, icon_url)
      VALUES ($1, 'Walrus', 'WAL', 6, 'https://i.blast.test/wal.png'), ($2, 'DeepBook', 'DEEP', 9, NULL)`, [wal, deep]);
    const extra = [
      { coinType: wal, balance: "12345678" },
      { coinType: deep, balance: "9000000000" },
      ...Array.from({ length: 70 }, (_, i) => ({ coinType: `0x${(i + 128).toString(16).padStart(64, "0")}::coin::TOKEN`, balance: "1" })),
    ];
    fullnode.balances[W.kai]!.push(...extra);
    const body = await answer<SocialWallet>(await wallet({ authorization: KAI }), 200, "wallet-coins-response");
    assert.equal(body.coins?.length, 77);
    for (const holding of extra) assert.ok(body.coins?.some((coin) => coin.coin_type === holding.coinType && coin.atoms === holding.balance));
    const walCoin = body.coins?.find((coin) => coin.coin_type === wal);
    assert.deepEqual([walCoin?.name, walCoin?.decimals, walCoin?.presale, walCoin?.icon_url], ["Walrus", 6, null, "https://i.blast.test/wal.png"]);
    const deepCoin = body.coins?.find((coin) => coin.coin_type === deep);
    assert.deepEqual([deepCoin?.symbol, deepCoin?.decimals, deepCoin?.usd_price, deepCoin?.value_usd], ["DEEP", 9, null, null]);
  });
});

test("UI-14: no embedded wallet yet is an address of null; a fullnode outage is coins null; 401 and 409 as published", { skip }, async () => {
  await withFixture(async ({ wallet, fullnode }) => {
    const nova = await answer<SocialWallet>(await wallet({ authorization: NOVA }), 200, "wallet-coins-response");
    assert.deepEqual([nova.address, nova.coins], [null, null]);
    fullnode.mode = "down";
    const down = await answer<SocialWallet>(await wallet({ authorization: KAI }), 200, "wallet-coins-response");
    assert.deepEqual([down.address, down.coins], [W.kai, null]);
    await refused(await wallet(), 401, "unauthorized");
    await refused(await wallet({ authorization: STRANGER }), 409, "account_required");
  });
});

test("UI-14: a withdrawal is recorded once per request id; a repeat is the same; a different body is 409 with the recorded one", { skip }, async () => {
  await withFixture(async ({ transfer, admin }) => {
    const id = randomUUID();
    const created = await answer<SocialTransfer>(await transfer(id, withdrawal(), { authorization: KAI }), 201, "transfer-response");
    assert.deepEqual([created.status, created.fee, created.digest, created.failure], ["pending", "sponsored", null, null]);
    const again = await answer<SocialTransfer>(await transfer(id, withdrawal(), { authorization: KAI }), 200, "transfer-response");
    assert.deepEqual(again, created);
    const conflict = await refused(await transfer(id, withdrawal({ amount: "200000000" }), { authorization: KAI }), 409, "transfer_conflict");
    assert.deepEqual(conflict.transfer, created);
    // Another account cannot read or reuse the id.
    await refused(await transfer(id, withdrawal(), { authorization: MALLORY }), 404, "not_found");
    const { rows } = await admin.query("SELECT count(*)::int AS n, min(sender) AS sender FROM social_coin_transfers");
    assert.deepEqual(rows[0], { n: 1, sender: W.kai });
  });
});

test("UI-14: a digest settles the withdrawal against the fullnode: 202 until visible, then confirmed once; mismatches and aborts fail", { skip }, async () => {
  await withFixture(async ({ transfer, fullnode }) => {
    const id = randomUUID();
    await answer(await transfer(id, withdrawal(), { authorization: KAI }), 201, "transfer-response");
    const waiting = await answer<SocialTransfer>(await transfer(id, withdrawal({ digest: DIGEST }), { authorization: KAI }), 202, "transfer-response");
    assert.deepEqual([waiting.status, waiting.digest], ["submitted", DIGEST]);

    fullnode.executedBy.set(DIGEST, {
      success: true,
      sender: W.kai,
      balanceChanges: [
        { address: W.kai, coinType: USDC, amount: "-100000000" },
        { address: RECIPIENT, coinType: USDC, amount: "100000000" },
      ],
    });
    const confirmed = await answer<SocialTransfer>(await transfer(id, withdrawal({ digest: DIGEST }), { authorization: KAI }), 200, "transfer-response");
    assert.equal(confirmed.status, "confirmed");
    assert.ok(confirmed.settled_at_ms !== null);
    const lookups = fullnode.lookups;
    assert.equal((await answer<SocialTransfer>(await transfer(id, withdrawal({ digest: DIGEST }), { authorization: KAI }), 200, "transfer-response")).status, "confirmed");
    assert.equal(fullnode.lookups, lookups, "a settled withdrawal reads the fullnode no more");
    // A recorded digest is never replaced, and no other withdrawal may claim it.
    await refused(await transfer(id, withdrawal({ digest: OTHER_DIGEST }), { authorization: KAI }), 409, "transfer_conflict");
    await refused(await transfer(randomUUID(), withdrawal({ digest: DIGEST }), { authorization: KAI }), 409, "transfer_conflict");

    // A transaction that moved another amount is not this withdrawal; an aborted one failed.
    const short = randomUUID();
    fullnode.executedBy.set(OTHER_DIGEST, { success: true, sender: W.kai, balanceChanges: [{ address: RECIPIENT, coinType: USDC, amount: "99" }] });
    const mismatch = await answer<SocialTransfer>(await transfer(short, withdrawal({ digest: OTHER_DIGEST }), { authorization: KAI }), 201, "transfer-response");
    assert.deepEqual([mismatch.status, mismatch.failure], ["failed", "mismatch"]);
    const aborted = randomUUID();
    const abortedDigest = "3dGmKpXv3uRbT7wYc2LhNq5sDfE8jZa4oiP6Bt1Vy3nW";
    fullnode.executedBy.set(abortedDigest, { success: false, sender: W.kai, balanceChanges: [] });
    const failed = await answer<SocialTransfer>(await transfer(aborted, withdrawal({ digest: abortedDigest }), { authorization: KAI }), 201, "transfer-response");
    assert.deepEqual([failed.status, failed.failure], ["failed", "execution_failed"]);
  });
});

test("UI-14: refusals: a malformed id or body, the Blast wallet as recipient, no Blast wallet, no sign-in", { skip }, async () => {
  await withFixture(async ({ transfer }) => {
    await refused(await transfer("not-a-uuid", withdrawal(), { authorization: KAI }), 400, "invalid_parameter");
    for (const body of [
      withdrawal({ amount: "0" }),
      withdrawal({ amount: "18446744073709551616" }),
      withdrawal({ amount: "1.5" }),
      withdrawal({ recipient: RECIPIENT.toUpperCase().replace("0X", "0x") }),
      withdrawal({ recipient: "0xa3" }),
      withdrawal({ coin_type: "0x2::sui::SUI" }),
      withdrawal({ digest: "not-a-digest" }),
      { ...withdrawal(), extra: true },
      "not json",
    ]) {
      await refused(await transfer(randomUUID(), body, { authorization: KAI }), 400, "invalid_request");
    }
    await refused(await transfer(randomUUID(), withdrawal({ recipient: W.kai }), { authorization: KAI }), 422, "invalid_recipient");
    await refused(await transfer(randomUUID(), withdrawal(), { authorization: NOVA }), 409, "blast_wallet_missing");
    await refused(await transfer(randomUUID(), withdrawal()), 401, "unauthorized");
    // A wallet session's withdrawal is sponsored too.
    const own = await answer<SocialTransfer>(
      await transfer(randomUUID(), withdrawal(), { cookie: `${SOCIAL_WALLET_SESSION_COOKIE}=${WALLET_COOKIE_TOKEN}`, "sec-fetch-site": "same-origin" }),
      201,
      "transfer-response",
    );
    assert.equal(own.fee, "sponsored");
  });
});

test("wallet lists page and search all balances, filter exact dust, and retain authentication", { skip }, async () => {
  await withFixture(async ({ wallet, fullnode }) => {
    const extras = Array.from({ length: 100 }, (_, i) => ({ coinType: `0x${(i + 512).toString(16).padStart(64, "0")}::coin::TOKEN`, balance: "1" }));
    fullnode.balances[W.kai]!.push(...extras);
    const headers = { authorization: KAI };
    const full = await answer<SocialWallet>(await wallet(headers), 200, "wallet-coins-response");
    const page = await answer<SocialWallet>(await wallet(headers, "?page=1&hide_small=true"), 200, "wallet-coins-response");
    assert.equal(page.coins?.length, 20);
    assert.ok(page.listing!.total > 100, "unknown metadata cannot be classified as dust");
    assert.ok(JSON.stringify(page).length < JSON.stringify(full).length / 3);
    const unseen = extras.at(-1)!;
    const match = await answer<SocialWallet>(await wallet(headers, `?page=99&hide_small=true&q=${encodeURIComponent(unseen.coinType)}`), 200, "wallet-coins-response");
    assert.equal(match.listing?.page, 1);
    assert.equal(match.coins?.[0]?.coin_type, unseen.coinType);
    fullnode.balances[W.kai]!.find(coin => coin.coinType === USDC)!.balance = "999999";
    const hidden = await answer<SocialWallet>(await wallet(headers, "?page=1&hide_small=true&q=USDC"), 200, "wallet-coins-response");
    assert.equal(hidden.listing?.total, 1, "preferred coins stay visible below one token");
    assert.equal(hidden.listing?.extra_coins.find(coin => coin.coin_type === USDC)?.atoms, "999999", "common deposit shortcuts retain their exact balance");
    const shown = await answer<SocialWallet>(await wallet(headers, "?page=1&hide_small=false&q=USDC"), 200, "wallet-coins-response");
    assert.equal(shown.coins?.[0]?.atoms, "999999");
    await refused(await wallet({}, "?page=1"), 401, "unauthorized");
    await refused(await wallet(headers, "?page=1&hide_small=1"), 400, "invalid_parameter");
  });
});


test("Swap wallet listing hides TSUI, its presales, and its curves before search and pagination", { skip }, async () => {
  await withFixture(async ({ admin, wallet, fullnode }) => {
    const curve = `0x${"cd".repeat(32)}::coin::TEST_CURVE`;
    await admin.query("UPDATE blast_infra_fixture.presales SET quote_type = $1 WHERE sale_token = $2", [CREATE_TEST_SUI_QUOTE_TYPE, MIGR]);
    await admin.query(
      "INSERT INTO pools (pool_key, venue, coin_type, quote_type, lifecycle, created_checkpoint, created_at_ms) VALUES ($1, 'blast_curve', $2, $3, 'migrated', 900, $4)",
      [`blast_curve:0x${"ef".repeat(32)}`, curve, CREATE_TEST_SUI_QUOTE_TYPE, NOW],
    );
    fullnode.balances[W.kai]!.push({ coinType: curve, balance: "100" }, { coinType: CREATE_TEST_SUI_QUOTE_TYPE, balance: "100" });
    const headers = { authorization: KAI };
    const read = async (query: string) => answer<SocialWallet>(await wallet(headers, query), 200, "wallet-coins-response");
    const regular = await read(`?page=1&key=${encodeURIComponent(curve)}`);
    const swap = await read(`?page=1&hide_test_markets=true&key=${encodeURIComponent(curve)}`);
    assert.equal(regular.coins?.filter(coin => [MIGR, curve, CREATE_TEST_SUI_QUOTE_TYPE].includes(coin.coin_type)).length, 3);
    assert.deepEqual(swap.coins?.map(coin => coin.coin_type).sort(), [SUI, USDC, SPAM, CREATE_USDSUI_QUOTE_TYPE].sort());
    assert.equal(swap.listing?.total, 4);
    assert.equal(swap.listing?.extra_coins.some(coin => coin.coin_type === curve), false);
    const exact = await read(`?page=1&hide_test_markets=true&q=${encodeURIComponent(MIGR)}`);
    assert.deepEqual(exact.coins, []);
  });
});

test("an empty wallet still offers all three preferred coins with exact zero balances", { skip }, async () => {
  await withFixture(async ({ wallet, fullnode }) => {
    fullnode.balances[W.kai] = [];
    const result = await answer<SocialWallet>(await wallet({ authorization: KAI }), 200, "wallet-coins-response");
    assert.deepEqual(result.coins?.map(coin => coin.symbol).sort(), ["SUI", "USDC", "USDsui"].sort());
    for (const coin of result.coins ?? []) {
      assert.equal(coin.atoms, "0");
      assert.equal(coin.value_usd, "0.00");
      assert.ok(coin.decimals !== null);
    }
  });
});
