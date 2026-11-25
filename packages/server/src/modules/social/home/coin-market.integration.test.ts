import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";

import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { seedChainRead, type ChainActivityRow, type ChainPresaleRow } from "../../../../../core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { advanceWatermark, urlAs } from "../../../../../core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../core/test/fixtures/modules/database/template.ts";
import { autocommitReader } from "@blast/core/modules/database/transaction.ts";
import type { PresaleTerms, PresaleTermsReader } from "@blast/core/modules/presale/terms/index.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { createSocialConfigReader } from "@blast/core/modules/social/config/reader.ts";
import type { HomeChartTradesPage, HomeCoinMarket, HomeHoldersPage } from "@blast/core/modules/social/contracts/coin-market.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { createSocialHomeRoutes } from "@blast/server/modules/social/home/route.ts";
import { takeProcessSingleton } from "@blast/core/lib/process-singleton.ts";
import { installRuntimeConfig } from "../../../../test/fixtures/config/runtime-config.ts";
import { readHomeTerms } from "./runtime.ts";
import { hex, uuid } from "../../../../../core/test/kit.ts";

/**
 * Redesign data gaps 1, 2, 3, 7, 8 and 10 over a disposable database with
 * the fixture `chain_read_v1`. One migrated sale, ORBIT, trades over the last
 * day: maya (two wallets, sharing her portfolio) claimed and trades, leo
 * (named, keeping his portfolio private) buys, an anonymous wallet buys big,
 * one trade sits past the watermark and one in the future. Its price history
 * gives each window an opening price except 5m's search hour, and two
 * vesting schedules hold part of its supply. The public routes read as
 * `blast_replica`, the viewer's as `blast_web` through the kit, as in
 * production; every answer is checked against its published schema.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-coin-market-app";
const PEPPER = "social-coin-market-fixture-pepper-0123456789";
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 8, statementTimeoutMs: 10_000 };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const QUOTE = `${hex("dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7")}::usdc::USDC`;
const ORBIT_ID = hex("0b17");
const ORBIT = `${ORBIT_ID}::coin::ORBIT`;
const POOL_ID = hex("9001");
const W = { mayaA: hex("aa01"), mayaB: hex("aa02"), leo: hex("aa03"), anon: hex("bb01") } as const;
const A = { maya: uuid(1), leo: uuid(2) } as const;
const did = (callsign: string) => `did:privy:market-${callsign}`;

function bearer(subject: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: subject });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}

const presale: ChainPresaleRow = {
  presale_id: ORBIT_ID, sale_token: ORBIT, quote_type: QUOTE, sale_symbol: "ORBIT", sale_name: "Orbit",
  sale_icon_url: "https://cdn.blast.fun/ORBIT.png", sale_decimals: 9, quote_symbol: "USDC", quote_decimals: 6, lifecycle: "migrated",
  start_ms: 0, end_ms: 0, raise_target: "100000000000", min_commitment: "10000000", wallet_cap: null, total_commitments: "100000000000",
  participants: 0, venue: "cetus", pool_id: POOL_ID, updated_checkpoint: 1,
};

let checkpoint = 60_000;
function row(kind: string, actor: string, at: number, extra: Partial<ChainActivityRow> = {}): ChainActivityRow {
  checkpoint += 1;
  const trade = kind.startsWith("trade");
  return {
    checkpoint, tx_slot: 0, event_slot: trade ? 1 : 0, part: 0, timestamp_ms: at, digest: `Mk${checkpoint}`.padEnd(44, "5"), kind,
    product: trade ? "market" : "presale", actor, tx_sender: actor, presale_id: ORBIT_ID, coin_type: ORBIT,
    quote_type: QUOTE, quote_amount: "0", coin_amount: null, quote_refund: null, usd_value: null, usd_price_as_of_ms: null,
    venue: trade ? "cetus" : null, participants_after: null, total_commitments_after: null, ...extra,
  };
}
/** A trade of `dollars` USDC for 25 tokens a dollar (null `usd` leaves it unpriced). */
const trade = (side: "buy" | "sell", actor: string, dollars: number, at: number, usd: string | null = dollars.toFixed(2)) =>
  row(`trade_${side}`, actor, at, { quote_amount: String(dollars * 1_000_000), coin_amount: String(dollars * 25 * 1_000_000_000), usd_value: usd });

const terms: PresaleTermsReader = async (presaleId) => (presaleId === ORBIT_ID ? { presaleId, supply: { total: "1000000000000000000" }, burnable: false } as unknown as PresaleTerms : null);

type Fixture = Readonly<{
  now: number;
  admin: ReturnType<typeof createPool>;
  activity: readonly ChainActivityRow[];
  market(query: string, trades?: boolean): Promise<Response>;
  holders(query: string, trades?: boolean): Promise<Response>;
  trades(query: string): Promise<Response>;
  mine(callsign: string | null, query: string): Promise<Response>;
}>;

async function withFixture(run: (fixture: Fixture) => Promise<void>, termsSource: PresaleTermsReader = terms): Promise<void> {
  const database = await freshTestDatabase();
  const admin = createPool(database.url, { max: 4 });
  const now = Date.now();
  checkpoint = 60_000;
  const rows: ChainActivityRow[] = [
    // Maya's own history: a commit and its claim (1,000 tokens for $40), then trades on both wallets.
    row("presale_commit", W.mayaA, now - 3 * DAY, { quote_amount: "40000000", usd_value: "40.00" }),
    row("presale_claim", W.mayaA, now - 2 * DAY, { coin_amount: "1000000000000", quote_refund: "0" }),
    trade("buy", W.mayaA, 20, now - 20 * HOUR),
    trade("sell", W.mayaB, 10, now - 3 * HOUR),
    trade("buy", W.mayaB, 4, now - 2 * MINUTE),
    // Leo: named, private portfolio; two buys inside the hour, one unpriced.
    trade("buy", W.leo, 8, now - 50 * MINUTE),
    trade("buy", W.leo, 2, now - 40 * MINUTE, null),
    // An anonymous whale: one big buy and one big sell, the sell older than a day.
    trade("buy", W.anon, 1_500, now - 90 * MINUTE),
    trade("sell", W.anon, 2_000, now - 25 * HOUR),
  ];
  const marketCheckpoint = checkpoint;
  // Past the watermark (not committed yet) and in the future: never counted.
  rows.push(trade("buy", W.anon, 7_777, now - MINUTE), trade("buy", W.anon, 9_999, now + 5 * MINUTE));
  const bucket = (ms: number) => Math.floor(ms / 300_000) * 300_000;
  await seedChainRead(admin, {
    presales: [presale],
    presale_lifecycle: [{ presale_id: ORBIT_ID, state: "migrated", digest: "Mg1".padEnd(44, "4"), timestamp_ms: now - 2 * DAY, checkpoint: 40_002 }],
    prices: [
      { coin_type: QUOTE, usd_price: "1", as_of_ms: now, source: "pyth" },
      { coin_type: ORBIT, usd_price: "0.05", as_of_ms: now - 10_000, source: "pool" },
    ],
    // The opening prices: 24h 0.04, 4h 0.045, 1h 0.0525; none in the hour before the 5m window opens.
    price_history: [
      { coin_type: ORBIT, resolution: "5m", bucket_ms: bucket(now - DAY - 10 * MINUTE), usd_price: "0.04", as_of_ms: bucket(now - DAY - 10 * MINUTE) + MINUTE, source: "pool" },
      { coin_type: ORBIT, resolution: "5m", bucket_ms: bucket(now - 4 * HOUR - 10 * MINUTE), usd_price: "0.045", as_of_ms: bucket(now - 4 * HOUR - 10 * MINUTE) + MINUTE, source: "pool" },
      { coin_type: ORBIT, resolution: "5m", bucket_ms: bucket(now - 90 * MINUTE), usd_price: "0.0525", as_of_ms: bucket(now - 90 * MINUTE) + MINUTE, source: "pool" },
    ],
    coin_balances: [
      { coin_type: ORBIT, owner: W.mayaA, balance: "1000000000000", updated_checkpoint: 50_000 },
      { coin_type: ORBIT, owner: W.mayaB, balance: "350000000000", updated_checkpoint: 50_000 },
      { coin_type: ORBIT, owner: W.leo, balance: "250000000000", updated_checkpoint: 50_000 },
      { coin_type: ORBIT, owner: W.anon, balance: "37500000000000", updated_checkpoint: 50_000 },
      { coin_type: ORBIT, owner: POOL_ID, balance: "900000000000000", updated_checkpoint: 50_000 },
    ],
    vesting_schedules: [
      { schedule_id: hex("7e1"), presale_id: ORBIT_ID, beneficiary: hex("7ea1"), total: "100000000000000000", claimed: "25000000000000000", start_ms: now - 30 * DAY, cliff_ms: "0", end_ms: String(now + 300 * DAY) },
      { schedule_id: hex("7e2"), presale_id: ORBIT_ID, beneficiary: hex("7ea2"), total: "999", claimed: "0", start_ms: now - 30 * DAY, cliff_ms: "0", end_ms: String(now + DAY), asset: "quote" },
    ],
    // The pool: 900,000 ORBIT and 45,000 USDC, set by a swap that committed after the read's bounds
    // (the replica moved on between its statements): the row is the pool's latest, still served.
    pool_reserves: [{
      coin_type: ORBIT, quote_type: QUOTE, presale_id: ORBIT_ID, pool_id: POOL_ID, venue: "cetus",
      coin_reserve: "900000000000000", quote_reserve: "45000000000", checkpoint: marketCheckpoint + 1, timestamp_ms: now - 2 * MINUTE,
    }],
    activity: rows,
  });
  await admin.query(advanceWatermark(marketCheckpoint, 0, "market"));
  await admin.query(advanceWatermark(marketCheckpoint, 0, "presale"));
  const since = new Date(now - 400 * DAY).toISOString();
  for (const [callsign, id, wallets] of [["maya", A.maya, [W.mayaA, W.mayaB]], ["leo", A.leo, [W.leo]]] as const) {
    await admin.query(
      `INSERT INTO social_accounts (account_id, privy_did, callsign, display_name, x_subject, x_handle, privacy, sharing_since, onboarded_at)
       VALUES ($1, $2, $3, $4, $5, $3, 'public', $6, $6)`,
      [id, did(callsign), callsign, `Name ${callsign}`, `x-${callsign}`, since],
    );
    for (const wallet of wallets) await admin.query("INSERT INTO social_account_wallets (address, account_id, verified_at) VALUES ($1, $2, $3)", [wallet, id, since]);
  }
  await admin.query("UPDATE social_accounts SET portfolio_public = true WHERE account_id = $1", [A.maya]);

  const replicaPool = createRuntimePool(urlAs(database.url, "blast_replica"), POOL, "social-market-replica");
  const webPool = createRuntimePool(urlAs(database.url, "blast_web"), POOL, "social-market-web");
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
    const common = { database: () => replica, ledgerDatabase: () => autocommitReader(webPool, "social"), wallets: accounts, config: reader.getSocialConfig, now: () => now, terms: termsSource };
    const all = createSocialHomeRoutes({ ...common, kit: kitWith(true) });
    const hidden = createSocialHomeRoutes({ ...common, kit: kitWith(false) });
    const get = (path: string, headers: Record<string, string> = {}) => new Request(`${ORIGIN}${path}`, { headers: { "x-forwarded-for": "203.0.113.9", ...headers } });
    await run({
      now,
      admin,
      activity: rows,
      market: (query, trades = true) => (trades ? all : hidden).MARKET(get(`/api/social/home/market${query}`), testClient()),
      holders: (query, trades = true) => (trades ? all : hidden).HOLDERS(get(`/api/social/home/holders${query}`), testClient()),
      trades: (query) => all.TRADES(get(`/api/social/home/trades${query}`), testClient()),
      mine: (callsign, query) => all.MY_TRADES(get(`/api/social/me/home/trades${query}`, { origin: ORIGIN, ...(callsign ? { authorization: bearer(did(callsign)) } : {}) }), testClient()),
    });
  } finally {
    await Promise.all([admin.end(), replicaPool.end(), webPool.end()]);
    await database.drop();
  }
}

async function ok<T>(response: Response, schema: Parameters<typeof validator.validate>[0], cache = "public, s-maxage=10, stale-while-revalidate=20"): Promise<T> {
  const body: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.deepEqual(validator.validate(schema, body).errors, []);
  assert.equal(response.headers.get("cache-control"), cache);
  return body as T;
}

const coin = `?coin=${encodeURIComponent(ORBIT)}`;

test("gaps 1, 2, 8, 10: each window's opening price and move, per-side pressure, FDV, market cap and liquidity", { skip }, () =>
  withFixture(async ({ market, now }) => {
    const answer = await ok<HomeCoinMarket>(await market(coin), "home-coin-market");
    assert.deepEqual([answer.price_usd, answer.presale_id, answer.quote.symbol], ["0.05", ORBIT_ID, "USDC"]);
    const day = answer.windows["24h"];
    assert.deepEqual([day.open_usd, day.change_bps, day.change_usd], ["0.04", 2500, "0.01"]);
    assert.deepEqual([answer.windows["4h"].open_usd, answer.windows["4h"].change_bps, answer.windows["4h"].change_usd], ["0.045", 1111, "0.005"]);
    assert.deepEqual([answer.windows["1h"].change_bps, answer.windows["1h"].change_usd], [-476, "-0.0025"]);
    assert.deepEqual([answer.windows["5m"].open_usd, answer.windows["5m"].change_bps, answer.windows["5m"].change_usd], [null, null, null], "no price in the search hour: no move");
    // 24h: buys maya 20 + 4, leo 8 + 2 (unpriced), anon 1,500; sells maya 10. Past the watermark, the future and >24h are out.
    assert.deepEqual(
      [day.buys, day.sells, day.bought_atoms, day.sold_atoms, day.bought_usd, day.sold_usd, day.unpriced_buys, day.unpriced_sells, day.buyers, day.sellers],
      [5, 1, "1534000000", "10000000", "1532.00", "10.00", 1, 0, 4, 1],
    );
    const hour = answer.windows["1h"];
    assert.deepEqual([hour.buys, hour.sells, hour.buyers, hour.sellers, hour.bought_usd, hour.unpriced_buys], [3, 0, 2, 0, "12.00", 1]);
    assert.deepEqual([answer.windows["5m"].buys, answer.windows["5m"].sellers, answer.windows["5m"].sold_usd], [1, 0, null]);
    // 1e9 tokens, 7.5e7 of them still vesting (the quote schedule does not count): cap 0.05 × 9.25e8.
    assert.deepEqual(answer.supply, { total: "1000000000000000000", escrowed: "75000000000000000", circulating: "925000000000000000" });
    assert.deepEqual([answer.fdv_usd, answer.market_cap_usd], ["50000000.00", "46250000.00"]);
    // Liquidity: 900,000 ORBIT at $0.05 and 45,000 USDC at $1.
    assert.deepEqual(answer.pool, { id: POOL_ID, venue: "cetus", coin_atoms: "900000000000000", quote_atoms: "45000000000", as_of_ms: now - 2 * MINUTE });
    assert.equal(answer.liquidity_usd, "90000.00");
    // Trading hidden: no trade counts, the price and supply stay.
    const quiet = await ok<HomeCoinMarket>(await market(coin, false), "home-coin-market");
    assert.deepEqual([quiet.windows["24h"].buys, quiet.windows["24h"].sells, quiet.market_cap_usd], [0, 0, "46250000.00"]);
    const missing = await market(`?coin=${encodeURIComponent(`${hex("dead")}::coin::NOPE`)}`);
    assert.equal(missing.status, 404);
    assert.equal((await market("?coin=nope")).status, 400);
  }));

test("burnable presale FDV uses the indexed supply after a burn", { skip }, async () => {
  let termsReads = 0;
  await withFixture(async ({ admin, market }) => {
    const pending = await ok<HomeCoinMarket>(await market(coin), "home-coin-market");
    assert.equal(pending.fdv_usd, null, "The terms only record the original supply");

    await admin.query("INSERT INTO presale_coin_metadata (coin_type, total_supply) VALUES ($1, $2)", [ORBIT, "800000000000000000"]);
    const observed = await ok<HomeCoinMarket>(await market(coin), "home-coin-market");
    assert.deepEqual([observed.supply?.total, observed.fdv_usd, observed.market_cap_usd], ["800000000000000000", "40000000.00", "36250000.00"]);
    assert.equal(termsReads, 1, "Only the read without indexed supply needs terms");
  }, async (id, signal) => {
    termsReads += 1;
    const fixed = await terms(id, signal);
    return fixed && { ...fixed, burnable: true };
  });
});

test("gap 3: holders carry their basis by the portfolio's rule; a named account only when it shares its portfolio", { skip }, () =>
  withFixture(async ({ holders }) => {
    const page = await ok<HomeHoldersPage>(await holders(`${coin}&limit=10`), "home-holders-page", "public, s-maxage=10");
    const byKey = new Map(page.holders.map((holder) => [holder.actor.type === "account" ? holder.actor.callsign : holder.actor.address, holder]));
    assert.deepEqual([...byKey.keys()], [W.anon, "maya", "leo"], "largest first, maya's two wallets one holder, the pool left out");
    // Maya: 1,000 claimed for $40, +500 for $20 (1,500 for $60), −250 sold at average ($50 left), +100 for $4: 1,350 held for $54.
    const maya = byKey.get("maya")!;
    assert.deepEqual([maya.balance, maya.basis_usd, maya.basis_complete, maya.value_usd, maya.average_entry_usd], ["1350000000000", "54.00", true, "67.50", "0.04"]);
    assert.deepEqual([maya.pnl_usd, maya.pnl_multiple], ["13.50", "1.2500"]);
    // Leo keeps his portfolio private: no figures, never derived from his name.
    const leo = byKey.get("leo")!;
    assert.deepEqual([leo.basis_usd, leo.basis_complete, leo.pnl_usd, leo.average_entry_usd], [null, false, null, null]);
    assert.equal(leo.value_usd, "12.50", "his balance's value is public");
    // The anonymous wallet: chain data, answered. It holds exactly what it bought; the trades past the watermark do not count.
    const anon = byKey.get(W.anon)!;
    assert.deepEqual([anon.basis_usd, anon.basis_complete, anon.value_usd, anon.pnl_usd, anon.pnl_multiple], ["1500.00", true, "1875.00", "375.00", "1.2500"]);
    assert.equal(anon.share_bps, 0);
  }));

test("parity: a named holder's why is its latest active why on its own post about the coin, whatever its portfolio setting", { skip }, () =>
  withFixture(async ({ admin, activity, holders }) => {
    const entry = (row: ChainActivityRow) => `a:${row.checkpoint}:${row.tx_slot}:${row.event_slot}:${row.part}`;
    const [mayaCommit, mayaClaim, mayaBuy, , , leoBuy] = activity;
    const why = (n: number, row: ChainActivityRow, author: string, text: string) =>
      admin.query("INSERT INTO social_whys (why_id, entry_id, author_account_id, text) VALUES ($1, $2, $3, $4)", [uuid(0xc0 + n), entry(row!), author, text]);
    await why(1, mayaCommit!, A.maya, "Early to the team");
    await why(2, mayaBuy!, A.maya, "Adding on the breakout");
    await why(3, leoBuy!, A.leo, "Leo's case");
    // A why by leo on maya's claim is no thesis of his: the naming rule names maya for it.
    await why(4, mayaClaim!, A.leo, "Not leo's post");
    const page = await ok<HomeHoldersPage>(await holders(`${coin}&limit=10`), "home-holders-page", "public, s-maxage=10");
    const whyOf = new Map(page.holders.map((holder) => [holder.actor.type === "account" ? holder.actor.callsign : holder.actor.address, holder.why]));
    // Maya's newest; leo's though his portfolio is private; the anonymous wallet has none.
    assert.deepEqual([...whyOf], [[W.anon, null], ["maya", "Adding on the breakout"], ["leo", "Leo's case"]]);
    // While trading is hidden, a why on a trade is no thesis: maya's commit why is the line, leo has none.
    const hiddenPage = await ok<HomeHoldersPage>(await holders(`${coin}&limit=10`, false), "home-holders-page", "public, s-maxage=10");
    assert.deepEqual(hiddenPage.holders.map((holder) => holder.why), [null, "Early to the team", null]);
    // A deleted why is none; the next newest is the line.
    await admin.query("UPDATE social_whys SET state = 'deleted', deleted_at = now() WHERE why_id = $1", [uuid(0xc2)]);
    const after = await ok<HomeHoldersPage>(await holders(`${coin}&limit=10`), "home-holders-page", "public, s-maxage=10");
    assert.deepEqual(after.holders.map((holder) => holder.why), [null, "Early to the team", "Leo's case"]);
  }));

test("gap 7: big trades are the span's trades of at least $1,000; my swaps are every trade of the viewer's wallets", { skip }, () =>
  withFixture(async ({ now, trades, mine }) => {
    const span = `${coin}&from_ms=${now - 2 * DAY}&to_ms=${now + HOUR}`;
    const big = await ok<HomeChartTradesPage>(await trades(span), "home-chart-trades-page");
    assert.deepEqual(big.trades.map((row) => [row.side, row.usd, row.actor.type]), [["buy", "1500.00", "address"], ["sell", "2000.00", "address"]]);
    assert.equal(big.to_ms, now, "the span ends at the chain clock, never past it");
    assert.equal(big.min_usd, 1_000);
    assert.match(big.trades[0]!.entry_id, /^a:\d+:0:1:0$/);
    const larger = await ok<HomeChartTradesPage>(await trades(`${span}&min_usd=1800`), "home-chart-trades-page");
    assert.deepEqual(larger.trades.map((row) => row.usd), ["2000.00"]);
    const own = await ok<HomeChartTradesPage>(await mine("maya", span), "home-chart-trades-page", "private, no-store");
    assert.deepEqual(own.trades.map((row) => [row.side, row.usd]), [["buy", "4.00"], ["sell", "10.00"], ["buy", "20.00"]]);
    assert.ok(own.trades.every((row) => row.actor.type === "account" && row.actor.callsign === "maya"));
    assert.equal(own.min_usd, null);
    assert.equal((await mine(null, span)).status, 401);
  }));


test("Home keeps market and holder data when its runtime terms source is unavailable", { skip }, async (t) => {
  installRuntimeConfig();
  takeProcessSingleton("social.home-terms");
  t.after(() => { takeProcessSingleton("social.home-terms"); takeProcessSingleton("runtimeConfig"); });
  t.mock.method(globalThis, "fetch", async () => Response.json({ private: "provider failure" }, { status: 503 }));
  await withFixture(async ({ market, holders }) => {
    const answer = await ok<HomeCoinMarket>(await market(coin), "home-coin-market");
    assert.deepEqual([answer.price_usd, answer.supply, answer.fdv_usd, answer.market_cap_usd], ["0.05", null, null, null]);
    assert.deepEqual([answer.windows["24h"].buys, answer.windows["24h"].sells], [5, 1]);
    const page = await ok<HomeHoldersPage>(await holders(`${coin}&limit=10`), "home-holders-page", "public, s-maxage=10");
    assert.deepEqual(page.holders.map((holder) => [holder.balance, holder.value_usd, holder.share_bps]), [
      ["37500000000000", "1875.00", null],
      ["1350000000000", "67.50", null],
      ["250000000000", "12.50", null],
    ]);
  }, readHomeTerms);
});
