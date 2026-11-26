import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import type { Pool } from "pg";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { seedChainRead, type ChainActivityRow, type ChainPresaleRow } from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { advanceWatermark, urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader, type ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { PresaleTerms, PresaleTermsReader } from "@blast/core/modules/presale/terms/index.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { createSocialConfigReader } from "@blast/core/modules/social/config/reader.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import {
  HOME_PAGE_DEFAULT,
  HOME_THREAD_PAGE,
  type HomeCoin,
  type HomeCoinsByIds,
  type HomeCoinsPage,
  type HomeDiscussionPage,
  type HomeFollowingResponse,
  type HomeThreadPage,
  type HomeTradersPage,
} from "@blast/core/modules/social/contracts/home.ts";
import { homeCoinsPageReadSchema } from "@blast/core/modules/social/contracts/home-read-schemas.ts";
import type { HomeCoinMarket, HomeHoldersPage } from "@blast/core/modules/social/contracts/coin-market.ts";
import { CREATE_TEST_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { INDEXED_POOL_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { readCoinFacts, type HomeDiscoverBase } from "@blast/server/modules/social/home/coins.ts";
import { createSocialHomeRoutes, type SocialHomeRouteDependencies } from "@blast/server/modules/social/home/route.ts";
import { optionalSource } from "@blast/server/modules/social/optional-source.ts";
import type { TraderPortfolioRead } from "@blast/server/modules/social/home/traders.ts";
import { readPrices } from "@blast/server/modules/social/prices/route.ts";
import { createReadCache } from "@blast/server/modules/social/read-cache.ts";
import { createPublicPresaleReader } from "@blast/server/modules/social/presales/public-reads.ts";
import { hex, uuid } from "../../../../../core/test/kit.ts";

/**
 * The coin-centred Home over a disposable database with the fixture
 * `chain_read_v1`: one story holds a coin with every kind of participant
 * (an account with two wallets that buys and sells, a seller, a widely
 * followed buyer, a private account, a wallet named too late, an anonymous
 * wallet with a split event, a row past the window, one in the future and one
 * past the watermark), a coin one account trades four times, a quiet coin, a
 * crowd of 23 wallets, an open presale, an Aftermath sale without a pool, and
 * the two hidden sales (T-043's excluded sale; a sale without metadata). The
 * public routes read as `blast_replica`; the Following route as `blast_web`
 * through the kit, as in production. Every answer is checked against its
 * published schema.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-home-app";
const PEPPER = "social-home-fixture-pepper-0123456789abcdef";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 8, statementTimeoutMs: 10_000 };
const PUBLIC = "public, s-maxage=10, stale-while-revalidate=20";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const QUOTE = `${hex("dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7")}::usdc::USDC`;
const SUI = `${hex("2")}::sui::SUI`;
const P = { orbit: hex("0b17"), eman: hex("e3a4"), quiet: hex("c01e7"), crowd: hex("c204d"), halo: hex("4a10"), after: hex("af7e"), excluded: hex("e2"), incomplete: hex("e1") } as const;
const coinOf = (id: string, symbol: string) => `${id}::coin::${symbol}`;
const W = {
  mayaA: hex("aa01"), mayaB: hex("aa02"), leo: hex("aa03"), jules: hex("aa04"), priv: hex("aa05"), late: hex("aa06"), anon: hex("bb01"),
  satoshi: hex("aa07"), cy: hex("aa08"), ben: hex("aa09"), solo: hex("aa10"),
} as const;
const A = { maya: uuid(1), leo: uuid(2), jules: uuid(3), priv: uuid(4), late: uuid(5), satoshi: uuid(6), cy: uuid(7), ben: uuid(8), solo: uuid(9) } as const;
const did = (callsign: string) => `did:privy:home-${callsign}`;

function bearer(subject: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: subject });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}

function presale(id: string, symbol: string, lifecycle: ChainPresaleRow["lifecycle"], row: Partial<ChainPresaleRow>): ChainPresaleRow {
  return {
    presale_id: id, sale_token: coinOf(id, symbol), quote_type: QUOTE, sale_symbol: symbol, sale_name: `Sale ${symbol}`,
    sale_icon_url: `https://cdn.blast.fun/${symbol}.png`, sale_decimals: 9, quote_symbol: "USDC", quote_decimals: 6, lifecycle,
    start_ms: 0, end_ms: 0, raise_target: "100000000000", min_commitment: "10000000", wallet_cap: null, total_commitments: "100000000000",
    participants: 0, venue: "cetus", pool_id: hex("9001"), updated_checkpoint: 1, ...row,
  };
}

let checkpoint = 50_000;
function activity(kind: string, actor: string, sale: { id: string; symbol: string } | null, at: number, row: Partial<ChainActivityRow> = {}): ChainActivityRow {
  checkpoint += 1;
  const trade = kind.startsWith("trade");
  return {
    checkpoint, tx_slot: 0, event_slot: 0, part: 0, timestamp_ms: at, digest: `Hm${checkpoint}`.padEnd(44, "3"), kind,
    product: trade ? "market" : "presale", actor, tx_sender: actor,
    presale_id: trade ? null : sale?.id ?? null, coin_type: sale ? coinOf(sale.id, sale.symbol) : null,
    quote_type: QUOTE, quote_amount: "0", coin_amount: null, quote_refund: null, usd_value: null, usd_price_as_of_ms: null, venue: trade ? "cetus" : null,
    participants_after: null, total_commitments_after: null, ...row,
  };
}
const ORBIT = { id: P.orbit, symbol: "ORBIT" };
const EMAN = { id: P.eman, symbol: "EMAN" };
const QUIET = { id: P.quiet, symbol: "QUIET" };
const CROWD = { id: P.crowd, symbol: "CROWD" };
const HALO = { id: P.halo, symbol: "HALO" };
const buy = (actor: string, sale: { id: string; symbol: string }, dollars: number, at: number, row: Partial<ChainActivityRow> = {}) =>
  activity("trade_buy", actor, sale, at, { quote_amount: String(Math.round(dollars * 1e6)), usd_value: dollars.toFixed(2), coin_amount: String(Math.round(dollars * 20) * 1e9), ...row });
const sell = (actor: string, sale: { id: string; symbol: string }, dollars: number, at: number, row: Partial<ChainActivityRow> = {}) =>
  activity("trade_sell", actor, sale, at, { quote_amount: String(Math.round(dollars * 1e6)), usd_value: dollars.toFixed(2), coin_amount: String(Math.round(dollars * 20) * 1e9), ...row });
const commit = (actor: string, sale: { id: string; symbol: string }, dollars: number, at: number) =>
  activity("presale_commit", actor, sale, at, { quote_amount: String(Math.round(dollars * 1e6)), usd_value: dollars.toFixed(2) });

const terms: PresaleTermsReader = (presaleId) => optionalSource("presale_terms", async () => {
  if (presaleId === P.orbit) return { presaleId, supply: { total: "1000000000000000" }, burnable: false } as unknown as PresaleTerms;
  if (presaleId === P.eman) throw new Error("projection down");
  return null;
}, null);

type Fixture = Readonly<{
  admin: Pool;
  now: number;
  replica: ReadableDatabase;
  discover(query?: string, options?: Readonly<{ trades?: boolean; headers?: Record<string, string> }>): Promise<Response>;
  coins(query: string, options?: Readonly<{ trades?: boolean }>): Promise<Response>;
  thread(query: string): Promise<Response>;
  market(query: string): Promise<Response>;
  holders(query: string): Promise<Response>;
  discussion(query: string): Promise<Response>;
  traders(query?: string, options?: Readonly<{ trades?: boolean }>): Promise<Response>;
  following(callsign: string | null, body: unknown, query?: string): Promise<Response>;
  ids: Readonly<{ mayaBuy1: string; leoSell: string; cyQuietBuy: string }>;
  /** Empties this process's caches, as another API process starts: the fleet-wide tier stays. */
  forget(): void;
}>;

async function withFixture(run: (fixture: Fixture) => Promise<void>, options: Readonly<{
  elapsedMs?: () => number;
  cached?: boolean;
  trackedPoolMarket?: (now: number) => ReturnType<NonNullable<SocialHomeRouteDependencies["trackedPoolMarket"]>>;
  trackedPoolLaunches?: SocialHomeRouteDependencies["trackedPoolLaunches"];
}> = {}): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  const now = Date.now();
  checkpoint = 50_000;
  const mayaBuy1 = buy(W.mayaA, ORBIT, 40, now - 50 * MINUTE);
  const leoSell = sell(W.leo, ORBIT, 40, now - 9 * MINUTE);
  const cyQuietBuy = buy(W.cy, QUIET, 5, now - 30 * HOUR);
  const split = activity("trade_buy", W.anon, ORBIT, now - 20 * MINUTE, { tx_slot: 7, event_slot: 1, part: 0, quote_amount: "3000000", usd_value: "3.00", coin_amount: "60000000000" });
  const rows: ChainActivityRow[] = [
    mayaBuy1,
    buy(W.mayaA, ORBIT, 30, now - 30 * MINUTE),
    buy(W.mayaB, ORBIT, 30, now - 4 * MINUTE),
    sell(W.mayaA, ORBIT, 25, now - 2 * MINUTE),
    leoSell,
    buy(W.jules, ORBIT, 250, now - 12 * MINUTE),
    buy(W.priv, ORBIT, 7, now - 15 * MINUTE),
    buy(W.late, ORBIT, 8, now - 16 * MINUTE),
    split,
    { ...split, checkpoint: split.checkpoint, part: 1, quote_amount: "2000000", usd_value: "2.00", coin_amount: "40000000000" },
    buy(W.anon, ORBIT, 1, now - 25 * HOUR),
    buy(W.anon, ORBIT, 999, now + 5 * MINUTE),
    // Stamped with the sale, as T-038 writes trades; ORBIT's are the older unstamped rows.
    ...[0, 1, 2, 3].map((n) => buy(W.satoshi, EMAN, 100 + n, now - (3 - n) * HOUR - 10 * MINUTE, { presale_id: P.eman })),
    activity("presale_claim", W.satoshi, EMAN, now - 2 * HOUR, { coin_amount: "500000000000", quote_refund: "0" }),
    cyQuietBuy,
    ...Array.from({ length: 23 }, (_, n) => buy(hex(`cc${n.toString(16).padStart(2, "0")}`), CROWD, 10 + n, now - (23 - n) * MINUTE)),
    commit(W.mayaA, HALO, 100, now - 40 * MINUTE),
    commit(W.mayaB, HALO, 50, now - 35 * MINUTE),
    commit(W.anon, HALO, 20, now - 30 * MINUTE),
    buy(W.anon, { id: P.excluded, symbol: "HID" }, 5000, now - 5 * MINUTE),
    buy(W.anon, { id: P.incomplete, symbol: "INC" }, 5000, now - 5 * MINUTE),
  ];
  const marketCheckpoint = checkpoint;
  // The bucket wholly before the 24 h mark, so the price at that instant is the real bucket's.
  const bucket = Math.floor((now - DAY - 5 * MINUTE) / 300_000) * 300_000;
  // One trade the market pipeline has not committed yet: past the watermark, never counted.
  rows.push(buy(W.anon, ORBIT, 12345, now - MINUTE));
  // The sharing account's wallets are synced (the profile's P&L needs the history complete); the others stay unsynced.
  await admin.query("INSERT INTO blast_infra_fixture.wallet_sync(owner, timestamp_ms) VALUES ($1, $3), ($2, $3) ON CONFLICT DO NOTHING", [W.mayaA, W.mayaB, now]);
  await seedChainRead(admin, {
    presales: [
      presale(P.orbit, "ORBIT", "migrated", { start_ms: now - 4 * DAY, end_ms: now - 3 * DAY }),
      presale(P.eman, "EMAN", "migrated", { start_ms: now - 12 * DAY, end_ms: now - 11 * DAY, venue: "bluefin" }),
      presale(P.quiet, "QUIET", "migrated", { start_ms: now - 42 * DAY, end_ms: now - 41 * DAY }),
      presale(P.crowd, "CROWD", "migrated", { start_ms: now - 6 * DAY, end_ms: now - 5 * DAY }),
      presale(P.halo, "HALO", "open", { start_ms: now - DAY, end_ms: now + 2 * HOUR, total_commitments: "170000000", participants: 3 }),
      presale(P.after, "AFTR", "migrated", { start_ms: now - 9 * DAY, end_ms: now - 8 * DAY, venue: "aftermath", pool_id: null }),
      presale(P.incomplete, "INC", "migrated", { sale_symbol: null, sale_name: null, sale_icon_url: null, sale_decimals: null }),
    ],
    presale_lifecycle: [
      { presale_id: P.orbit, state: "opened", digest: "Op1".padEnd(44, "4"), timestamp_ms: now - 4 * DAY, checkpoint: 40_001 },
      { presale_id: P.orbit, state: "migrated", digest: "Mg1".padEnd(44, "4"), timestamp_ms: now - 2 * DAY, checkpoint: 40_002 },
      { presale_id: P.eman, state: "migrated", digest: "Mg2".padEnd(44, "4"), timestamp_ms: now - 10 * DAY, checkpoint: 40_003 },
      { presale_id: P.quiet, state: "migrated", digest: "Mg3".padEnd(44, "4"), timestamp_ms: now - 40 * DAY, checkpoint: 40_004 },
      { presale_id: P.crowd, state: "migrated", digest: "Mg4".padEnd(44, "4"), timestamp_ms: now - 5 * DAY, checkpoint: 40_005 },
      { presale_id: P.after, state: "migrated", digest: "Mg5".padEnd(44, "4"), timestamp_ms: now - 8 * DAY, checkpoint: 40_006 },
      { presale_id: P.halo, state: "opened", digest: "Op6".padEnd(44, "4"), timestamp_ms: now - DAY, checkpoint: 40_007 },
    ],
    prices: [
      { coin_type: QUOTE, usd_price: "1", as_of_ms: now, source: "pyth" },
      { coin_type: SUI, usd_price: "3.5", as_of_ms: now, source: "pyth" },
      { coin_type: coinOf(P.orbit, "ORBIT"), usd_price: "0.05", as_of_ms: now - 10_000, source: "pool" },
      // A quiet pool retains its last observed price and timestamp.
      { coin_type: coinOf(P.eman, "EMAN"), usd_price: "0.2", as_of_ms: now - 10 * MINUTE, source: "pool" },
      { coin_type: coinOf(P.crowd, "CROWD"), usd_price: "0.01", as_of_ms: now, source: "pool" },
    ],
    price_history: [
      { coin_type: coinOf(P.orbit, "ORBIT"), resolution: "5m", bucket_ms: bucket, usd_price: "0.04", as_of_ms: bucket + MINUTE, source: "pool" },
    ],
    // The biggest holders of ORBIT: jules; maya's two wallets as one; the pool (excluded); an anonymous dust holder.
    coin_balances: [
      { coin_type: coinOf(P.orbit, "ORBIT"), owner: W.jules, balance: "5000000000000", updated_checkpoint: 45_000 },
      { coin_type: coinOf(P.orbit, "ORBIT"), owner: W.mayaA, balance: "1000000000000", updated_checkpoint: 45_000 },
      { coin_type: coinOf(P.orbit, "ORBIT"), owner: W.mayaB, balance: "500000000000", updated_checkpoint: 45_000 },
      { coin_type: coinOf(P.orbit, "ORBIT"), owner: hex("9001"), balance: "100000000000000", updated_checkpoint: 45_000 },
      { coin_type: coinOf(P.orbit, "ORBIT"), owner: W.anon, balance: "60000000000", updated_checkpoint: 45_000 },
      ...Array.from({ length: 12 }, (_, index) => ({ coin_type: coinOf(P.orbit, "ORBIT"), owner: hex(`f${(index + 1).toString(16).padStart(3, "0")}`), balance: (BigInt(index + 1) * 1_000_000_000n).toString(), updated_checkpoint: 45_000 })),
    ],
    coin_holder_history: [
      { coin_type: coinOf(P.orbit, "ORBIT"), checkpoint: 40_002, timestamp_ms: now - 2 * DAY, holders: 10 },
      { coin_type: coinOf(P.orbit, "ORBIT"), checkpoint: 45_000, timestamp_ms: now - HOUR, holders: 42 },
      // The crowd's 23 buyers are 23 new holders since yesterday.
      { coin_type: coinOf(P.crowd, "CROWD"), checkpoint: 40_005, timestamp_ms: now - 5 * DAY, holders: 0 },
      { coin_type: coinOf(P.crowd, "CROWD"), checkpoint: 45_001, timestamp_ms: now - MINUTE, holders: 23 },
    ],
    activity: rows,
  });
  await admin.query(advanceWatermark(marketCheckpoint, 0, "market"));
  await admin.query(advanceWatermark(checkpoint, 0, "presale"));
  const since = new Date(now - 400 * DAY).toISOString();
  const people: readonly [string, string, readonly string[], "public" | "private", string | null][] = [
    ["maya", A.maya, [W.mayaA, W.mayaB], "public", since],
    ["leo", A.leo, [W.leo], "public", since],
    ["jules", A.jules, [W.jules], "public", since],
    ["priv", A.priv, [W.priv], "private", null],
    ["late", A.late, [W.late], "public", new Date(now - 10 * MINUTE).toISOString()],
    ["satoshi", A.satoshi, [W.satoshi], "public", since],
    ["cyra", A.cy, [W.cy], "public", since],
    ["ben", A.ben, [W.ben], "public", since],
    ["solo", A.solo, [W.solo], "public", since],
  ];
  for (const [callsign, id, wallets, privacy, sharing] of people) {
    await admin.query(
      `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, x_subject, x_handle, x_avatar_url, privacy, sharing_since, onboarded_at)
       VALUES ($1, $2, $3, $4, $5, $3, NULL, $6, $7, $8)`,
      [id, did(callsign), callsign, `Name ${callsign}`, `x-${callsign}`, privacy, sharing, since],
    );
    for (const wallet of wallets) await admin.query("INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, $3)", [wallet, id, since]);
  }
  // Maya shares her portfolio; nobody else does.
  await admin.query("UPDATE social_accounts SET portfolio_public = true WHERE account_id = $1", [A.maya]);
  // Jules is widely followed (by everyone but solo); ben follows maya, leo and cyra too; solo follows nobody.
  await admin.query(
    `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source)
     SELECT a.account_id, 'account', $1, 'user' FROM social_accounts a WHERE a.callsign NOT IN ('jules', 'solo')`,
    [A.jules],
  );
  await admin.query(
    `INSERT INTO social_follows (follower_account_id, target_kind, target_id, source) VALUES ($1::uuid, 'account', $2, 'user'), ($1::uuid, 'account', $3, 'user'), ($1::uuid, 'account', $4, 'user')`,
    [A.ben, A.maya, A.leo, A.cy],
  );
  const entryOf = (row: ChainActivityRow) => `a:${row.checkpoint}:${row.tx_slot}:${row.event_slot}:${row.part}`;
  await admin.query(
    `INSERT INTO social_whys (why_id, entry_id, author_account_id, text, created_at) VALUES
     ($1, $2, $3, 'In for the pool depth.', now() - interval '45 minutes'),
     ($4, $5, $6, 'Taking profit here.', now() - interval '8 minutes'),
     ($7, $8, $9, 'Still like QUIET long term.', now() - interval '10 minutes')`,
    [uuid(0x100), entryOf(mayaBuy1), A.maya, uuid(0x101), entryOf(leoSell), A.leo, uuid(0x102), entryOf(cyQuietBuy), A.cy],
  );

  const replicaPool = createRuntimePool(urlAs(database.url, "blast_replica"), POOL, "social-home-replica");
  const webPool = createRuntimePool(urlAs(database.url, "blast_web"), POOL, "social-home-web");
  try {
    const replica = autocommitReader(replicaPool, "social");
    const reader = createSocialConfigReader(autocommitReader(webPool, "social"), { now: () => 0 });
    const accounts = new PostgresSocialAccounts(() => webPool);
    // Two kits: trades shown, and hidden as for an outsider while trading is off.
    const kitWith = (trading: boolean) => createSocialRouteKit({
      tradingVisible: () => trading,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({ appId: APP_ID, verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString() }),
      limiter: new PostgresRateLimitEnforcer({ pool: webPool, subjectPepper: PEPPER }),
      accounts,
      primary: () => webPool,
    });
    // The traders' P&L reads the profile's ledger on the primary with every linked wallet's indexed trades.
    const readNow = () => now + (options.elapsedMs?.() ?? 0);
    const caches = options.cached ? {
      discover: createReadCache<HomeCoinsPage>(10_000, 64, readNow),
      discoverBase: createReadCache<HomeDiscoverBase>(10_000, 6, readNow),
      coins: createReadCache<HomeCoinsByIds>(10_000, 64, readNow),
      portfolios: createReadCache<ReadonlyMap<string, TraderPortfolioRead>>(10_000, 64, readNow),
    } : undefined;
    const { trackedPoolMarket, trackedPoolLaunches } = options;
    const shared = options.cached ? createPublicPresaleReader(readNow) : undefined;
    const common = { database: () => replica, ledgerDatabase: () => autocommitReader(webPool, "social"), wallets: accounts, config: reader.getSocialConfig, now: readNow, terms, caches, shared, trackedPoolMarket: trackedPoolMarket && (() => trackedPoolMarket(now)), trackedPoolLaunches };
    const all = createSocialHomeRoutes({ ...common, kit: kitWith(true) });
    const hidden = createSocialHomeRoutes({ ...common, kit: kitWith(false) });
    const get = (path: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, { headers: { "x-forwarded-for": "203.0.113.7", ...headers } });
    await run({
      admin,
      now,
      replica,
      discover: (query = "", options = {}) => (options.trades === false ? hidden : all).DISCOVER(get(`/api/social/home${query}`, options.headers), testClient()),
      coins: (query, options = {}) => (options.trades === false ? hidden : all).COINS(get(`/api/social/home/coins${query}`), testClient()),
      thread: (query) => all.ACTIVITY(get(`/api/social/home/activity${query}`), testClient()),
      market: (query) => all.MARKET(get(`/api/social/home/market${query}`), testClient()),
      holders: (query) => all.HOLDERS(get(`/api/social/home/holders${query}`), testClient()),
      discussion: (query) => all.DISCUSSION(get(`/api/social/home/discussion${query}`), testClient()),
      traders: (query = "", options = {}) => (options.trades === false ? hidden : all).TRADERS(get(`/api/social/home/traders${query}`), testClient()),
      following: (callsign, body, query = "") => all.FOLLOWING(new Request(`${ORIGIN}/api/social/me/home/following${query}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7", origin: ORIGIN, ...(callsign ? { authorization: bearer(did(callsign)) } : {}) },
        body: JSON.stringify(body),
      }), testClient("203.0.113.7")),
      ids: { mayaBuy1: entryOf(mayaBuy1), leoSell: entryOf(leoSell), cyQuietBuy: entryOf(cyQuietBuy) },
      forget: () => { for (const cache of Object.values(caches ?? {})) cache.clear(); },
    });
  } finally {
    await Promise.all([admin.end(), replicaPool.end(), webPool.end()]);
    await database.drop();
  }
}

async function ok<T>(response: Response, schema: Parameters<typeof validator.validate>[0], cache = PUBLIC): Promise<T> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate(schema, body).errors, []);
  assert.equal(response.headers.get("cache-control"), cache);
  assert.ok(response.headers.get("x-request-id"));
  return body as T;
}

const symbols = (coins: readonly HomeCoin[]) => coins.map((coin) => coin.symbol);
const keysOf = (rows: readonly { key: string }[]) => rows.map((row) => row.key);
// The tracked pools have no launch date. Their fallback order is by coin type.
const TRACKED = [...INDEXED_POOL_COINS].sort((a, b) => a.coinType.localeCompare(b.coinType));
const TRACKED_SYMBOLS: readonly string[] = TRACKED.map((coin) => coin.symbol);
// The fixture's own coins, in the default order, ahead of the idle tracked pools.
const FIXTURE_SYMBOLS = ["CROWD", "ORBIT", "EMAN", "AFTR", "QUIET"];
// The first default-size page of a list.
const firstPage = (list: readonly string[]) => list.slice(0, HOME_PAGE_DEFAULT);

test("Home origin cache spends the edge freshness budget, is one read for every process, and keeps trade-filtered results separate", { skip }, async () => {
  let elapsed = 0;
  await withFixture(async ({ discover, admin, forget }) => {
    const first = await ok<HomeCoinsPage>(await discover(), "home-coins-page");
    elapsed = 2_500;
    const cached = await ok<HomeCoinsPage>(await discover(), "home-coins-page", "public, s-maxage=7, stale-while-revalidate=20");
    assert.deepEqual(cached, first);
    const hidden = await ok<HomeCoinsPage>(await discover("", { trades: false }), "home-coins-page");
    assert.notDeepEqual(hidden.coins, first.coins, "Trade-hidden requests must not reuse visible trade results");
    await admin.query("UPDATE blast_infra_fixture.presales SET sale_symbol = 'REFRESHED' WHERE presale_id = $1", [P.orbit]);
    // Another sort of the same window reuses the window read: same coins, no new read.
    const volume = await ok<HomeCoinsPage>(await discover("?sort=trending"), "home-coins-page");
    assert.equal(volume.coins.find((coin) => coin.presale_id === P.orbit)?.symbol, first.coins.find((coin) => coin.presale_id === P.orbit)?.symbol);
    // Another process sends the same read with the same remaining freshness, without reading the window again.
    forget();
    assert.deepEqual(await ok<HomeCoinsPage>(await discover(), "home-coins-page", "public, s-maxage=7, stale-while-revalidate=20"), first);
    elapsed = 11_000;
    const refreshed = await ok<HomeCoinsPage>(await discover(), "home-coins-page");
    assert.equal(refreshed.coins.find((coin) => coin.presale_id === P.orbit)?.symbol, "REFRESHED");
  }, { cached: true, elapsedMs: () => elapsed });
});

test("Discover exposes only the latest confirmed buy per coin in its opt-in response", { skip }, () =>
  withFixture(async ({ admin, discover, now }) => {
    const older = buy(W.mayaA, ORBIT, 80, now - 6_000);
    const latest = buy(W.mayaA, ORBIT, 1.25, now - 6_000, { quote_type: SUI, quote_amount: "1250000000" });
    const other = buy(W.leo, EMAN, 4, now - 5_000, { presale_id: P.eman });
    const dust = buy(W.leo, ORBIT, 0.09, now - 5_500);
    const unpriced = buy(W.leo, EMAN, 4, now - 5_000, { presale_id: P.eman, usd_value: null });
    const recentSell = sell(W.leo, ORBIT, 200, now - 4_000);
    const uncommitted = buy(W.mayaA, ORBIT, 999, now - 3_000);
    await seedChainRead(admin, { activity: [older, latest, other, dust, unpriced, recentSell, uncommitted] });
    await admin.query(advanceWatermark(recentSell.checkpoint));

    const read = await discover("?recent_buys=2");
    assert.equal(read.status, 200);
    const page = homeCoinsPageReadSchema.parse(await read.json());
    assert.deepEqual(page.recent_buys?.find(buy => buy.coin_key === P.orbit), {
      coin_key: P.orbit, activity_id: `${latest.checkpoint}:0:0:0`, occurred_at_ms: now - 6_000,
      quote_atoms: "1250000000", quote_symbol: "SUI", quote_decimals: 9, usd: "1.25",
    }, "a newer buy under $0.10 must not replace the real one");
    const eman = page.recent_buys?.find(buy => buy.coin_key === P.eman);
    assert.equal(eman?.quote_atoms, "4000000");
    assert.equal(eman?.usd, undefined, "an unpriced buy still shows, without a dollar value");
    assert.equal(page.recent_buys?.length, 2);
    const olderTab = homeCoinsPageReadSchema.parse(await (await discover("?recent_buys=1")).json());
    assert.deepEqual(olderTab.recent_buys?.map(buy => buy.usd), [undefined, undefined], "a tab from before dollars shipped gets the buys without the new field");
    assert.equal((await ok<HomeCoinsPage>(await discover(), "home-coins-page")).recent_buys, undefined);
    const hidden = await discover("?recent_buys=1", { trades: false });
    assert.equal(homeCoinsPageReadSchema.parse(await hidden.json()).recent_buys, undefined);
  }));

test("Home lists opt in to circulating market cap and rolling change from a known hourly baseline", { skip }, () =>
  withFixture(async ({ admin, coins, discover, following, now }) => {
    const orbitType = coinOf(P.orbit, "ORBIT");
    const hourStart = now - HOUR;
    const bucket = Math.floor(hourStart / (5 * MINUTE)) * (5 * MINUTE);
    await seedChainRead(admin, {
      price_history: [
        { coin_type: orbitType, resolution: "5m", bucket_ms: bucket - 5 * MINUTE, usd_price: "0.10", as_of_ms: bucket - MINUTE, source: "pool" },
        { coin_type: orbitType, resolution: "5m", bucket_ms: bucket, usd_price: "0.20", as_of_ms: hourStart + 1, source: "pool" },
        { coin_type: coinOf(P.eman, "EMAN"), resolution: "5m", bucket_ms: bucket - 15 * MINUTE, usd_price: "0.10", as_of_ms: bucket - 12 * MINUTE, source: "pool" },
        { coin_type: coinOf(P.crowd, "CROWD"), resolution: "5m", bucket_ms: bucket - 5 * MINUTE, usd_price: "0.01", as_of_ms: bucket - MINUTE, source: "pool" },
      ],
      vesting_schedules: [
        { schedule_id: hex("7e1"), presale_id: P.orbit, beneficiary: W.mayaA, total: "100000000000000", claimed: "25000000000000", start_ms: now - DAY, cliff_ms: "0", end_ms: String(now + DAY) },
        { schedule_id: hex("7e2"), presale_id: P.orbit, beneficiary: W.mayaB, total: "999000000000000", claimed: "0", start_ms: now - DAY, cliff_ms: "0", end_ms: String(now + DAY), asset: "quote" },
      ],
    });

    const standard = await ok<HomeCoinsPage>(await discover(), "home-coins-page");
    const enriched = await ok<HomeCoinsPage>(await discover("?mobile_market=1"), "home-coins-page");
    const watchlist = await ok<HomeCoinsByIds>(await coins(`?presale=${P.orbit}&mobile_market=1`), "home-coins-page");
    const followed = await ok<HomeFollowingResponse>(await following("ben", { mode: "coins", window: "24h" }, "?mobile_market=1"), "home-following-response", "private, no-store");
    assert.equal(followed.mode, "coins");
    const orbit = (page: { coins: readonly HomeCoin[] }) => page.coins.find((coin) => coin.presale_id === P.orbit);
    assert.equal(orbit(standard)?.mobile_market, undefined);
    assert.equal(orbit(enriched)?.fdv_usd, "50000.00");
    assert.equal(orbit(enriched)?.change_24h_bps, 2500);
    const expected = { market_cap_usd: "46250.00", change_1h_bps: -5000 };
    assert.deepEqual(orbit(enriched)?.mobile_market, expected);
    const streamed = await ok<HomeCoinsPage>(await discover("?mobile_market=1&live_inputs=1"), "home-coins-page");
    assert.deepEqual(orbit(streamed)?.live_inputs, {
      price_checkpoint: checkpoint - 1, // The final activity fixture is past the market watermark.
      total_supply: "1000000000000000", circulating_supply: "925000000000000",
      open_1h_usd: "0.1", open_24h_usd: "0.04",
      baselines_until_ms: (Math.floor(now / (5 * MINUTE)) + 1) * 5 * MINUTE,
    });
    assert.equal(orbit(await ok<HomeCoinsPage>(await discover("?mobile_market=1"), "home-coins-page"))?.live_inputs, undefined);
    assert.deepEqual(orbit(watchlist)?.mobile_market, expected);
    assert.deepEqual(orbit(followed)?.mobile_market, expected);
    // EMAN last traded 12 minutes before the hour and again inside it: the hour opens at that earlier price.
    assert.equal(enriched.coins.find((coin) => coin.presale_id === P.eman)?.mobile_market?.change_1h_bps, 10000);
    assert.equal(enriched.coins.find((coin) => coin.presale_id === P.crowd)?.mobile_market?.change_1h_bps, 0);
    assert.equal(orbit(await ok<HomeCoinsPage>(await discover(), "home-coins-page"))?.mobile_market, undefined);
    // Quiet for hours before the hour: the indexer's price at the hour's start opens it, for the figure and the stream.
    const emanType = coinOf(P.eman, "EMAN");
    await admin.query("DELETE FROM blast_infra_fixture.price_history WHERE coin_type = $1", [emanType]);
    await admin.query("INSERT INTO blast_infra_fixture.native_coin_prices VALUES ($1, $2, '0.05', $3)", [emanType, hourStart, hourStart - 3 * HOUR]);
    const quiet = await ok<HomeCoinsByIds>(await coins(`?presale=${P.eman}&mobile_market=1&live_inputs=1`), "home-coins-page");
    assert.deepEqual([quiet.coins[0]?.mobile_market?.change_1h_bps, quiet.coins[0]?.live_inputs?.open_1h_usd], [30000, "0.05"]);
  }, { cached: true }));

test("Home volume and Trending share a committed, full-window Cetus and Bluefin sum", { skip }, () =>
  withFixture(async ({ admin, discover, coins, following, now }) => {
    const joey = "0xbcd73dc8d774982c2da4e07cd1c6803ec29e128821d1ade9e9a7ce4975b44944::joey::JOEY";
    const bcat = "0x2d540c00977909b5481b33d014cd6c5b683015cdfa0b2ed19efe20f8b803b46c::bcat::BCAT";
    await admin.query(`INSERT INTO blast_infra_fixture.coin_metadata (coin_type,name,symbol,decimals)
      VALUES ($1,'Sui','SUI',9), ($2,'JOEY','JOEY',9), ($3,'BCAT','BCAT',6)`, [SUI, joey, bcat]);
    await admin.query(`INSERT INTO blast_infra_fixture.vaults
      (vault_id,origin_kind,origin_id,meme_type,venue_type,venue,pool_id,quote_type,created_checkpoint,created_tx_slot)
      VALUES ($1,'launch',$1,$2,$3,'cetus',$1,$4,40000,0), ($5,'launch',$5,$6,$7,'bluefin',$5,$4,40000,0)`,
    [hex("c001"), joey, `${hex("c")}::cetus::Venue`, SUI, hex("b001"), bcat, `${hex("b")}::bluefin::Venue`]);

    const dailyTrending = "?sort=trending&dex_volume=1&limit=2";
    const withoutView = await ok<HomeCoinsPage>(await discover(dailyTrending), "home-coins-page");
    assert.deepEqual(symbols(withoutView.coins), ["CROWD", "ORBIT"]);
    assert.equal(withoutView.coins[0]?.dex_volume, undefined);

    await admin.query(`CREATE TABLE blast_infra_fixture.dex_swap_volume (
      coin_type text NOT NULL, venue text NOT NULL, timestamp_ms bigint NOT NULL, checkpoint bigint NOT NULL, usd_value numeric
    );
    CREATE TABLE blast_infra_fixture.dex_swap_volume_coverage (checkpoint bigint NOT NULL, started_at_ms bigint NOT NULL);
    CREATE VIEW chain_read_v1.dex_swap_volume AS SELECT * FROM blast_infra_fixture.dex_swap_volume;
    CREATE VIEW chain_read_v1.dex_swap_volume_coverage AS SELECT * FROM blast_infra_fixture.dex_swap_volume_coverage;
    GRANT SELECT ON chain_read_v1.dex_swap_volume, chain_read_v1.dex_swap_volume_coverage TO blast_replica, blast_web`);
    const marketCheckpoint = checkpoint - 1;
    await admin.query("INSERT INTO blast_infra_fixture.dex_swap_volume_coverage VALUES ($1, $2)", [marketCheckpoint, now - 2 * HOUR]);
    // JOEY's two Cetus pools moved 21,596,586 and 22,282,147 SUI atoms (5BaUtNBpxJG7GMSQCTM3kA5BoMRLV9BVDHR2mHksdoTN).
    // The BCAT Bluefin sell moved 773,101,637 SUI atoms (vLRFNKrULJy99JTzC9oXT3hfqSdiGQpsPVcUooEDW32). This fixture uses $1 per SUI.
    await admin.query(`INSERT INTO blast_infra_fixture.dex_swap_volume VALUES
      ($1,'cetus',$4,$7,'0.021596586'), ($1,'cetus',$4,$7,'0.022282147'),
      ($1,'bluefin',$4,$7,NULL), ($2,'bluefin',$5,$7,'0.773101637'),
      ($3,'cetus',$4,$7,'0.004'), ($3,'bluefin',$4,$7,'0.007'),
      ($1,'cetus',$4,$8,'99999'), ($1,'cetus',$6,$7,'99999')`,
    [joey, bcat, coinOf(P.orbit, "ORBIT"), now, now - 2 * HOUR, now - DAY, marketCheckpoint, marketCheckpoint + 1]);

    const pending = await ok<HomeCoinsPage>(await discover(dailyTrending), "home-coins-page");
    assert.deepEqual(pending.coins, withoutView.coins);
    const hour = await ok<HomeCoinsPage>(await discover(`${dailyTrending}&window=1h`), "home-coins-page");
    assert.deepEqual(symbols(hour.coins), ["JOEY", "ORBIT"]);

    await admin.query("UPDATE blast_infra_fixture.dex_swap_volume_coverage SET started_at_ms = $1", [now - DAY]);
    const daily = await ok<HomeCoinsPage>(await discover(dailyTrending), "home-coins-page");
    assert.deepEqual(symbols(daily.coins), ["BCAT", "JOEY"]);
    const joeyVolume = { usd: "0.043878733", usd_complete: false, venues: {
      cetus: { usd: "0.043878733", usd_complete: true }, bluefin: { usd: null, usd_complete: false },
    } };
    assert.deepEqual(daily.coins.map((coin) => coin.dex_volume), [{
      usd: "0.773101637", usd_complete: true, venues: {
        cetus: { usd: "0", usd_complete: true }, bluefin: { usd: "0.773101637", usd_complete: true },
      },
    }, joeyVolume]);
    assert.ok(daily.next_cursor);
    const next = await ok<HomeCoinsPage>(await discover(`${dailyTrending}&cursor=${encodeURIComponent(daily.next_cursor)}`), "home-coins-page");
    assert.equal(next.coins[0]?.symbol, "ORBIT");
    assert.equal(next.coins[0]?.dex_volume?.usd, "0.011");
    for (const sort of ["trending", "relevant"]) {
      const all = await ok<HomeCoinsPage>(await discover(`?sort=${sort}&dex_volume=1&limit=50`), "home-coins-page");
      assert.deepEqual(all.coins.filter((coin) => TRACKED_SYMBOLS.includes(coin.symbol)).map((coin) => [coin.symbol, coin.dex_volume]),
        TRACKED_SYMBOLS.map((symbol) => [symbol, undefined]));
    }
    assert.equal((await ok<HomeCoinsPage>(await discover("?sort=trending"), "home-coins-page")).coins[0]?.dex_volume, undefined);
    assert.equal((await ok<HomeCoinsPage>(await discover(dailyTrending, { trades: false }), "home-coins-page")).coins[0]?.dex_volume, undefined);

    const watchlist = await ok<HomeCoinsByIds>(await coins(`?presale=${encodeURIComponent(joey)}&dex_volume=1`), "home-coins-page");
    assert.deepEqual(watchlist.coins[0]?.dex_volume, joeyVolume);
    const followed = await ok<HomeFollowingResponse>(await following("ben", { mode: "coins", window: "24h" }, "?dex_volume=1"), "home-following-response", "private, no-store");
    assert.equal(followed.mode, "coins");
    assert.equal(followed.coins.find((coin) => coin.symbol === "ORBIT")?.dex_volume?.usd, "0.011");

    const one = INDEXED_POOL_COINS.find((coin) => coin.symbol === "ONE")!;
    const wheels = INDEXED_POOL_COINS.find((coin) => coin.symbol === "Wheels")!;
    await admin.query(`CREATE TABLE blast_infra_fixture.dex_swap_volume_tracked_coverage
      (checkpoint bigint NOT NULL, started_at_ms bigint NOT NULL);
    CREATE VIEW chain_read_v1.dex_swap_volume_tracked_coverage AS SELECT * FROM blast_infra_fixture.dex_swap_volume_tracked_coverage;
    GRANT SELECT ON chain_read_v1.dex_swap_volume_tracked_coverage TO blast_replica, blast_web`);
    await admin.query("INSERT INTO blast_infra_fixture.dex_swap_volume_tracked_coverage VALUES ($1, $2)", [marketCheckpoint, now - 2 * HOUR]);
    await admin.query(`INSERT INTO blast_infra_fixture.dex_swap_volume VALUES
      ($1,'cetus',$2,$3,'2.75'), ($1,'bluefin',$2,$3,'0.25'), ($1,'bluefin',$2,$3,NULL)`, [one.coinType, now, marketCheckpoint]);
    const partial = await ok<HomeCoinsPage>(await discover(dailyTrending), "home-coins-page");
    assert.equal(partial.coins[0]?.coin_type, one.coinType);
    assert.deepEqual(partial.coins[0]?.dex_volume, { usd: "3", usd_complete: false, venues: {
      cetus: { usd: "2.75", usd_complete: false }, bluefin: { usd: "0.25", usd_complete: false },
    } });
    const trackedIds = `?presale=${encodeURIComponent(one.coinType)}&presale=${encodeURIComponent(wheels.coinType)}&dex_volume=1`;
    const uncovered = await ok<HomeCoinsByIds>(await coins(trackedIds), "home-coins-page");
    assert.deepEqual([uncovered.coins[1]?.dex_volume?.usd, uncovered.coins[1]?.dex_volume?.usd_complete], [null, false]);
    const covered = await ok<HomeCoinsByIds>(await coins(`${trackedIds}&window=1h`), "home-coins-page");
    assert.deepEqual(covered.coins[0]?.dex_volume, { usd: "3", usd_complete: false, venues: {
      cetus: { usd: "2.75", usd_complete: true }, bluefin: { usd: "0.25", usd_complete: false },
    } });
    assert.deepEqual([covered.coins[1]?.dex_volume?.usd, covered.coins[1]?.dex_volume?.usd_complete], ["0", true]);

    await admin.query("UPDATE blast_infra_fixture.dex_swap_volume_tracked_coverage SET checkpoint = checkpoint - 1");
    const trackedLag = await ok<HomeCoinsByIds>(await coins(trackedIds), "home-coins-page");
    assert.equal(trackedLag.coins[0]?.dex_volume, undefined);

    await admin.query("UPDATE blast_infra_fixture.dex_swap_volume_coverage SET checkpoint = checkpoint - 1");
    const lagging = await ok<HomeCoinsPage>(await discover(dailyTrending), "home-coins-page");
    assert.deepEqual(lagging.coins, withoutView.coins);

    // A presale watermark ahead of market cannot shorten the DEX window
    // or admit rows after the committed market clock. Activity keeps its own cut.
    await admin.query("UPDATE watermarks SET timestamp_ms_hi_inclusive = $1 WHERE pipeline = 'market'", [now - MINUTE]);
    await admin.query("UPDATE blast_infra_fixture.dex_swap_volume_coverage SET checkpoint = $1, started_at_ms = $2", [marketCheckpoint, now - DAY - MINUTE]);
    const marketLag = await ok<HomeCoinsPage>(await discover(dailyTrending), "home-coins-page");
    assert.deepEqual(symbols(marketLag.coins), ["JOEY", "BCAT"]);
    assert.deepEqual([marketLag.coins[0]?.dex_volume?.usd, marketLag.coins[0]?.activity.to_ms], ["99999", now]);

    // A catalog coin with a native pool keeps its proven native volume through the rollout.
    const manifest = INDEXED_POOL_COINS.find((coin) => coin.symbol === "MANIFEST")!;
    await admin.query(`INSERT INTO blast_infra_fixture.coin_metadata (coin_type,name,symbol,decimals)
      VALUES ($1,'Manifest','MANIFEST',9)`, [manifest.coinType]);
    await admin.query(`INSERT INTO blast_infra_fixture.vaults
      (vault_id,origin_kind,origin_id,meme_type,venue_type,venue,pool_id,quote_type,created_checkpoint,created_tx_slot)
      VALUES ($1,'launch',$1,$2,$3,'cetus',$1,$4,40000,0)`,
    [hex("c002"), manifest.coinType, `${hex("c")}::cetus::Venue`, SUI]);
    await admin.query(`INSERT INTO blast_infra_fixture.dex_swap_volume VALUES
      ($1,'cetus',$2,$3,'1.25')`, [manifest.coinType, now - MINUTE, marketCheckpoint]);
    const manifestVolume = async () => {
      const page = await ok<HomeCoinsByIds>(await coins(`?presale=${encodeURIComponent(manifest.coinType)}&dex_volume=1`), "home-coins-page");
      return page.coins[0]?.dex_volume;
    };
    const nativeVolume = { usd: "1.25", usd_complete: true, venues: {
      cetus: { usd: "1.25", usd_complete: true }, bluefin: { usd: "0", usd_complete: true },
    } };
    assert.deepEqual(await manifestVolume(), nativeVolume);
    await admin.query("UPDATE blast_infra_fixture.dex_swap_volume_tracked_coverage SET checkpoint = $1", [marketCheckpoint]);
    assert.deepEqual(await manifestVolume(), nativeVolume);
    await admin.query("DROP VIEW chain_read_v1.dex_swap_volume_tracked_coverage");
    assert.deepEqual(await manifestVolume(), nativeVolume);

    // A curve still filling trades on its curve, not a DEX: no DEX figure. Discover leaves it out (it lists only on Almost graduated); a saved read finds it.
    const filling = coinOf(hex("cf1"), "FILLING");
    await admin.query("INSERT INTO blast_infra_fixture.coin_metadata (coin_type,name,symbol,decimals) VALUES ($1,'FILLING','FILLING',9)", [filling]);
    await admin.query(`INSERT INTO pools (pool_key,venue,coin_type,quote_type,lifecycle,created_checkpoint,created_at_ms,quote_reserve,params)
      VALUES ($1,'blast_curve',$2,$3,'live',41000,$4,'5000000000',$5)`, [`blast_curve:${hex("cf10")}`, filling, SUI, now - DAY, { graduation_target: "8000000000000" }]);
    await seedChainRead(admin, { activity: [activity("trade_buy", W.anon, null, now - 2 * MINUTE, { checkpoint: 49999, coin_type: filling, coin_amount: "1000000000", quote_amount: "5000000000", usd_value: "5" })] });
    const listed = await ok<HomeCoinsPage>(await discover("?sort=trending&dex_volume=1&limit=50"), "home-coins-page");
    assert.equal(listed.coins.some((coin) => coin.symbol === "FILLING"), false, "the default read stays off the live curves");
    const byId = await ok<HomeCoinsByIds>(await coins(`?presale=${encodeURIComponent(filling)}&dex_volume=1`), "home-coins-page");
    assert.deepEqual(byId.coins.map((coin) => [coin.symbol, coin.dex_volume]), [["FILLING", undefined]]);
  }));

test("Sparse coins retain a full 24-hour comparison and Home labels shorter native and legacy comparisons", { skip }, () =>
  withFixture(async ({ admin, coins, discover, following, market, now, replica }) => {
    const poolId = hex("c001");
    const joey = coinOf(hex("bcd73dc8"), "JOEY");
    const young = coinOf(hex("add"), "YOUNG");
    const legacy = coinOf(P.eman, "EMAN");
    const latestNative = now - MINUTE;
    const cutoff = now - DAY;
    const asOf = cutoff - 5 * MINUTE;
    const firstTrade = now - 50 * MINUTE;
    const bucketOf = (at: number) => Math.floor(at / (5 * MINUTE)) * (5 * MINUTE);
    await seedChainRead(admin, {
      coin_metadata: [
        { coin_type: SUI, name: "Sui", symbol: "SUI", description: null, icon_url: null, decimals: 9 },
        { coin_type: joey, name: "Joey", symbol: "JOEY", description: null, icon_url: null, decimals: 9 },
        { coin_type: young, name: "Young", symbol: "YOUNG", description: null, icon_url: null, decimals: 9 },
      ],
      prices: [
        { coin_type: joey, usd_price: "0.03", as_of_ms: now, source: "pool" },
      ],
      price_history: [
        { coin_type: joey, resolution: "5m", bucket_ms: bucketOf(cutoff - 67 * MINUTE), usd_price: "0.02", as_of_ms: cutoff - 67 * MINUTE, source: "pool" },
        { coin_type: legacy, resolution: "5m", bucket_ms: bucketOf(firstTrade - 5 * MINUTE), usd_price: "0", as_of_ms: firstTrade - 5 * MINUTE, source: "pool" },
        { coin_type: legacy, resolution: "5m", bucket_ms: bucketOf(firstTrade), usd_price: "0.1", as_of_ms: firstTrade, source: "pool" },
        { coin_type: legacy, resolution: "5m", bucket_ms: bucketOf(firstTrade + 5 * MINUTE), usd_price: "0.15", as_of_ms: firstTrade + 5 * MINUTE, source: "pool" },
        { coin_type: coinOf(P.quiet, "QUIET"), resolution: "5m", bucket_ms: bucketOf(firstTrade), usd_price: "0.07", as_of_ms: firstTrade, source: "pool" },
      ],
    });
    await admin.query(
      "UPDATE blast_infra_fixture.prices SET usd_price = 0.1, as_of_ms = $2 WHERE coin_type = $1",
      [legacy, firstTrade],
    );
    await admin.query(`INSERT INTO blast_infra_fixture.vaults
      (vault_id,origin_kind,origin_id,meme_type,venue_type,venue,pool_id,quote_type,created_checkpoint,created_tx_slot)
      VALUES ($1,'launch',$1,$2,$3,'cetus',$1,$4,40000,0), ($5,'launch',$5,$6,$3,'cetus',$5,$4,40001,0)`,
    [poolId, joey, `${hex("c")}::cetus::Venue`, SUI, hex("c002"), young]);
    await admin.query(`INSERT INTO blast_infra_fixture.native_coin_prices VALUES
      ($1,$4,'0.02',$5), ($1,$4,'0.01',$6), ($2,$4,'0.02',$6), ($2,$4,'0.03',$7), ($3,$4,'0.01',$6)`,
    [joey, young, coinOf(P.orbit, "ORBIT"), cutoff, asOf, firstTrade, latestNative]);

    const options = "mobile_market=1&live_inputs=1&rolling_change=1";
    const list = await ok<HomeCoinsPage>(await discover(`?window=24h&${options}`), "home-coins-page");
    const row = list.coins.find((coin) => coin.coin_type === joey);
    assert.equal(row?.change_24h_bps, 5000);
    assert.equal(row.live_inputs?.open_24h_usd, "0.02");
    assert.equal(row.change_24h_from_ms, undefined);
    assert.equal(list.coins.find((coin) => coin.presale_id === P.orbit)?.change_24h_bps, 2500);
    const ids = `?presale=${encodeURIComponent(joey)}&presale=${encodeURIComponent(young)}&presale=${P.eman}`;
    const byId = await ok<HomeCoinsByIds>(await coins(`${ids}&${options}`), "home-coins-page");
    assert.deepEqual(byId.coins.map((coin) => [coin.change_24h_bps, coin.change_24h_from_ms]), [[5000, undefined], [5000, firstTrade], [5000, firstTrade]]);
    assert.deepEqual(byId.coins.slice(1).map((coin) => [coin.price_usd, coin.price_as_of_ms]), [["0.03", latestNative], ["0.15", firstTrade + 5 * MINUTE]]);
    assert.equal(row.live_inputs?.open_24h_until_ms, (Math.floor(now / MINUTE) + 1) * MINUTE);
    const followed = await ok<HomeFollowingResponse>(
      await following("ben", { mode: "coins", window: "24h" }, `?${options}`),
      "home-following-response", "private, no-store",
    );
    assert.ok(followed.mode === "coins");
    assert.equal(followed.coins.find((coin) => coin.presale_id === P.quiet)?.change_24h_from_ms, firstTrade);
    const existingTab = await ok<HomeCoinsByIds>(await coins(`${ids}&mobile_market=1&live_inputs=1`), "home-coins-page");
    assert.deepEqual(existingTab.coins.map((coin) => [coin.change_24h_from_ms, coin.live_inputs?.open_24h_until_ms]),
      [[undefined, undefined], [undefined, undefined], [undefined, undefined]]);
    assert.equal(existingTab.coins[1]?.change_24h_bps, null);
    const fullDay = await ok<HomeCoinsByIds>(await coins(ids), "home-coins-page");
    assert.deepEqual(fullDay.coins.map((coin) => [coin.change_24h_bps, coin.change_24h_from_ms]), [[5000, undefined], [null, undefined], [null, undefined]]);
    const detail = await ok<HomeCoinMarket>(await market(`?coin=${encodeURIComponent(joey)}`), "home-coin-market");
    assert.deepEqual([detail.windows["24h"].open_usd, detail.windows["24h"].open_as_of_ms, detail.windows["24h"].change_bps], ["0.02", asOf, 5000]);
    assert.equal(detail.windows["1h"].change_bps, null);
    // A single priced swap still gives a labeled zero rather than a missing return.
    await admin.query(`DELETE FROM blast_infra_fixture.native_coin_prices WHERE coin_type = $1 AND as_of_ms = $2`, [young, latestNative]);
    const oneSwap = await ok<HomeCoinsByIds>(
      await coins(`?presale=${encodeURIComponent(young)}&${options}`), "home-coins-page",
    );
    assert.deepEqual([oneSwap.coins[0]?.change_24h_bps, oneSwap.coins[0]?.change_24h_from_ms], [0, firstTrade]);
    const youngMarket = await ok<HomeCoinMarket>(await market(`?coin=${encodeURIComponent(young)}`), "home-coin-market");
    assert.deepEqual([youngMarket.windows["24h"].open_usd, youngMarket.windows["24h"].open_as_of_ms, youngMarket.windows["24h"].change_bps], [null, null, null]);
    await seedChainRead(admin, { prices: [{ coin_type: young, usd_price: "0.03", as_of_ms: now, source: "pool" }] });
    await admin.query(`DELETE FROM blast_infra_fixture.native_coin_prices WHERE coin_type = $1`, [young]);
    const onlyProjection = await ok<HomeCoinsByIds>(
      await coins(`?presale=${encodeURIComponent(young)}&${options}`), "home-coins-page",
    );
    assert.deepEqual([onlyProjection.coins[0]?.change_24h_bps, onlyProjection.coins[0]?.change_24h_from_ms], [0, now]);
    const history = await readPrices(replica, { presales: [], coins: [joey, young], window: "24h", points: 60 }, now);
    assert.deepEqual([history.prices[0]?.price_24h_usd, history.prices[0]?.change_24h_bps, history.prices[0]?.points[0]], ["0.02", 5000, [cutoff, "0.02"]]);
    assert.deepEqual([history.prices[1]?.price_24h_usd, history.prices[1]?.change_24h_bps, history.prices[1]?.points], [null, null, []]);
  }));

test("Discover: one item per coin, counts by identity, directions kept apart, honest market facts, the rank explained", { skip }, () =>
  withFixture(async ({ discover, replica, now }) => {
    const page = await ok<HomeCoinsPage>(await discover(), "home-coins-page");
    assert.deepEqual(symbols(page.coins), firstPage([...FIXTURE_SYMBOLS, ...TRACKED_SYMBOLS]));
    assert.equal(page.clock_ms, now);
    const orbit = page.coins[1]!;
    // Maya's two wallets are one participant; priv and late are wallets; the split transaction is two events; the future, old and uncommitted rows are out.
    assert.equal(orbit.activity.participants, 6);
    assert.equal(orbit.activity.events, 10);
    assert.deepEqual([orbit.activity.buyers, orbit.activity.sellers, orbit.activity.backers, orbit.activity.claimers], [5, 2, 0, 0]);
    assert.deepEqual(orbit.activity.bought.map((amount) => [amount.quote_symbol, amount.atoms, amount.usd, amount.usd_complete]), [["USDC", "370000000", "370.00", true]]);
    assert.deepEqual(orbit.activity.sold.map((amount) => [amount.atoms, amount.usd]), [["65000000", "65.00"]]);
    assert.equal(orbit.activity.scope, "pool");
    assert.deepEqual([orbit.activity.from_ms, orbit.activity.to_ms], [now - DAY, now]);
    // Market facts: a fresh price, the 24 h move from the real bucket, holders, FDV from the terms, two posts with a why.
    assert.deepEqual([orbit.price_usd, orbit.change_24h_bps, orbit.holders, orbit.fdv_usd, orbit.discussion.posts], ["0.05", 2500, 42, "50000.00", 2]);
    assert.equal(orbit.launched_ms, now - 2 * DAY);
    assert.equal(orbit.tradable, true);
    assert.equal(orbit.rank.why, "6 participants · 10 trades · 2 sold in the last 24h");
    // The biggest holders: jules, then maya (two wallets as one), then an unnamed wallet; the pool's address never; shares of the terms' supply.
    assert.deepEqual(orbit.top_holders.holders.slice(0, 3).map((holder) => [holder.actor.type === "account" ? holder.actor.callsign : "wallet", holder.balance, holder.share_bps]), [["jules", "5000000000000", 50], ["maya", "1500000000000", 15], ["wallet", "60000000000", 0]]);
    assert.equal(orbit.top_holders.holders.length, 10);
    assert.deepEqual(orbit.top_holders.holders.slice(3).map((holder) => holder.balance), [12, 11, 10, 9, 8, 7, 6].map((balance) => (BigInt(balance) * 1_000_000_000n).toString()));
    // Combine balances before rounding: individually sub-basis-point holdings still count.
    assert.equal(orbit.top_holders.share_bps, 66);
    assert.deepEqual(page.coins[2]!.top_holders, { holders: [], share_bps: null });
    // The preview: the newest rows, a seller among them, a private account and a late-named one as wallets only.
    assert.equal(orbit.activity.preview.length, 3);
    assert.equal(orbit.activity.preview[0]!.key, "c:maya");
    assert.deepEqual([orbit.activity.preview[0]!.buys?.count, orbit.activity.preview[0]!.sells?.count], [3, 1]);
    assert.ok(orbit.activity.preview.some((row) => row.sells !== null));
    assert.ok(!JSON.stringify(orbit).includes("priv") && !JSON.stringify(orbit).includes("c:late"));
    // EMAN: one participant four buys and a claim; an old price keeps its observation timestamp; the projection failing is no FDV.
    const eman = page.coins[2]!;
    assert.deepEqual([eman.activity.participants, eman.activity.events, eman.activity.buyers, eman.activity.claimers], [1, 5, 1, 1]);
    assert.deepEqual([eman.price_usd, eman.change_24h_bps, eman.fdv_usd, eman.holders], ["0.2", null, null, null]);
    assert.deepEqual([eman.activity.preview[0]!.buys?.count, eman.activity.preview[0]!.claims?.count, eman.activity.preview[0]!.sells], [4, 1, null]);
    // The crowd: 23 wallets, each once.
    const crowd = page.coins[0]!;
    assert.deepEqual([crowd.activity.participants, crowd.activity.events], [23, 23]);
    // Relevant: the weighted score leads the order, and many traders lead one busy wallet.
    const scores = page.coins.map((coin) => coin.rank.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
    assert.ok(crowd.rank.score > orbit.rank.score && orbit.rank.score > eman.rank.score);
    // New holders' baseline: the last count at or before the window's start (a change exactly on it counts), none before the first row.
    const start = async (fromMs: number) => [...(await readCoinFacts(replica, { kind: "ids", presaleIds: [P.orbit, P.crowd, P.eman] }, { fromMs, toMs: now })).values()]
      .map((row) => [row.symbol, row.holders, row.holders_at_start]);
    assert.deepEqual(new Set(await start(now - DAY)), new Set([["ORBIT", "42", "10"], ["CROWD", "23", "0"], ["EMAN", null, null]]));
    assert.deepEqual(new Set(await start(now - HOUR)), new Set([["ORBIT", "42", "42"], ["CROWD", "23", "0"], ["EMAN", null, null]]));
    assert.deepEqual(new Set(await start(now - 6 * DAY)), new Set([["ORBIT", "42", null], ["CROWD", "23", null], ["EMAN", null, null]]));
    // A quiet coin is shown, last, and says so.
    const quiet = page.coins[4]!;
    assert.deepEqual([quiet.activity.participants, quiet.rank.why], [0, "No activity in the last 24h"]);
    assert.equal(page.coins[3]!.tradable, false);
    // The default page ends the list only when every coin fits on it.
    assert.equal(page.next_cursor === null, FIXTURE_SYMBOLS.length + TRACKED_SYMBOLS.length <= HOME_PAGE_DEFAULT);
    // No viewer field, no account id, no private identity.
    assert.doesNotMatch(JSON.stringify(page), /"(viewer|follows_you|following|relation|account_id)"/);
    assert.doesNotMatch(JSON.stringify(page), /00000000-0000-4000/);
  }));

test("An old client's traction flag is ignored: it gets the Relevant page", { skip }, () =>
  withFixture(async ({ discover }) => {
    const flagged = await ok<HomeCoinsPage>(await discover("?window=1h&sort=relevant&traction=1"), "home-coins-page");
    const regular = await ok<HomeCoinsPage>(await discover("?window=1h&sort=relevant"), "home-coins-page");
    assert.deepEqual(symbols(flagged.coins), symbols(regular.coins));
  }));

test("Discover: the window, the sorts, the filters and the keyset page are coherent over every coin", { skip }, () =>
  withFixture(async ({ discover }) => {
    const hour = await ok<HomeCoinsPage>(await discover("?window=1h"), "home-coins-page");
    const orbit = hour.coins.find((coin) => coin.symbol === "ORBIT")!;
    assert.deepEqual([orbit.activity.window, orbit.activity.participants, orbit.activity.events], ["1h", 6, 10]);
    assert.equal(hour.coins.find((coin) => coin.symbol === "EMAN")!.activity.events, 1);
    assert.equal(hour.coins.find((coin) => coin.symbol === "CROWD")!.activity.participants, 23);
    assert.deepEqual(symbols((await ok<HomeCoinsPage>(await discover("?sort=newest"), "home-coins-page")).coins), firstPage(["ORBIT", "CROWD", "AFTR", "EMAN", "QUIET", ...TRACKED_SYMBOLS]));
    const trending = await ok<HomeCoinsPage>(await discover("?sort=trending"), "home-coins-page");
    assert.deepEqual(symbols(trending.coins), firstPage([...FIXTURE_SYMBOLS, ...TRACKED_SYMBOLS]));
    // `ranked` only when asked for: a client loaded before the field, which never asks, never receives it.
    assert.equal("ranked" in trending, false);
    const counted = await ok<HomeCoinsPage>(await discover("?sort=trending&ranked=1"), "home-coins-page");
    // CROWD, ORBIT and EMAN have activity in the 24h window; AFTR has none and QUIET last traded 30 h ago.
    assert.deepEqual([symbols(counted.coins), counted.ranked], [symbols(trending.coins), 3]);
    assert.deepEqual(symbols((await ok<HomeCoinsPage>(await discover("?min_participants=2"), "home-coins-page")).coins), ["CROWD", "ORBIT"]);
    assert.deepEqual(symbols((await ok<HomeCoinsPage>(await discover("?age=7d"), "home-coins-page")).coins), ["CROWD", "ORBIT"]);
    assert.deepEqual(symbols((await ok<HomeCoinsPage>(await discover("?tradable=1"), "home-coins-page")).coins), firstPage(["CROWD", "ORBIT", "EMAN", "QUIET", ...TRACKED_SYMBOLS]));
    const first = await ok<HomeCoinsPage>(await discover("?limit=2"), "home-coins-page");
    assert.deepEqual(symbols(first.coins), ["CROWD", "ORBIT"]);
    assert.ok(first.next_cursor);
    const second = await ok<HomeCoinsPage>(await discover(`?limit=2&cursor=${encodeURIComponent(first.next_cursor!)}`), "home-coins-page");
    assert.deepEqual(symbols(second.coins), ["EMAN", "AFTR"]);
    // The rest by cursor, two at a time: QUIET, then every tracked pool, and no cursor after the last.
    const rest: string[][] = [];
    for (let cursor = second.next_cursor; cursor !== null;) {
      assert.ok(rest.length < TRACKED_SYMBOLS.length, "the cursor never ends");
      const next = await ok<HomeCoinsPage>(await discover(`?limit=2&cursor=${encodeURIComponent(cursor)}`), "home-coins-page");
      rest.push(symbols(next.coins));
      cursor = next.next_cursor;
    }
    const after = ["QUIET", ...TRACKED_SYMBOLS];
    assert.deepEqual(rest, Array.from({ length: Math.ceil(after.length / 2) }, (_, index) => after.slice(index * 2, index * 2 + 2)));
    // The same list by page number: the page, how many pages at this size, how many coins in all; past the end, an empty page.
    const total = FIXTURE_SYMBOLS.length + TRACKED_SYMBOLS.length;
    const pages = Math.ceil(total / 2);
    assert.deepEqual([first.page, first.pages, first.total], [1, pages, total]);
    const numbered = await ok<HomeCoinsPage>(await discover("?limit=2&page=2"), "home-coins-page");
    assert.deepEqual([symbols(numbered.coins), numbered.page, numbered.pages, numbered.total], [symbols(second.coins), 2, pages, total]);
    const beyond = await ok<HomeCoinsPage>(await discover(`?limit=2&page=${pages + 1}`), "home-coins-page");
    assert.deepEqual([beyond.coins, beyond.page, beyond.pages], [[], pages + 1, pages]);
    for (const bad of ["?cursor=nope", `?sort=newest&cursor=${encodeURIComponent(first.next_cursor!)}`, "?window=7d", "?min_participants=x", "?limit=99", "?page=0", `?page=2&cursor=${encodeURIComponent(first.next_cursor!)}`]) {
      const response = await discover(bad);
      assert.equal(response.status, 400, bad);
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
  }));

test("Discover counts and paginates public markets while direct lookup still finds test markets", { skip }, () =>
  withFixture(async ({ admin, coins, discover, now }) => {
    const testSale = hex("7e57");
    await seedChainRead(admin, {
      presales: [presale(testSale, "TEST", "migrated", {
        quote_type: CREATE_TEST_SUI_QUOTE_TYPE, quote_symbol: "TEST_SUI", quote_decimals: 9,
      })],
      coin_holder_history: [{ coin_type: coinOf(testSale, "TEST"), checkpoint: 45_000, timestamp_ms: now - HOUR, holders: 999 }],
    });

    const first = await ok<HomeCoinsPage>(await discover("?sort=held&limit=5"), "home-coins-page");
    assert.deepEqual([symbols(first.coins), first.total, first.pages], [
      ["ORBIT", "CROWD", "EMAN", "AFTR", "QUIET"], FIXTURE_SYMBOLS.length + TRACKED_SYMBOLS.length, Math.ceil((FIXTURE_SYMBOLS.length + TRACKED_SYMBOLS.length) / 5),
    ]);
    assert.ok(first.next_cursor);
    const byId = await ok<HomeCoinsByIds>(await coins(`?presale=${testSale}`), "home-coins-page");
    assert.deepEqual(symbols(byId.coins), ["TEST"]);
  }));

test("Discover: public and the same for every caller; trades hidden leave only presale kinds", { skip }, () =>
  withFixture(async ({ discover }) => {
    const plain = await ok<HomeCoinsPage>(await discover(), "home-coins-page");
    const withToken = await ok<HomeCoinsPage>(await discover("", { headers: { authorization: bearer(did("ben")), cookie: "__Host-blast_wallet=x" } }), "home-coins-page");
    assert.deepEqual({ ...withToken, as_of: null }, { ...plain, as_of: null });
    const hidden = await ok<HomeCoinsPage>(await discover("", { trades: false }), "home-coins-page");
    const eman = hidden.coins.find((coin) => coin.symbol === "EMAN")!;
    assert.deepEqual([eman.activity.events, eman.activity.claimers, eman.activity.buyers], [1, 1, 0]);
    assert.equal(hidden.coins.find((coin) => coin.symbol === "ORBIT")!.activity.events, 0);
  }));

test("Coins by id (the Watchlist): the order asked, presales included with commitments, the unshown ids named", { skip }, () =>
  withFixture(async ({ coins }) => {
    const unknown = hex("f00d");
    const body = await ok<HomeCoinsByIds>(await coins(`?presale=${P.halo}&presale=${P.orbit}&presale=${P.excluded}&presale=${P.incomplete}&presale=${unknown}&presale=${P.orbit}`), "home-coins-page");
    assert.deepEqual(symbols(body.coins), ["HALO", "ORBIT"]);
    assert.deepEqual(body.missing, [P.excluded, P.incomplete, unknown]);
    const halo = body.coins[0]!;
    assert.deepEqual([halo.lifecycle, halo.tradable, halo.launched_ms, halo.price_usd], ["open", false, null, null]);
    // Maya's two commits are one backer; commitments are commitments, never buys.
    assert.deepEqual([halo.activity.participants, halo.activity.backers, halo.activity.buyers, halo.activity.events], [2, 2, 0, 3]);
    assert.deepEqual(halo.activity.committed.map((amount) => [amount.quote_symbol, amount.atoms, amount.usd]), [["USDC", "170000000", "170.00"]]);
    assert.deepEqual(halo.activity.bought, []);
    assert.equal(halo.rank.why, "2 participants · 3 commitments in the last 24h");
    for (const bad of ["", "?presale=abc", `?presale=${P.orbit}&window=2h`]) assert.equal((await coins(bad)).status, 400, bad);
  }));

test("Migrated sale market: bounded top 100, grouped accounts, exact backend volume, and independent caches", { skip }, () =>
  withFixture(async ({ coins, admin }) => {
    await seedChainRead(admin, { coin_balances: Array.from({ length: 120 }, (_, index) => ({
      coin_type: coinOf(P.orbit, "ORBIT"), owner: hex(`d${index.toString(16).padStart(3, "0")}`),
      balance: String(index + 1), updated_checkpoint: 45_000,
    })) });
    const path = `?presale=${P.orbit}`;
    const standard = await ok<HomeCoinsByIds>(await coins(path), "home-coins-page");
    assert.equal(standard.coins[0]!.top_holders.holders.length, 10);
    const expanded = await ok<HomeCoinsByIds>(await coins(`${path}&holder_limit=100`), "home-coins-page");
    const coin = expanded.coins[0]!;
    const holders = coin.top_holders.holders;
    assert.equal(holders.length, 100);
    assert.deepEqual(holders.slice(0, 2).map((holder) => [holder.actor.type === "account" ? holder.actor.callsign : null, holder.balance, holder.share_bps]), [["jules", "5000000000000", 50], ["maya", "1500000000000", 15]]);
    assert.ok(holders.every((holder, index) => index === 0 || BigInt(holders[index - 1]!.balance) >= BigInt(holder.balance)));
    assert.deepEqual(expanded.pool_volumes?.[coin.coin_type]?.map((amount) => [amount.quote_symbol, amount.atoms]), [["USDC", "435000000"]]);
    assert.deepEqual(await ok<HomeCoinsByIds>(await coins(path), "home-coins-page"), standard);
    const hidden = await ok<HomeCoinsByIds>(await coins(`${path}&holder_limit=100`, { trades: false }), "home-coins-page");
    assert.equal(hidden.pool_volumes?.[coin.coin_type], null);
    assert.equal(hidden.coins[0]!.top_holders.holders.length, 100);
    const quiet = await ok<HomeCoinsByIds>(await coins(`?presale=${P.quiet}`), "home-coins-page");
    assert.equal(quiet.pool_volumes?.[quiet.coins[0]!.coin_type]?.[0]?.atoms, "0");
    for (const suffix of ["101", "0", "no", "100&holder_limit=10", `100&presale=${P.halo}`]) {
      assert.equal((await coins(`${path}&holder_limit=${suffix}`)).status, 400);
    }
  }, { cached: true }));

test("Traders: only public P&L appears, with ranked holdings and bounded public data", { skip }, () =>
  withFixture(async ({ traders, now }) => {
    const page = await ok<HomeTradersPage>(await traders(), "home-traders-page", "public, s-maxage=10");
    assert.equal(page.clock_ms, now);
    // Only Maya has opted into public P&L; active accounts with private P&L are omitted.
    assert.deepEqual(keysOf(page.traders), ["c:maya"]);
    const maya = page.traders[0]!;
    assert.deepEqual([maya.coins_total, maya.coins.map((coin) => coin.symbol), maya.events_total], [2, ["ORBIT", "HALO"], 6]);
    // The card: her directions in each coin, kept apart; the coin's identity for the words.
    assert.deepEqual(maya.coins.map((coin) => [coin.buys?.count ?? null, coin.sells?.count ?? null, coin.commits?.count ?? null, coin.claims, coin.decimals]), [[3, 1, null, null, 9], [null, null, 2, null, 9]]);
    assert.deepEqual([maya.coins[0]!.latest_ms, maya.coins[1]!.commits?.amounts[0]?.usd, maya.coins[0]!.icon_url], [now - 2 * MINUTE, "150.00", "https://cdn.blast.fun/ORBIT.png"]);
    assert.deepEqual([maya.buys?.count, maya.sells?.count, maya.commits?.count, maya.claims], [3, 1, 2, null]);
    assert.deepEqual([maya.buys?.amounts[0]?.usd, maya.sells?.amounts[0]?.usd, maya.commits?.amounts[0]?.usd], ["100.00", "25.00", "150.00"]);
    assert.deepEqual([maya.latest_kind, maya.latest_ms, maya.followers], ["trade_sell", now - 2 * MINUTE, 1]);
    // Maya shares her portfolio: 1,500 ORBIT at $0.05 is $75 held. Her ORBIT trades are the fixture's unstamped rows, which the
    // cost-basis ledger does not read (T-038 stamps every trade in production): by the profile's rule, holdings the ledger never
    // saw acquired carry no P&L, so the total is $0.00 (never a figure invented from the chain's unscoped rows).
    assert.deepEqual(maya.portfolio, { public: true, value_usd: "75.00", pnl_usd: "0.00" });
    assert.equal(maya.rank, 1);
    assert.deepEqual(maya.holdings?.map((holding) => [holding.symbol, holding.balance, holding.value_usd, holding.share_bps]), [["ORBIT", "1500000000000", "75.00", 10000]]);
    assert.ok(page.traders.every((trader) => trader.actor.type === "account"));
    // No wallet-only identity (the private account, the late-named one, the crowd), no hidden sale, no viewer field, no account id.
    assert.doesNotMatch(JSON.stringify(page), /aa05|aa06|bb01|0xcc|HID|INC|"(viewer|relation|account_id)"|00000000-0000-4000/);
    // The activity window changes eligibility, never the P&L privacy gate.
    const hour = await ok<HomeTradersPage>(await traders("?window=1h"), "home-traders-page", "public, s-maxage=10");
    assert.deepEqual([hour.window, keysOf(hour.traders)], ["1h", ["c:maya"]]);
    // Trades hidden: the presale kinds alone remain.
    const presaleOnly = await ok<HomeTradersPage>(await traders("", { trades: false }), "home-traders-page", "public, s-maxage=10");
    assert.deepEqual(presaleOnly.traders.map((trader) => [trader.key, trader.events_total, trader.coins.map((coin) => coin.symbol)]), [["c:maya", 2, ["HALO"]]]);
    assert.equal((await traders("?window=7d")).status, 400);
    assert.equal((await traders("?window=1h&window=24h")).status, 400);
  }));

test("Traders: global pages and literal name, handle and wallet search include 121 inactive accounts", { skip }, () =>
  withFixture(async ({ admin, traders, now }) => {
    const accounts = Array.from({ length: 121 }, (_, i) => ({ account_id: uuid(1000 + i), callsign: `quiet${String(i).padStart(3, "0")}`, display_name: `Quiet Trader ${i}`, wallet: hex((10000 + i).toString(16)) }));
    await admin.query(`INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, x_subject, x_handle, privacy, sharing_since, onboarded_at, portfolio_public)
      SELECT account_id::uuid, 'did:privy:' || callsign, callsign, display_name, 'x-' || callsign, 'x' || callsign, 'public', to_timestamp($2 / 1000.0), to_timestamp($2 / 1000.0), true
      FROM jsonb_to_recordset($1::jsonb) AS r(account_id text, callsign text, display_name text)`, [JSON.stringify(accounts), now - DAY]);
    await admin.query(`INSERT INTO social_account_wallets (account_id, address, verified_at)
      SELECT account_id::uuid, wallet, to_timestamp($2 / 1000.0) FROM jsonb_to_recordset($1::jsonb) AS r(account_id text, wallet text)`, [JSON.stringify(accounts), now - DAY]);
    await admin.query(`INSERT INTO blast_infra_fixture.wallet_sync(owner, timestamp_ms)
      SELECT wallet, $2 FROM jsonb_to_recordset($1::jsonb) AS r(wallet text)`, [JSON.stringify(accounts), now]);
    // A $0 trader is listed only while holding a coin.
    await admin.query(`INSERT INTO blast_infra_fixture.coin_balances(coin_type, owner, balance, updated_checkpoint)
      SELECT $2, wallet, 1, 45000 FROM jsonb_to_recordset($1::jsonb) AS r(wallet text)`, [JSON.stringify(accounts), coinOf(P.quiet, "QUIET")]);
    const start = performance.now();
    const first = await ok<HomeTradersPage>(await traders("?limit=50"), "home-traders-page", "public, s-maxage=10");
    const coldMs = performance.now() - start;
    const warmStart = performance.now();
    const second = await ok<HomeTradersPage>(await traders("?limit=50&page=2"), "home-traders-page", "public, s-maxage=10");
    const warmMs = performance.now() - warmStart;
    const third = await ok<HomeTradersPage>(await traders("?limit=50&page=3&window=1h"), "home-traders-page", "public, s-maxage=10");
    assert.deepEqual([first.total, first.global_total, first.traders.length, second.traders.length, third.traders.length], [122, 122, 50, 50, 22]);
    assert.equal(new Set([...first.traders, ...second.traders, ...third.traders].map((row) => row.key)).size, 122);
    assert.ok(third.traders.every((row) => row.events_total === 0 && row.rank === 1));
    for (const search of ["Quiet Trader 120", "@QUIET120", "@xquiet120", accounts[120].wallet.toUpperCase()]) {
      const page = await ok<HomeTradersPage>(await traders(`?search=${encodeURIComponent(search)}`), "home-traders-page", "public, s-maxage=10");
      assert.deepEqual([page.total, page.global_total, keysOf(page.traders), page.traders[0]?.rank], [1, 122, ["c:quiet120"], 1]);
      assert.doesNotMatch(JSON.stringify(page.traders), new RegExp(`account_id|did:privy|${accounts[120].wallet}`, "i"));
    }
    const noMatches = await ok<HomeTradersPage>(await traders("?search=%25_"), "home-traders-page", "public, s-maxage=10");
    assert.deepEqual([noMatches.total, noMatches.traders, noMatches.page], [0, [], 1]);
    await admin.query("UPDATE social_accounts SET portfolio_public = false WHERE account_id = $1", [accounts[120].account_id]);
    const privatePage = await ok<HomeTradersPage>(await traders(`?search=${accounts[120].wallet}`), "home-traders-page", "public, s-maxage=10");
    assert.deepEqual([privatePage.total, privatePage.global_total, privatePage.traders], [0, 121, []], "a cached financial read cannot reveal an opted-out account");
    await admin.query("UPDATE social_accounts SET sharing_since = NULL WHERE account_id = $1", [accounts[119].account_id]);
    const neverSharing = await ok<HomeTradersPage>(await traders("?search=@quiet119"), "home-traders-page", "public, s-maxage=10");
    assert.equal(neverSharing.total, 0);
    for (const bad of ["?page=0", "?limit=51", "?search=a&search=b"]) assert.equal((await traders(bad)).status, 400);
    console.log(`Global leaderboard 122 accounts: cold ${Math.round(coldMs)}ms, warm page ${Math.round(warmMs)}ms (local disposable PostgreSQL)`);
  }, { cached: true }));

test("The thread: participants grouped, mixed directions visible, the events beneath, keyset pages without repeats", { skip }, () =>
  withFixture(async ({ admin, thread }) => {
    const orbit = await ok<HomeThreadPage>(await thread(`?presale=${P.orbit}`), "home-thread-page");
    assert.deepEqual(keysOf(orbit.participants), ["c:maya", "c:leo", "c:jules", `w:${W.priv}`, `w:${W.late}`, `w:${W.anon}`]);
    const maya = orbit.participants[0]!;
    assert.deepEqual([maya.buys?.count, maya.sells?.count, maya.events_total, maya.events?.length, maya.events_more], [3, 1, 4, 4, false]);
    assert.deepEqual(maya.events!.map((event) => event.kind), ["trade_sell", "trade_buy", "trade_buy", "trade_buy"]);
    assert.equal(maya.events![0]!.quote?.atoms, "25000000");
    assert.equal(maya.events![3]!.has_why, true);
    assert.equal(maya.events![0]!.has_why, false);
    // Ben follows Maya; nobody follows the anonymous wallets (unknown, not 0).
    assert.equal(maya.followers, 1);
    assert.equal(orbit.participants[5]!.followers, null);
    // Seven follow Jules, but priv is private: Home counts public followers only, as the profile does.
    const jules = orbit.participants[2]!;
    assert.equal(jules.followers, 6);
    const anon = orbit.participants[5]!;
    assert.deepEqual([anon.events_total, anon.events!.map((event) => event.activity_id.split(":")[3])], [2, ["1", "0"]]);
    assert.deepEqual([orbit.totals.participants, orbit.totals.events, orbit.totals.sellers], [6, 10, 2]);
    assert.equal(orbit.next_cursor, null);
    const crowd = await ok<HomeThreadPage>(await thread(`?presale=${P.crowd}`), "home-thread-page");
    assert.equal(crowd.participants.length, HOME_THREAD_PAGE);
    assert.ok(crowd.next_cursor);
    const rest = await ok<HomeThreadPage>(await thread(`?presale=${P.crowd}&cursor=${encodeURIComponent(crowd.next_cursor!)}`), "home-thread-page");
    assert.equal(rest.participants.length, 3);
    assert.equal(rest.next_cursor, null);
    assert.equal(new Set([...keysOf(crowd.participants), ...keysOf(rest.participants)]).size, 23);
    assert.equal(rest.totals.participants, 23);
    const empty = await ok<HomeThreadPage>(await thread(`?presale=${P.quiet}`), "home-thread-page");
    assert.deepEqual([empty.participants, empty.totals.participants], [[], 0]);
    const pinned = `?presale=${P.orbit}&at=${checkpoint}`;
    const behind = await thread(pinned);
    assert.equal(behind.status, 503);
    assert.equal(behind.headers.get("cache-control"), "no-store");
    await admin.query(advanceWatermark(checkpoint, 0, "market"));
    const caughtUp = await ok<HomeThreadPage>(await thread(pinned), "home-thread-page");
    assert.equal(caughtUp.totals.events, orbit.totals.events + 1);
    for (const bad of ["", "?presale=x", `?presale=${P.orbit}&cursor=zzz`, `${pinned}&at=0`, `?presale=${P.orbit}&at=-1`]) assert.equal((await thread(bad)).status, 400, bad);
  }));

test("The thread under a trade floor: a dust burst cannot hide the window's real trades; unproven trades stay; the totals stay whole", { skip }, () =>
  withFixture(async ({ admin, now, thread }) => {
    // 25 wallets trade a cent each, newer than every CROWD buy; checkpoints under the watermark, so all are committed.
    const at = (n: number, ms: number, row: Partial<ChainActivityRow>) => activity("trade_buy", hex(`d0${n.toString(16).padStart(2, "0")}`), CROWD, ms, { checkpoint: 49_000 + n, ...row });
    const dust = Array.from({ length: 25 }, (_, n) => at(n, now - 50_000 + n * 1_000, { quote_amount: "10000", usd_value: "0.01" }));
    const unpriced = at(30, now - 55_000, { quote_type: SUI, quote_amount: "1000", usd_value: null });
    const atPar = at(31, now - 56_000, { quote_amount: "1000000", usd_value: "0.99" });
    const suiDust = at(32, now - 57_000, { quote_type: SUI, quote_amount: "100000000", usd_value: "0.35" });
    const usdcDust = at(33, now - 58_000, { quote_amount: "990000", usd_value: null });
    await seedChainRead(admin, { activity: [...dust, unpriced, atPar, suiDust, usdcDust] });
    const all = await ok<HomeThreadPage>(await thread(`?presale=${P.crowd}`), "home-thread-page");
    assert.deepEqual(keysOf(all.participants), dust.slice(5).reverse().map((row) => `w:${row.actor}`));
    const floored = await ok<HomeThreadPage>(await thread(`?presale=${P.crowd}&min_trade_usd=1`), "home-thread-page");
    assert.deepEqual(keysOf(floored.participants).slice(0, 3), [`w:${unpriced.actor}`, `w:${atPar.actor}`, `w:${hex("cc16")}`]);
    assert.equal(floored.participants.length, HOME_THREAD_PAGE);
    assert.ok(!keysOf(floored.participants).some((key) => key === `w:${suiDust.actor}` || key === `w:${usdcDust.actor}`));
    assert.deepEqual(floored.totals, all.totals);
    for (const bad of ["0", "2", "1.5", "01", "1&min_trade_usd=1"]) assert.equal((await thread(`?presale=${P.crowd}&min_trade_usd=${bad}`)).status, 400, bad);
  }));

test("Tiny trades (under a cent): no list shows them and no count counts them, the switch on or off; the volume sums them", { skip }, () =>
  withFixture(async ({ admin, now, thread }) => {
    const before = await ok<HomeThreadPage>(await thread(`?presale=${P.orbit}`), "home-thread-page");
    const at = (n: number, kind: string, actor: string, row: Partial<ChainActivityRow>) => activity(kind, actor, ORBIT, now - 40_000 - n * 1_000, { checkpoint: 49_100 + n, ...row });
    // USDC proven tiny by its atoms ($0.009999, no USD), SUI by its USD, and Maya's tiny sell beside her real one.
    const usdcTiny = at(0, "trade_buy", hex("7e00"), { quote_amount: "9999", usd_value: null });
    const suiTiny = at(1, "trade_sell", hex("7e01"), { quote_type: SUI, quote_amount: "1000", usd_value: "0.004" });
    const mayaTiny = at(2, "trade_sell", W.mayaA, { quote_amount: "5000", usd_value: "0.005" });
    // A cent is not tiny.
    const cent = at(3, "trade_buy", hex("7e03"), { quote_amount: "10000", usd_value: "0.01" });
    await seedChainRead(admin, { activity: [usdcTiny, suiTiny, mayaTiny, cent] });
    for (const query of ["", "&min_trade_usd=1"]) {
      const after = await ok<HomeThreadPage>(await thread(`?presale=${P.orbit}${query}`), "home-thread-page");
      const keys = keysOf(after.participants);
      assert.ok(!keys.includes(`w:${usdcTiny.actor}`) && !keys.includes(`w:${suiTiny.actor}`), query);
      assert.equal(keys.includes(`w:${cent.actor}`), query === "", query);
      const maya = after.participants.find((row) => row.key === "c:maya")!;
      assert.deepEqual([maya.sells?.count, maya.events_total, maya.events!.length], [1, 4, 4], query);
      const { totals } = after;
      assert.deepEqual([totals.participants, totals.events, totals.buyers, totals.sellers],
        [before.totals.participants + 1, before.totals.events + 1, before.totals.buyers + 1, before.totals.sellers], query);
      const atoms = (amounts: typeof totals.sold, type: string) => BigInt(amounts.find((amount) => amount.quote_type === type)?.atoms ?? "0");
      assert.equal(atoms(totals.sold, QUOTE) - atoms(before.totals.sold, QUOTE), 5_000n, "the tiny sell is volume");
      assert.equal(atoms(totals.sold, SUI) - atoms(before.totals.sold, SUI), 1_000n);
      assert.equal(atoms(totals.bought, QUOTE) - atoms(before.totals.bought, QUOTE), 19_999n);
    }
  }));

test("The discussion: the sale's posts with a why, newest first, as feed items; empty is empty; a hidden sale has no page", { skip }, () =>
  withFixture(async ({ discussion, ids }) => {
    // T-043: a sale the web does not show has no discussion to read, whatever its posts were stamped with.
    assert.equal((await discussion(`?presale=${P.excluded}`)).status, 404);
    const orbit = await ok<HomeDiscussionPage>(await discussion(`?presale=${P.orbit}`), "home-discussion-page");
    assert.deepEqual(orbit.items.map((item) => item.entry_id), [ids.leoSell, ids.mayaBuy1]);
    assert.deepEqual(orbit.items.map((item) => item.why?.text), ["Taking profit here.", "In for the pool depth."]);
    assert.equal(orbit.items[0]!.actor?.type === "account" && orbit.items[0]!.actor.callsign, "leo");
    assert.equal(orbit.total, 2);
    const one = await ok<HomeDiscussionPage>(await discussion(`?presale=${P.orbit}&limit=1`), "home-discussion-page");
    assert.equal(one.items.length, 1);
    assert.ok(one.next_cursor);
    const next = await ok<HomeDiscussionPage>(await discussion(`?presale=${P.orbit}&limit=1&cursor=${encodeURIComponent(one.next_cursor!)}`), "home-discussion-page");
    assert.deepEqual(next.items.map((item) => item.entry_id), [ids.mayaBuy1]);
    const eman = await ok<HomeDiscussionPage>(await discussion(`?presale=${P.eman}`), "home-discussion-page");
    assert.deepEqual([eman.items, eman.total], [[], 0]);
    assert.equal((await discussion("?presale=x")).status, 400);
  }));

test("Following: strictly the viewer's follows, previews and threads scoped, discussion-only labelled, private and visitor states", { skip }, () =>
  withFixture(async ({ admin, following }) => {
    const ben = await ok<HomeFollowingResponse>(await following("ben", { mode: "coins", window: "24h" }), "home-following-response", "private, no-store");
    assert.equal(ben.mode, "coins");
    assert.equal(ben.mode, "coins");
    assert.equal(ben.following, 4);
    // By the latest followed activity or post: Maya's sell 2 min ago, Cyra's post 10 min ago, Maya's commit 30 min ago.
    assert.deepEqual(symbols(ben.coins), ["ORBIT", "QUIET", "HALO"]);
    const orbit = ben.coins[0]!;
    // Ben follows Maya, Leo and Jules (everyone does): three participants, their six events; the wallets and Satoshi never appear.
    assert.deepEqual([orbit.qualified, orbit.activity.scope, orbit.activity.participants, orbit.activity.buyers, orbit.activity.sellers, orbit.activity.events], ["activity", "followed", 3, 2, 2, 6]);
    assert.deepEqual(keysOf(orbit.activity.preview), ["c:maya", "c:leo", "c:jules"]);
    assert.ok(orbit.activity.preview.every((row) => row.relation === "followed"));
    // The biggest holders are the coin's public fact (the same for every reader) and may name any wallet; the followed activity never does.
    assert.doesNotMatch(JSON.stringify(ben, (key, value: unknown) => (key === "top_holders" ? undefined : value)), /satoshi|bb01|aa05|aa06/);
    const halo = ben.coins[2]!;
    assert.deepEqual([halo.lifecycle, halo.activity.backers, halo.activity.participants], ["open", 1, 1]);
    const quiet = ben.coins[1]!;
    assert.deepEqual([quiet.qualified, quiet.activity.events, quiet.discussion.posts], ["discussion", 0, 1]);
    const preview = await ok<HomeFollowingResponse>(await following("ben", { mode: "preview", window: "24h", presale_ids: [P.orbit, P.eman] }), "home-following-response", "private, no-store");
    assert.equal(preview.mode, "preview");
    assert.deepEqual([preview.previews[P.orbit]!.participants, preview.previews[P.eman]!.participants, preview.previews[P.eman]!.preview], [3, 0, []]);
    const thread = await ok<HomeFollowingResponse>(await following("ben", { mode: "thread", window: "24h", presale_id: P.orbit }), "home-following-response", "private, no-store");
    assert.equal(thread.mode, "thread");
    assert.deepEqual(keysOf(thread.participants), ["c:maya", "c:leo", "c:jules"]);
    assert.deepEqual([thread.totals.scope, thread.totals.participants, thread.participants[0]!.relation, thread.participants[0]!.events?.length], ["followed", 3, "followed", 4]);
    // The tape: the followed accounts' events across every coin, newest first; wallets and the unfollowed never appear.
    const tape = await ok<HomeFollowingResponse>(await following("ben", { mode: "tape", window: "24h" }), "home-following-response", "private, no-store");
    assert.equal(tape.mode, "tape");
    assert.ok(tape.events.length >= 6 && tape.events.length <= 12, `${tape.events.length} tape events`);
    assert.ok(tape.events.every((event, index) => index === 0 || tape.events[index - 1]!.occurred_at_ms >= event.occurred_at_ms), "newest first");
    assert.deepEqual([tape.events[0]!.actor.type === "account" ? tape.events[0]!.actor.callsign : null, tape.events[0]!.kind, tape.events[0]!.coin.symbol], ["maya", "trade_sell", "ORBIT"]);
    assert.ok(tape.events.every((event) => event.actor.type === "account" && ["maya", "leo", "jules", "cyra"].includes(event.actor.callsign)));
    assert.doesNotMatch(JSON.stringify(tape), /satoshi|bb01|aa05|aa06/);
    // Each tape event carries the coin's cap right after it, when the indexer stamped one.
    assert.ok(tape.events.every((event) => event.market_cap_usd === null), "no cap stamped yet");
    await admin.query("UPDATE blast_infra_fixture.activity SET market_cap_usd = 45000.5 WHERE actor = ANY($1::text[]) AND kind = 'trade_sell'", [[W.mayaA, W.mayaB]]);
    const capped = await ok<HomeFollowingResponse>(await following("ben", { mode: "tape", window: "24h" }), "home-following-response", "private, no-store");
    assert.equal(capped.mode, "tape");
    assert.deepEqual([capped.events[0]!.kind, capped.events[0]!.market_cap_usd], ["trade_sell", "45000.50"]);
    assert.ok(capped.events.filter((event) => event.kind !== "trade_sell").every((event) => event.market_cap_usd === null));
    const solo = await ok<HomeFollowingResponse>(await following("solo", { mode: "coins", window: "24h" }), "home-following-response", "private, no-store");
    assert.equal(solo.mode, "coins");
    assert.deepEqual([solo.following, solo.coins], [0, []]);
    assert.equal((await following(null, { mode: "coins", window: "24h" })).status, 401);
    for (const bad of [{ mode: "coins" }, { mode: "coins", window: "24h", limit: 0 }, { mode: "preview", window: "1h", presale_ids: [] }, { mode: "thread", window: "1h" }, { mode: "tape", window: "1h", limit: 5 }, { mode: "x", window: "1h" }]) {
      assert.equal((await following("ben", bad)).status, 400, JSON.stringify(bad));
    }
  }));


test("Following covers every Blast coin: a followed account's launch vault coin and live curve trades reach the tape, the coins and the preview; an unfollowed account's never do", { skip }, () =>
  withFixture(async ({ admin, following, now }) => {
    await admin.query("INSERT INTO blast_infra_fixture.coin_metadata (coin_type,name,symbol,decimals) VALUES ($1,'USD Coin','USDC',6)", [QUOTE]);
    const metadata = (coinType: string, symbol: string) =>
      admin.query("INSERT INTO blast_infra_fixture.coin_metadata (coin_type,name,symbol,decimals) VALUES ($1,$2,$2,9)", [coinType, symbol]);
    // VAULT: launched straight into a Cetus launch vault, no presale.
    const vault = coinOf(hex("fa1"), "VAULT");
    await metadata(vault, "VAULT");
    await admin.query(`INSERT INTO blast_infra_fixture.vaults
      (vault_id,origin_kind,origin_id,meme_type,venue_type,venue,pool_id,quote_type,created_checkpoint,created_tx_slot)
      VALUES ($1,'launch',$1,$2,$3,'cetus',$1,$4,40000,0)`, [hex("fa10"), vault, `${hex("f")}::cetus::Venue`, QUOTE]);
    // CURVE and OTHER: bonding curves still filling, no vault yet.
    const liveCurve = async (id: string, symbol: string) => {
      const coinType = coinOf(hex(id), symbol);
      const poolKey = `blast_curve:${hex(`${id}0`)}`;
      await metadata(coinType, symbol);
      await admin.query(`INSERT INTO coins (coin_type,decimals,launcher,creator,metadata,pool_key,created_checkpoint,created_at_ms,currency_supply,balance_0x0)
        VALUES ($1,9,$2,$2,'{}',$3,41000,$4,1000000000000000000,0)`, [coinType, W.anon, poolKey, now - 2 * DAY]);
      await admin.query(`INSERT INTO pools (pool_key,venue,coin_type,quote_type,lifecycle,created_checkpoint,created_at_ms,quote_reserve,params)
        VALUES ($1,'blast_curve',$2,$3,'live',41000,$4,'2000000000',$5)`, [poolKey, coinType, QUOTE, now - 2 * DAY, { graduation_target: "8000000000" }]);
      return coinType;
    };
    const curve = await liveCurve("fc1", "CURVE");
    const other = await liveCurve("fc2", "OTHER");
    const trade = (kind: string, actor: string, coinType: string, agoMs: number, cp: number, venue: string) =>
      activity(kind, actor, null, now - agoMs, { checkpoint: cp, coin_type: coinType, coin_amount: "1000000000", quote_amount: "50000000", usd_value: "50", venue });
    await seedChainRead(admin, {
      activity: [
        // Maya (followed by ben) buys VAULT and sells CURVE.
        trade("trade_buy", W.mayaA, vault, 30_000, 49_980, "cetus"),
        trade("trade_sell", W.mayaB, curve, 40_000, 49_981, "blast_curve"),
        // Satoshi (named, not followed by ben) and an unnamed wallet: never in ben's reads.
        trade("trade_buy", W.satoshi, other, 20_000, 49_982, "blast_curve"),
        trade("trade_buy", W.anon, vault, 10_000, 49_983, "cetus"),
      ],
    });

    const tape = await ok<HomeFollowingResponse>(await following("ben", { mode: "tape", window: "24h" }), "home-following-response", "private, no-store");
    assert.equal(tape.mode, "tape");
    const standalone = tape.events.filter((event) => event.coin.presale_id === null);
    assert.deepEqual(standalone.map((event) => [event.actor.type === "account" ? event.actor.callsign : null, event.kind, event.coin.symbol, event.coin.coin_type]),
      [["maya", "trade_buy", "VAULT", vault], ["maya", "trade_sell", "CURVE", curve]]);
    assert.equal(tape.events[0]!.coin.coin_type, vault, "newest first, across presale and standalone coins");
    assert.doesNotMatch(JSON.stringify(tape), /satoshi|OTHER|bb01/);

    const ben = await ok<HomeFollowingResponse>(await following("ben", { mode: "coins", window: "24h" }), "home-following-response", "private, no-store");
    assert.equal(ben.mode, "coins");
    assert.deepEqual(symbols(ben.coins), ["VAULT", "CURVE", "ORBIT", "QUIET", "HALO"]);
    const [vaultCoin, curveCoin] = ben.coins;
    assert.deepEqual([vaultCoin!.presale_id, vaultCoin!.coin_type, vaultCoin!.activity.scope, vaultCoin!.activity.participants, vaultCoin!.activity.buyers], [null, vault, "followed", 1, 1]);
    assert.deepEqual(keysOf(vaultCoin!.activity.preview), ["c:maya"]);
    assert.deepEqual([curveCoin!.presale_id, curveCoin!.coin_type, curveCoin!.activity.participants, curveCoin!.activity.sellers], [null, curve, 1, 1]);

    const preview = await ok<HomeFollowingResponse>(await following("ben", { mode: "preview", window: "24h", presale_ids: [vault, curve, other, P.orbit] }), "home-following-response", "private, no-store");
    assert.equal(preview.mode, "preview");
    assert.deepEqual([vault, curve, other, P.orbit].map((id) => preview.previews[id]!.participants), [1, 1, 0, 3]);
    assert.deepEqual(keysOf(preview.previews[vault]!.preview), ["c:maya"]);
    assert.ok(preview.previews[vault]!.preview.every((row) => row.relation === "followed"));
  }));

test("Discover and saved coins fill missing price and supply from tracked pools independently", { skip }, () => {
  const bySymbol = new Map(INDEXED_POOL_COINS.map((coin) => [coin.symbol, coin]));
  const manifest = bySymbol.get("MANIFEST")!;
  const wheels = bySymbol.get("Wheels")!;
  const blast = bySymbol.get("BLAST")!;
  const helmet = bySymbol.get("HELMET")!;
  const one = bySymbol.get("ONE")!;
  let snapshots = 0;
  let poolPricesAvailable = true;
  return withFixture(async ({ admin, coins, discover, market, now }) => {
    // The window read every sort shares fills catalog FDV from one snapshot read, and the page reuses it.
    await ok<HomeCoinsPage>(await discover("?page=1&limit=5&sort=newest"), "home-coins-page");
    assert.equal(snapshots, 1);
    await ok<HomeCoinsPage>(await discover("?page=1&limit=5"), "home-coins-page");
    assert.equal(snapshots, 2);
    const page = await ok<HomeCoinsPage>(await discover("?page=2&limit=5&mobile_market=1&live_inputs=1&rolling_change=1&dex_volume=1"), "home-coins-page");
    // ONE's snapshot FDV ($12.50) lifts it to page 1, above the idle coins with no value.
    const idle = TRACKED.filter((coin) => coin !== one);
    const total = FIXTURE_SYMBOLS.length + TRACKED.length;
    assert.deepEqual([page.page, page.pages, page.total, symbols(page.coins)], [2, Math.ceil(total / 5), total, ["QUIET", ...idle.slice(0, 4).map((coin) => coin.symbol)]]);
    // Each tracked row names its pool's venue, its decimals and its badge.
    const identity = (coin: (typeof TRACKED)[number]) => [coin.coinType, coin.poolKey.split(":")[0], coin.decimals, "verifiedTeam" in coin ? coin.verifiedTeam : undefined];
    assert.deepEqual(page.coins.slice(1).map((coin) => [coin.coin_type, coin.venue, coin.decimals, coin.verified_team]), idle.slice(0, 4).map(identity));
    const first = await ok<HomeCoinsPage>(await discover("?page=1&limit=5&mobile_market=1&live_inputs=1&rolling_change=1&dex_volume=1"), "home-coins-page");
    const oneRow = first.coins.find((coin) => coin.coin_type === one.coinType);
    assert.deepEqual([oneRow?.coin_type, oneRow?.venue, oneRow?.decimals, oneRow?.verified_team], [one.coinType, "cetus", 6, undefined]);
    assert.equal(snapshots, 4);
    const every = await ok<HomeCoinsPage>(await discover("?limit=50&mobile_market=1&live_inputs=1&rolling_change=1&dex_volume=1"), "home-coins-page");
    assert.deepEqual(every.coins.filter((coin) => TRACKED_SYMBOLS.includes(coin.symbol)).map((coin) => [coin.coin_type, coin.venue, coin.decimals, coin.verified_team]),
      [one, ...idle].map(identity));
    const wheelsRow = every.coins.find((coin) => coin.coin_type === wheels.coinType);
    const manifestRow = every.coins.find((coin) => coin.coin_type === manifest.coinType);
    assert.ok(wheelsRow && oneRow && manifestRow);
    assert.deepEqual([wheelsRow.price_usd, wheelsRow.fdv_usd, wheelsRow.mobile_market?.market_cap_usd], ["0.01", null, null]);
    assert.deepEqual([oneRow.price_usd, oneRow.price_as_of_ms, oneRow.fdv_usd], ["0.000625", now - MINUTE, "12.50"]);
    assert.deepEqual(oneRow.mobile_market, { market_cap_usd: "9.38", change_1h_bps: null });
    assert.deepEqual([oneRow.live_inputs?.total_supply, oneRow.live_inputs?.circulating_supply], ["20000000000", "15000000000"]);
    assert.equal(oneRow.change_24h_bps, null);
    assert.equal(oneRow.live_inputs?.price_checkpoint, undefined);
    assert.deepEqual([manifestRow.presale_id, manifestRow.sale, manifestRow.launch_id, manifestRow.launched_ms], [null, null, null, null]);
    assert.deepEqual([manifestRow.price_usd, manifestRow.holders, manifestRow.fdv_usd, manifestRow.spark], [null, null, null, []]);
    assert.equal(manifestRow.dex_volume, undefined);
    assert.equal(manifestRow.rank.why, "No indexed activity in the last 24h");
    const saved = await ok<HomeCoinsByIds>(await coins(`?presale=${encodeURIComponent(one.coinType)}`), "home-coins-page");
    assert.deepEqual([symbols(saved.coins), saved.missing, saved.pool_volumes?.[one.coinType]], [["ONE"], [], null]);
    assert.deepEqual([saved.coins[0]?.price_usd, saved.coins[0]?.fdv_usd], ["0.000625", "12.50"]);
    assert.equal((await market(`?coin=${encodeURIComponent(one.coinType)}`)).status, 404);

    const shownPresaleId = hex("c001");
    await seedChainRead(admin, {
      presales: [
        presale(shownPresaleId, "Wheels", "migrated", { sale_token: wheels.coinType, venue: "cetus" }),
        presale(hex("c002"), "HELMET", "migrated", {
          sale_token: helmet.coinType, quote_type: CREATE_TEST_SUI_QUOTE_TYPE, quote_symbol: "TEST_SUI", quote_decimals: 9,
        }),
        presale(hex("c004"), "BLAST", "migrated", {
          sale_token: blast.coinType, sale_symbol: null, sale_name: null, sale_icon_url: null, sale_decimals: null,
        }),
      ],
      prices: [{ coin_type: one.coinType, usd_price: "0.002", as_of_ms: now, source: "pool" }],
    });
    await admin.query(`INSERT INTO blast_infra_fixture.coin_metadata (coin_type,name,symbol,decimals)
      VALUES ($1,'MANIFEST','MANIFEST',9), ($2,'Usd Coin','USDC',6)`, [manifest.coinType, QUOTE]);
    await admin.query(`INSERT INTO blast_infra_fixture.vaults
      (vault_id,origin_kind,origin_id,meme_type,venue_type,venue,pool_id,quote_type,created_checkpoint,created_tx_slot)
      VALUES ($1,'launch',$1,$2,$3,'bluefin',$1,$4,40000,0)`,
    [hex("c003"), manifest.coinType, `${hex("f")}::bluefin::Venue`, QUOTE]);
    const overlaps = await ok<HomeCoinsPage>(await discover("?mobile_market=1&limit=50"), "home-coins-page");
    // HELMET's and BLAST's presales take their pools off the list; Wheels and MANIFEST each keep one row.
    assert.equal(overlaps.total, FIXTURE_SYMBOLS.length + TRACKED.length - 2);
    assert.deepEqual(overlaps.coins.filter((coin) => coin.coin_type === manifest.coinType)
      .map((coin) => [coin.venue, coin.quote.symbol, coin.verified_team]), [["bluefin", "USDC", true]]);
    assert.deepEqual(overlaps.coins.filter((coin) => coin.coin_type === wheels.coinType).map((coin) => [coin.presale_id, coin.price_usd]), [[shownPresaleId, null]]);
    assert.ok(!overlaps.coins.some((coin) => coin.coin_type === helmet.coinType || coin.coin_type === blast.coinType));
    // Known deployer only keeps exactly the coins the badge marks, Blast v1 coins included, in the same order.
    const everyCoin = await ok<HomeCoinsPage>(await discover("?limit=50"), "home-coins-page");
    const known = await ok<HomeCoinsPage>(await discover("?known_deployer=1&limit=50"), "home-coins-page");
    assert.deepEqual(symbols(known.coins), symbols(everyCoin.coins.filter((coin) => coin.verified_team === true)));
    assert.equal(known.total, known.coins.length);
    assert.ok(known.coins.some((coin) => coin.coin_type === manifest.coinType));
    assert.ok(!known.coins.some((coin) => coin.coin_type === one.coinType));
    const indexedOne = overlaps.coins.find((coin) => coin.coin_type === one.coinType);
    assert.deepEqual([indexedOne?.price_usd, indexedOne?.price_as_of_ms, indexedOne?.fdv_usd, indexedOne?.mobile_market?.market_cap_usd], ["0.002", now, "40.00", "30.00"]);
    poolPricesAvailable = false;
    const oneQuery = `?presale=${encodeURIComponent(one.coinType)}&mobile_market=1`;
    const supplyOnly = await ok<HomeCoinsByIds>(await coins(oneQuery), "home-coins-page");
    assert.deepEqual([supplyOnly.coins[0]?.price_usd, supplyOnly.coins[0]?.fdv_usd, supplyOnly.coins[0]?.mobile_market?.market_cap_usd], ["0.002", "40.00", "30.00"]);

    await admin.query(`INSERT INTO coins (coin_type,decimals,launcher,created_checkpoint,created_at_ms,currency_supply,balance_0x0)
      VALUES ($1,6,$2,40000,$3,30000000000,5000000000)`, [one.coinType, W.anon, now]);
    const readsBeforeIndexedSupply = snapshots;
    const indexedSupply = await ok<HomeCoinsByIds>(await coins(oneQuery), "home-coins-page");
    assert.deepEqual([indexedSupply.coins[0]?.fdv_usd, indexedSupply.coins[0]?.mobile_market?.market_cap_usd], ["60.00", "50.00"]);
    assert.equal(snapshots, readsBeforeIndexedSupply);
  }, {
    trackedPoolMarket: async (now) => {
      snapshots += 1;
      const asOfMs = now - MINUTE;
      return {
        [one.coinType]: {
          ...(poolPricesAvailable && { price: { priceUsd: "0.000625", asOfMs } }),
          totalSupplyAtoms: "20000000000",
          circulatingSupplyAtoms: "15000000000",
        },
        [wheels.coinType]: { price: { priceUsd: "0.01", asOfMs } },
      };
    },
  });
});

test("Tracked pool coins date Age from their package publish and share Top 10 of the node supply", { skip }, () => {
  const bySymbol = new Map(INDEXED_POOL_COINS.map((coin) => [coin.symbol, coin]));
  const one = bySymbol.get("ONE")!;
  const helmet = bySymbol.get("HELMET")!;
  const published = new Map<string, number>([[one.coinType, 1_700_000_000_000], [helmet.coinType, 1_690_000_000_000]]);
  const asked: string[] = [];
  return withFixture(async ({ admin, coins, discover, holders, now }) => {
    await seedChainRead(admin, {
      coin_balances: [
        { coin_type: one.coinType, owner: W.anon, balance: "3000000000", updated_checkpoint: 45_000 },
        { coin_type: one.coinType, owner: W.solo, balance: "1500000000", updated_checkpoint: 45_000 },
        // Its tracked pool's own balance is never a holder.
        { coin_type: one.coinType, owner: one.poolKey.slice(one.poolKey.indexOf(":") + 1), balance: "9000000000", updated_checkpoint: 45_000 },
      ],
    });
    const saved = await ok<HomeCoinsByIds>(await coins(`?presale=${encodeURIComponent(one.coinType)}&presale=${encodeURIComponent(helmet.coinType)}`), "home-coins-page");
    assert.deepEqual(saved.coins.map((coin) => [coin.symbol, coin.launched_ms]), [["ONE", 1_700_000_000_000], ["HELMET", 1_690_000_000_000]]);
    // 3 and 1.5 of the node's 15 circulating: 20 % and 10 %, 30 % together.
    const [oneRow] = saved.coins;
    assert.deepEqual(oneRow?.top_holders.holders.map((holder) => holder.share_bps), [2_000, 1_000]);
    assert.equal(oneRow?.top_holders.share_bps, 3_000);
    // Its holders list (the coin page's Holders panel) has the same holders and shares, not a 404.
    const oneHolders = await ok<HomeHoldersPage>(await holders(`?coin=${encodeURIComponent(one.coinType)}&limit=10`), "home-holders-page", "public, s-maxage=10");
    assert.deepEqual(oneHolders.holders.map((holder) => [holder.balance, holder.share_bps]), [["3000000000", 2_000], ["1500000000", 1_000]]);

    const page = await ok<HomeCoinsPage>(await discover("?limit=50"), "home-coins-page");
    const launchedOf = (coinType: string) => page.coins.find((coin) => coin.coin_type === coinType)?.launched_ms;
    assert.deepEqual([launchedOf(one.coinType), launchedOf(helmet.coinType)], [1_700_000_000_000, 1_690_000_000_000]);
    // A tracked coin with no publish time read stays undated; a Blast launch keeps its own launch.
    assert.equal(launchedOf(bySymbol.get("MANIFEST")!.coinType), null);
    assert.equal(page.coins.find((coin) => coin.symbol === "ORBIT")?.launched_ms, now - 2 * DAY);
    // Only tracked pool coins are ever asked for.
    const tracked = new Set<string>(INDEXED_POOL_COINS.map((coin) => coin.coinType));
    assert.ok(asked.length > 0 && asked.every((coinType) => tracked.has(coinType)));
  }, {
    trackedPoolMarket: async () => ({ [one.coinType]: { totalSupplyAtoms: "20000000000", circulatingSupplyAtoms: "15000000000" } }),
    trackedPoolLaunches: async (coinTypes) => {
      asked.push(...coinTypes);
      return new Map(coinTypes.flatMap((coinType) => (published.has(coinType) ? [[coinType, published.get(coinType)!] as const] : [])));
    },
  });
});

test("Standalone Cetus and Bluefin coins use Discover, without a presale or duplicate coin rows", { skip }, () =>
  withFixture(async ({ admin, discover, coins, thread, market, holders, now }) => {
    const native = coinOf(hex("ca7"), "NATIVE");
    const blue = coinOf(hex("b1"), "BLUE");
    await admin.query("INSERT INTO blast_infra_fixture.coin_metadata (coin_type,name,symbol,decimals) VALUES ($1,'USD Coin','USDC',6)", [QUOTE]);
    const insert = async (id: string, coin: string, venue: "cetus" | "bluefin", symbol: string, { decimals = 9, slot = 0, origin = "launch" }: { decimals?: number | null; slot?: number; origin?: "launch" | "presale" } = {}) => {
      await admin.query(`INSERT INTO blast_infra_fixture.coin_metadata (coin_type,name,symbol,decimals)
        VALUES ($1,$2,$2,$3) ON CONFLICT (coin_type) DO NOTHING`, [coin,symbol,decimals]);
      await admin.query(`INSERT INTO blast_infra_fixture.vaults
        (vault_id,origin_kind,origin_id,meme_type,venue_type,venue,pool_id,quote_type,created_checkpoint,created_tx_slot)
        VALUES ($1,$2,$1,$3,$4,$5,$1,$6,40000,$7)`, [id,origin,coin,`${hex("f")}::${venue}::Venue`,venue,QUOTE,slot]);
    };
    await insert(hex("ca1"), native, "cetus", "NATIVE");
    await insert(hex("ca2"), native, "cetus", "NATIVE", { slot: 1 });
    // A lower vault ID in the same checkpoint is not necessarily the first
    // pool registered in chain order. It must not relabel the indexed market.
    await insert(hex("ca0"), native, "bluefin", "NATIVE", { slot: 2 });
    await insert(hex("b11"), blue, "bluefin", "BLUE");
    // A manually created vault for an existing presale coin must not duplicate it.
    await insert(hex("af11"), coinOf(P.after, "AFTR"), "bluefin", "AFTR");
    await insert(hex("b12"), coinOf(hex("bad"), "MISSING"), "bluefin", "MISSING", { decimals: null });
    await insert(hex("b13"), coinOf(hex("bad2"), "PRESALE"), "bluefin", "PRESALE", { origin: "presale" });
    // NATIVE came from a Blast bonding curve: its launch (the curve pool), live supply, holders and balances.
    const launch = hex("1a7c");
    await admin.query(`INSERT INTO coins (coin_type,decimals,launcher,creator,metadata,pool_key,created_checkpoint,created_at_ms,currency_supply,balance_0x0)
      VALUES ($1,9,$2,$2,'{}',$3,39000,$4,13000000000000,3000000000000)`, [native, W.anon, `blast_curve:${launch}`, now - 3 * DAY]);
    await admin.query(`INSERT INTO pools (pool_key,venue,coin_type,quote_type,lifecycle,created_checkpoint,created_at_ms)
      VALUES ($1,'blast_curve',$2,$3,'migrated',39000,$4)`, [`blast_curve:${launch}`, native, QUOTE, now - 3 * DAY]);
    const setTarget = (target: string) => admin.query("UPDATE pools SET params=jsonb_build_object('graduation_target',$2::text) WHERE pool_key=$1", [`blast_curve:${launch}`, target]);
    await seedChainRead(admin, {
      prices: [{ coin_type: native, usd_price: "0.1", as_of_ms: now, source: "pool" }],
      activity: [activity("trade_buy", W.anon, null, now - MINUTE, { checkpoint: 49999, coin_type: native, coin_amount: "1000000000", quote_amount: "20000", usd_value: "0.02" })],
      coin_balances: [
        { coin_type: native, owner: W.anon, balance: "2500000000000", updated_checkpoint: 45_000 },
        { coin_type: native, owner: W.jules, balance: "500000000000", updated_checkpoint: 45_000 },
        // 0x0's burned balance: the view lists it, the live supply already left it out, so it is never a holder.
        { coin_type: native, owner: hex("0"), balance: "3000000000000", updated_checkpoint: 45_000 },
      ],
      coin_holder_history: [{ coin_type: native, checkpoint: 45_000, timestamp_ms: now - HOUR, holders: 7 }],
    });
    // NATIVE's curve had to raise 999 USDC ($999) to graduate: dust, off Home and out of the count.
    await setTarget("999000000");
    const withoutNative = await ok<HomeCoinsPage>(await discover("?limit=50"), "home-coins-page");
    assert.equal(withoutNative.coins.some((coin) => coin.coin_type === native), false);
    await setTarget("8000000000");
    const page = await ok<HomeCoinsPage>(await discover("?limit=50"), "home-coins-page");
    assert.equal(page.total, withoutNative.total + 1);
    const standalone = page.coins.filter((coin) => coin.presale_id === null && !TRACKED_SYMBOLS.includes(coin.symbol));
    assert.deepEqual(standalone.map((coin) => coin.symbol).sort(), ["BLUE", "NATIVE"]);
    const coin = standalone.find((coin) => coin.coin_type === native)!;
    assert.equal(coin.sale, null);
    assert.equal(coin.venue, "cetus");
    assert.equal(coin.lifecycle, "migrated");
    assert.equal(coin.tradable, true);
    assert.equal(coin.price_usd, "0.1");
    // A curve coin has no sale terms: its FDV is the price times its total supply ($0.10 × 13,000 whole coins), above the dust line.
    assert.equal(coin.fdv_usd, "1300.00");
    // The curve coin's card: its launch page, age, holders and top 10 against live supply.
    assert.deepEqual([coin.launch_id, coin.launched_ms, coin.holders], [launch, now - 3 * DAY, 7]);
    assert.deepEqual(coin.top_holders.holders.map((holder) => [holder.actor.type === "account" ? holder.actor.callsign : "wallet", holder.share_bps]), [["wallet", 2500], ["jules", 500]]);
    assert.equal(coin.top_holders.share_bps, 3000);
    assert.equal(standalone.find((coin) => coin.coin_type === blue)!.launch_id, null);
    assert.deepEqual([coin.activity.events,coin.activity.buyers], [1,1]);
    assert.equal(coin.rank.why, "1 participant · 1 trade in the last 24h in its pool");
    assert.equal(page.coins.filter((coin) => coin.symbol === "AFTR").length, 1);
    // Bonding curves still filling have no vault yet; Almost graduated lists them from their curve pool.
    const curveCoin = async (id: string, symbol: string, reserve: string, target: string | null, lifecycle = "live") => {
      const coinType = coinOf(hex(id), symbol);
      await admin.query("INSERT INTO blast_infra_fixture.coin_metadata (coin_type,name,symbol,decimals) VALUES ($1,$2,$2,9)", [coinType, symbol]);
      await admin.query(`INSERT INTO pools (pool_key,venue,coin_type,quote_type,lifecycle,created_checkpoint,created_at_ms,quote_reserve,params)
        VALUES ($1,'blast_curve',$2,$3,$7,41000,$4,$5,$6)`, [`blast_curve:${hex(`${id}0`)}`, coinType, QUOTE, now - DAY, reserve, target === null ? null : { graduation_target: target }, lifecycle]);
      return coinType;
    };
    // 5,600 of 8,000 USDC: 70%. 900 of 999 USDC is further along, but its target is dust. One target is unknown.
    const seventy = await curveCoin("c70", "SEVENTY", "5600000000", "8000000000");
    // Ready to migrate counts whatever its reserve reads.
    await curveCoin("c99", "READY", "100000000", "8000000000", "migration_ready");
    // Almost graduated reads its curves' own trades.
    await seedChainRead(admin, {
      activity: [activity("trade_buy", W.anon, null, now - 2 * MINUTE, { checkpoint: 49998, coin_type: seventy, coin_amount: "1000000000", quote_amount: "5000000", usd_value: "5" })],
      coin_balances: [
        { coin_type: seventy, owner: W.jules, balance: "4000000000", updated_checkpoint: 45_000 },
        // The curve holds the unsold coins: never a holder.
        { coin_type: seventy, owner: hex("c700"), balance: "900000000000", updated_checkpoint: 45_000 },
      ],
    });
    // A curve still filling has its holders list too.
    await admin.query("INSERT INTO coins (coin_type,decimals,launcher,creator,metadata,pool_key,created_checkpoint,created_at_ms,currency_supply,balance_0x0) VALUES ($1,9,$2,$2,'{}',$3,41000,$4,1000000000000,0)", [seventy, W.anon, `blast_curve:${hex("c700")}`, now - DAY]);
    const seventyHolders = await ok<HomeHoldersPage>(await holders(`?coin=${encodeURIComponent(seventy)}&limit=10`), "home-holders-page", "public, s-maxage=10");
    assert.deepEqual(seventyHolders.holders.map((holder) => [holder.balance, holder.share_bps]), [["4000000000", 40]]);
    // A presale's token keeps its presale: a curve on it never makes it an Almost graduated curve.
    const presaleToken = page.coins.find((coin) => coin.presale_id !== null)!.coin_type;
    await admin.query("INSERT INTO blast_infra_fixture.coin_metadata (coin_type,name,symbol,decimals) VALUES ($1,'SALE','SALE',9) ON CONFLICT DO NOTHING", [presaleToken]);
    await admin.query(`INSERT INTO pools (pool_key,venue,coin_type,quote_type,lifecycle,created_checkpoint,created_at_ms,quote_reserve,params)
      VALUES ($1,'blast_curve',$2,$3,'live',41000,$4,'7000000000',$5)`, [`blast_curve:${hex("c5a0")}`, presaleToken, QUOTE, now - DAY, { graduation_target: "8000000000" }]);
    await curveCoin("c90", "DUSTY", "900000000", "999000000");
    await curveCoin("c0", "NOTARGET", "1", null);
    // NATIVE's Cetus pool opened two days ago: when it graduated.
    await admin.query(`INSERT INTO pools (pool_key,venue,coin_type,quote_type,lifecycle,created_checkpoint,created_at_ms)
      VALUES ($1,'cetus',$2,$3,'live',40000,$4)`, [`cetus:${hex("ca1")}`, native, QUOTE, now - 2 * DAY]);
    const almost = await ok<HomeCoinsPage>(await discover("?stage=almost&sort=progress&curve=1&limit=50"), "home-coins-page");
    assert.deepEqual(almost.coins.map((coin) => coin.symbol), ["READY", "SEVENTY"], "no presale token, dust target or unknown target");
    const seventyCoin = almost.coins[1];
    assert.deepEqual([seventyCoin?.curve, seventyCoin?.tradable, seventyCoin?.graduated_ms, seventyCoin?.activity.events], [{ lifecycle: "live", progress_bps: 7_000, quote_remaining: "2400000000" }, false, null, 1]);
    assert.equal(almost.coins[0]?.curve?.lifecycle, "migration_ready");
    // Every other stage leaves curves still filling out: about a thousand of them made the default read time out (#71).
    const all = await ok<HomeCoinsPage>(await discover("?sort=progress&limit=50"), "home-coins-page");
    assert.equal(all.coins.some((coin) => ["SEVENTY", "READY", "NOTARGET"].includes(coin.symbol)), false, "no curve still filling outside Almost graduated");
    assert.ok(all.coins.every((coin) => !("curve" in coin)), "the curve fields are opt-in");
    const graduated = await ok<HomeCoinsPage>(await discover("?stage=graduated&sort=market_cap&curve=1&limit=50"), "home-coins-page");
    assert.ok(graduated.coins.every((coin) => coin.lifecycle === "migrated" && coin.curve?.lifecycle !== "live"), "no sale and no curve still filling");
    assert.deepEqual(graduated.coins.find((coin) => coin.coin_type === native)?.curve, { lifecycle: "migrated", progress_bps: 10_000, quote_remaining: "0" });
    assert.equal(graduated.coins.find((coin) => coin.coin_type === native)?.graduated_ms, now - 2 * DAY);
    assert.equal(graduated.coins.find((coin) => coin.symbol === "BLUE")?.curve, null, "a coin that never had a curve");
    // Dust stays hidden on every stage and every order.
    for (const stage of ["all", "almost", "graduated"]) for (const sort of ["relevant", "progress", "market_cap", "last_trade"]) {
      const listed = await ok<HomeCoinsPage>(await discover(`?stage=${stage}&sort=${sort}&limit=50`), "home-coins-page");
      assert.equal(listed.coins.some((coin) => coin.symbol === "DUSTY"), false, `${stage} ${sort}`);
    }
    const sales = await ok<HomeCoinsByIds>(await coins(`?presale=${P.halo}&presale=${P.after}`), "home-coins-page");
    assert.deepEqual(symbols(sales.coins), ["HALO", "AFTR"]);
    assert.ok(sales.coins.every((coin) => coin.presale_id !== null && coin.sale !== null));
    // A saved curve coin is asked for by its coin type, beside sales; an unknown type is missing.
    const unknownType = coinOf(hex("dead"), "GONE");
    const saved = await ok<HomeCoinsByIds>(await coins(`?presale=${encodeURIComponent(native)}&presale=${P.halo}&presale=${encodeURIComponent(unknownType)}`), "home-coins-page");
    assert.deepEqual([symbols(saved.coins), saved.missing], [["NATIVE", "HALO"], [unknownType]]);
    assert.equal(saved.pool_volumes?.[native]?.[0]?.atoms, "20000");
    // Its thread, asked by coin type.
    const curve = await ok<HomeThreadPage>(await thread(`?coin=${encodeURIComponent(native)}`), "home-thread-page");
    assert.deepEqual([curve.presale_id, curve.coin_type, keysOf(curve.participants), curve.totals.events], [null, native, [`w:${W.anon}`], 1]);
    for (const bad of ["?coin=abc", `?coin=${encodeURIComponent(native)}&presale=${P.orbit}`]) assert.equal((await thread(bad)).status, 400, bad);
    // Its coin page separates total supply for FDV from the live supply for holder shares.
    const nativeMarket = await ok<HomeCoinMarket>(await market(`?coin=${encodeURIComponent(native)}`), "home-coin-market");
    assert.deepEqual([nativeMarket.supply, nativeMarket.fdv_usd, nativeMarket.market_cap_usd], [{ total: "13000000000000", escrowed: "0", circulating: "10000000000000" }, "1300.00", "1000.00"]);
    const nativeHolders = await ok<HomeHoldersPage>(await holders(`?coin=${encodeURIComponent(native)}&limit=10`), "home-holders-page", "public, s-maxage=10");
    assert.deepEqual(nativeHolders.holders.map((holder) => holder.share_bps), [2500, 500]);
    // Only a coin Home does not know is missing, and a hidden sale's coin stays unknown.
    for (const coinType of [unknownType, coinOf(P.incomplete, "INC")]) assert.equal((await holders(`?coin=${encodeURIComponent(coinType)}&limit=10`)).status, 404, coinType);
  }));

test("Trending with presales: upcoming, live and ended sales in their bounds, savers counted from verified accounts only", { skip }, () =>
  withFixture(async ({ admin, discover, now, replica }) => {
    const S = { soon: hex("5007"), pend: hex("9e7d"), unsaved: hex("9e7e"), far: hex("fa7"), ended: hex("e7d"), old: hex("01d"), cancelled: hex("ca7c"), testSui: hex("7e51"), dust: hex("d057") } as const;
    const ENDED = { id: S.ended, symbol: "ENDED" };
    await seedChainRead(admin, {
      presales: [
        presale(S.soon, "SOON", "open", { start_ms: now + 3 * HOUR, end_ms: now + 2 * DAY }),
        presale(S.pend, "PEND", "pending", {}),
        presale(S.unsaved, "NOSAVE", "pending", {}),
        presale(S.far, "FAR", "open", { start_ms: now + 40 * DAY, end_ms: now + 41 * DAY }),
        presale(S.ended, "ENDED", "funded", { start_ms: now - 3 * DAY, end_ms: now - 2 * HOUR, participants: 1 }),
        presale(S.old, "OLD", "funded", { start_ms: now - 9 * DAY, end_ms: now - 3 * DAY }),
        presale(S.cancelled, "CNCL", "cancelled", { start_ms: now + HOUR, end_ms: now + DAY }),
        presale(S.testSui, "TSUI", "open", { start_ms: now + HOUR, end_ms: now + DAY, quote_type: CREATE_TEST_SUI_QUOTE_TYPE, quote_symbol: "TEST_SUI", quote_decimals: 9 }),
        // A $500 target: dust before it raises anything.
        presale(S.dust, "DUST", "open", { start_ms: now + 2 * HOUR, end_ms: now + DAY, raise_target: "500000000" }),
      ],
      activity: [commit(W.ben, ENDED, 50, now - 3 * HOUR)],
    });
    await admin.query(advanceWatermark(checkpoint, 0, "presale"));
    // One account with no X link: its saves never count.
    await admin.query(
      `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, privacy, sharing_since, onboarded_at)
       VALUES ($1, $2, 'nox', 'Name nox', 'public', NULL, now())`,
      [uuid(0x200), did("nox")],
    );
    await admin.query(
      `INSERT INTO social_watchlist (account_id, presale_id, created_at) VALUES
       ($1, $5, now() - interval '3 days'), ($2, $5, now() - interval '2 hours'), ($3, $5, now() - interval '10 minutes'), ($4, $5, now()),
       ($1, $6, now()), ($1, $7, now()), ($1, $8, now()), ($1, $9, now()), ($1, $10, now())`,
      [A.maya, A.leo, A.jules, uuid(0x200), S.soon, S.pend, S.far, S.cancelled, S.testSui, S.dust],
    );
    // A coin saved by its type (0163) is not a presale: the view skips it.
    await admin.query("INSERT INTO social_watchlist (account_id, presale_id) VALUES ($1, $2)", [A.leo, coinOf(P.orbit, "ORBIT")]);

    // The replica reads counts only, never the rows behind them.
    const savers = await replica.read<Record<string, unknown>>("SELECT * FROM social_presale_savers ORDER BY presale_id");
    assert.deepEqual(savers.rows.find((row) => row.presale_id === S.soon), { presale_id: S.soon, savers: 3, gained_1h: 1, gained_24h: 2 });
    assert.equal(savers.rows.some((row) => !/^0x[0-9a-f]{64}$/.test(String(row.presale_id))), false);

    const trending = await ok<HomeCoinsPage>(await discover("?sort=relevant&presales=1&limit=50"), "home-coins-page");
    const shown = symbols(trending.coins);
    for (const symbol of ["SOON", "PEND", "ENDED", "HALO"]) assert.ok(shown.includes(symbol), `${symbol} is on Trending`);
    for (const symbol of ["NOSAVE", "FAR", "OLD", "CNCL", "TSUI", "DUST"]) assert.ok(!shown.includes(symbol), `${symbol} is not`);
    const soon = trending.coins.find((coin) => coin.symbol === "SOON")!;
    assert.deepEqual([soon.sale?.savers, soon.rank.why, soon.tradable], [3, "3 saved · opens in 3h", false]);
    assert.equal(trending.coins.find((coin) => coin.symbol === "PEND")?.rank.why, "1 saved · not scheduled");
    // Commits attribute by presale id, claims never; a sale's own people only.
    const ended = trending.coins.find((coin) => coin.symbol === "ENDED")!;
    assert.deepEqual([ended.activity.participants, ended.activity.backers], [1, 1]);
    // Maya's two wallets are one backer.
    assert.equal(trending.coins.find((coin) => coin.symbol === "HALO")?.activity.backers, 2);

    // Keyset pages over the mixed list: the same items, none twice.
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page: HomeCoinsPage = await ok<HomeCoinsPage>(await discover(`?sort=relevant&presales=1&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`), "home-coins-page");
      paged.push(...symbols(page.coins));
      cursor = page.next_cursor;
    } while (cursor);
    assert.deepEqual(paged, shown);

    // Without the flag, or on any other order, no presale that is not trading yet.
    const notTrading = ["SOON", "PEND", "ENDED", "HALO"];
    for (const query of ["?sort=relevant&limit=50", "?sort=held&presales=1&limit=50", "?sort=trending&presales=1&limit=50", "?sort=newest&presales=1&limit=50"]) {
      const page = await ok<HomeCoinsPage>(await discover(query), "home-coins-page");
      assert.deepEqual(symbols(page.coins).filter((symbol) => notTrading.includes(symbol)), [], query);
    }
    // Filters still apply: a sale not trading yet is never tradable.
    const tradable = await ok<HomeCoinsPage>(await discover("?sort=relevant&presales=1&tradable=1&limit=50"), "home-coins-page");
    assert.deepEqual(symbols(tradable.coins).filter((symbol) => notTrading.includes(symbol)), []);
  }));

test("Trending with presales: live curves traded in the window rank beside every coin; idle, dust and other orders stay off", { skip }, () =>
  withFixture(async ({ admin, discover, now }) => {
    await admin.query("INSERT INTO blast_infra_fixture.coin_metadata (coin_type,name,symbol,decimals) VALUES ($1,'USD Coin','USDC',6)", [QUOTE]);
    // Live USDC curves, 2,000 of 8,000 USDC (25%), a billion whole coins each.
    const curve = async (id: string, symbol: string, usdPrice: string, tradedAgoMs: number, cp: number, kind = "trade_buy") => {
      const coinType = coinOf(hex(id), symbol);
      const poolKey = `blast_curve:${hex(`${id}0`)}`;
      await admin.query("INSERT INTO blast_infra_fixture.coin_metadata (coin_type,name,symbol,decimals) VALUES ($1,$2,$2,9)", [coinType, symbol]);
      await admin.query(`INSERT INTO coins (coin_type,decimals,launcher,creator,metadata,pool_key,created_checkpoint,created_at_ms,currency_supply,balance_0x0)
        VALUES ($1,9,$2,$2,'{}',$3,41000,$4,1000000000000000000,0)`, [coinType, W.anon, poolKey, now - 2 * DAY]);
      await admin.query(`INSERT INTO pools (pool_key,venue,coin_type,quote_type,lifecycle,created_checkpoint,created_at_ms,quote_reserve,params)
        VALUES ($1,'blast_curve',$2,$3,'live',41000,$4,'2000000000',$5)`, [poolKey, coinType, QUOTE, now - 2 * DAY, { graduation_target: "8000000000" }]);
      await seedChainRead(admin, {
        prices: [{ coin_type: coinType, usd_price: usdPrice, as_of_ms: now - MINUTE, source: "pool" }],
        // Under the market watermark, as a committed curve trade, unless the caller passes a later checkpoint.
        activity: [activity(kind, W.anon, null, now - tradedAgoMs, { checkpoint: cp, coin_type: coinType, coin_amount: "1000000000", quote_amount: "50000000", usd_value: "50", venue: "blast_curve" })],
      });
      return coinType;
    };
    // $5,000 market caps: HOT traded 10 minutes ago, WARM 3 hours ago, COLD 2 days ago. TINY traded, but its market cap is $500: dust.
    const hot = await curve("c401", "HOT", "0.000005", 10 * MINUTE, 49_990);
    await curve("c402", "WARM", "0.000005", 3 * HOUR, 49_991);
    await curve("c403", "COLD", "0.000005", 2 * DAY, 49_992);
    await curve("c404", "TINY", "0.0000005", 5 * MINUTE, 49_993);
    // SOLD only had a sell, which counts. LATE's buy sits above the market watermark, not yet committed.
    await curve("c405", "SOLD", "0.000005", 2 * HOUR, 49_994, "trade_sell");
    await curve("c406", "LATE", "0.000005", 5 * MINUTE, checkpoint + 1_000);
    const curves = ["HOT", "WARM", "COLD", "TINY", "SOLD", "LATE"];
    const shownCurves = (page: HomeCoinsPage) => symbols(page.coins).filter((symbol) => curves.includes(symbol));

    const day = await ok<HomeCoinsPage>(await discover("?sort=relevant&presales=1&curve=1&limit=50"), "home-coins-page");
    assert.deepEqual(shownCurves(day).sort(), ["HOT", "SOLD", "WARM"], "traded in the last 24h, under the watermark, and not dust");
    const hotCoin = day.coins.find((coin) => coin.coin_type === hot)!;
    assert.deepEqual([hotCoin.curve, hotCoin.lifecycle, hotCoin.venue], [{ lifecycle: "live", progress_bps: 2_500, quote_remaining: "6000000000" }, "migrated", "blast_curve"]);
    assert.deepEqual([hotCoin.activity.participants, hotCoin.rank.why], [1, "1 participant · 1 trade in the last 24h in its pool"]);
    // The same score as every coin: active coins in score order, HOT ahead of WARM on freshness alone.
    const active = day.coins.filter((coin) => coin.activity.participants > 0).map((coin) => coin.rank.score);
    assert.deepEqual(active, [...active].sort((a, b) => b - a));
    assert.ok(symbols(day.coins).indexOf("HOT") < symbols(day.coins).indexOf("WARM"));

    const hour = await ok<HomeCoinsPage>(await discover("?window=1h&sort=relevant&presales=1&limit=50"), "home-coins-page");
    assert.deepEqual(shownCurves(hour), ["HOT"], "only the curve traded in the last hour");

    // Keyset pages over the mixed list: the same items, none twice.
    const paged: string[] = [];
    let cursor: string | null = null;
    do {
      const page: HomeCoinsPage = await ok<HomeCoinsPage>(await discover(`?sort=relevant&presales=1&curve=1&limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`), "home-coins-page");
      paged.push(...symbols(page.coins));
      cursor = page.next_cursor;
    } while (cursor);
    assert.deepEqual(paged, symbols(day.coins));

    // Only Home's Trending: not without the flag, not on another order or the Graduated tab, not while trades are hidden.
    for (const query of ["?sort=relevant&limit=50", "?sort=trending&presales=1&limit=50", "?sort=newest&presales=1&limit=50", "?sort=held&presales=1&limit=50", "?stage=graduated&sort=relevant&presales=1&limit=50"]) {
      assert.deepEqual(shownCurves(await ok<HomeCoinsPage>(await discover(query), "home-coins-page")), [], query);
    }
    assert.deepEqual(shownCurves(await ok<HomeCoinsPage>(await discover("?sort=relevant&presales=1&limit=50", { trades: false }), "home-coins-page")), [], "trades hidden");
  }));
