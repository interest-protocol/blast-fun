import { testClient } from "../../../../../../packages/core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { bcs } from "@mysten/sui/bcs";
import { TransactionDataBuilder } from "@mysten/sui/transactions";
import { fromBase64, normalizeSuiAddress } from "@mysten/sui/utils";
import type { Pool } from "pg";

import type { BlastTradeFee } from "@blast/core/lib/blast-trade-fee.ts";
import { createPrivyTokenVerifier } from "@blast/core/lib/privy-adapter/token-verifier.ts";
import { PostgresRateLimitEnforcer } from "@blast/core/modules/database/postgres-rate-limits.ts";
import { rebuildChainRead, type ChainPresaleRow } from "../../../../../../packages/core/test/fixtures/modules/database/chain-read-rows.ts";
import { createPool, createRuntimePool } from "@blast/core/modules/database/pool.ts";
import { urlAs } from "../../../../../../packages/core/test/fixtures/modules/database/role-fixtures.ts";
import { freshTestDatabase } from "../../../../../../packages/core/test/fixtures/modules/database/template.ts";
import { collectSwapReceipts, EXPORT_SWAP_RECEIPTS_SQL } from "@blast/server/modules/social/trades/tracking.ts";
import { recordSwapReceipt } from "@blast/server/modules/social/trades/receipts.ts";
import { autocommitReader, withTransaction } from "@blast/core/modules/database/transaction.ts";
import { fixtureChainNode, SUI_MAINNET_CHAIN_IDENTIFIER } from "../../../../../../packages/core/test/fixtures/modules/presale/deployment/fixtures.ts";
import { createPresaleDeploymentGate } from "@blast/core/modules/presale/deployment/service.ts";
import { CAP, fixtureChain, identity, memoryReservations, SPONSOR } from "../../../../../../packages/server/test/fixtures/modules/sponsor/route-fixtures.ts";
import { createSponsorService } from "@blast/server/modules/sponsor/service.ts";
import { PostgresSocialAccounts } from "@blast/server/modules/social/accounts/repository.ts";
import { createSocialConfigReader } from "@blast/core/modules/social/config/reader.ts";
import { SOCIAL_TRADES_PATH, socialTradeSettlePath, type SocialTrade } from "@blast/core/modules/social/contracts/trades.ts";
import { SOCIAL_WALLET_SESSION_COOKIE } from "@blast/core/modules/social/contracts/wallet-sign-in.ts";
import { createSocialValidator } from "@blast/core/modules/social/contracts/validate.ts";
import { createSocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import type { TradeRoute, TradeRouter } from "@blast/server/modules/social/trades/aggregator.ts";
import { minOut } from "@blast/core/modules/social/trades/amounts.ts";
import {
  AGGREGATOR_PACKAGE,
  balanceKey,
  offlineTradeChain,
  replayRouter,
  SALE_B,
  SALE_B_POOL,
  simulationAbort,
  SUI,
  TEST_BLAST_FEE,
  TEST_FEE_RECEIVER,
  USDC,
  type OfflineChainOptions,
} from "../../../../../../packages/server/test/fixtures/modules/social/trades/fixtures.ts";
import { sealTradeQuote, tradeQuoteKey } from "@blast/server/modules/social/trades/quote-token.ts";
import { routeByVenue } from "@blast/server/modules/social/trades/aftermath.ts";
import { recordedAftermathRouter, YUM, YUM_BINDING, YUM_POOL, YUM_WRAPPER } from "../../../../../../packages/server/test/fixtures/modules/social/trades/aftermath-fixtures.ts";
import { createSocialSwapRoutes, sponsoredToday, type ExecutedTrade, type TradeSponsor } from "@blast/server/modules/social/trades/swap.ts";

/**
 * Social feed R3-31 (AC-1 to AC-6, AC-8, AC-9; AC-126, AC-130): the swap
 * path over a disposable database, running as `blast_web`, with the Cetus
 * aggregator's recorded mainnet routes, an in-memory fullnode (balances, dry
 * runs, executed transactions), and the presale sponsor's real service over
 * its fixture gas pool. An embedded Blast wallet is a Privy session; a wallet
 * session is Slush's cookie. Nothing reaches a network; every chain call is
 * in the fullnode's log, so "sent nothing" is asserted, not assumed.
 */

const databaseUrl = process.env.MISSION_CONTROL_TEST_DATABASE_URL;
const skip = databaseUrl ? false : "MISSION_CONTROL_TEST_DATABASE_URL is not set";
const ORIGIN = "https://blast.fun";
const APP_ID = "social-swap-app";
const PEPPER = "social-swap-fixture-pepper-0123456789abcd";
const KEY = tradeQuoteKey(PEPPER);
const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const validator = createSocialValidator();
const POOL = { connectionTimeoutMs: 5_000, idleInTransactionMs: 5_000, idleTimeoutMs: 1_000, lockTimeoutMs: 2_000, max: 8, statementTimeoutMs: 10_000 };
const DID = "did:privy:presale-sponsor-alice";
const EMBEDDED = normalizeSuiAddress("0xe3b");
const SESSION_WALLET = normalizeSuiAddress("0x5e55");
const SESSION_TOKEN = "s".repeat(43);
const ACCOUNT = "00000000-0000-4000-8000-00000000e3b0";
const SESSION_ACCOUNT = "00000000-0000-4000-8000-000000005e55";
/** A raw chain error the fullnode reports; it must never reach a response or a log line (AC-8, AC-130). */
const RAW_CHAIN_ERROR = "MoveAbort(MoveLocation { module: ModuleId { address: 0xdead, name: Identifier(\"pool\") } }, 7) secret-trace-1234";

function bearer(subject: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT" });
  const payload = encode({ aud: APP_ID, exp: now + 3_600, iat: now - 60, iss: "privy.io", sid: "s-1", sub: subject });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { dsaEncoding: "ieee-p1363", key: keys.privateKey });
  return `Bearer ${header}.${payload}.${signature.toString("base64url")}`;
}

function presale(id: string, token: string, symbol: string, venue: Readonly<{ venue: ChainPresaleRow["venue"]; pool: string }> = { venue: "cetus", pool: SALE_B_POOL }): ChainPresaleRow {
  const now = Date.now();
  return {
    presale_id: id, sale_token: token, quote_type: SUI, sale_symbol: symbol, sale_name: symbol, sale_icon_url: "",
    sale_decimals: 9, quote_symbol: "SUI", quote_decimals: 9, lifecycle: "migrated", start_ms: now - 86_400_000, end_ms: now - 3_600_000,
    raise_target: "100000000000", min_commitment: "1000000", wallet_cap: null, total_commitments: "100000000000",
    participants: 3, venue: venue.venue, pool_id: venue.pool, updated_checkpoint: 900,
  };
}

/** The app's router over the recordings: Cetus and Bluefin replayed, Aftermath DAO-fee pools over the recorded pool. */
function appRouter(fee: BlastTradeFee | null): TradeRouter {
  return routeByVenue(replayRouter(undefined, fee).router, recordedAftermathRouter(fee));
}

/** A recorded route through the app's router. */
async function recordedRoute(from: string, target: string, amount: bigint, fee: BlastTradeFee | null = null): Promise<TradeRoute> {
  const answer = await appRouter(fee).findRoute({ from, target, amount, byAmountIn: true, aftermath: from === YUM || target === YUM ? YUM_BINDING : null });
  if (answer.status !== "route") throw new Error("no recorded route");
  return answer.route;
}

/** A quote R3-30 would have offered `sender` of `account`, sealed with the service's key. */
async function offer(input: { account: string; sender: string; from?: string; target?: string; side?: "buy" | "sell"; amount?: bigint; issuedAtMs?: number; slippageBps?: number; fee?: BlastTradeFee | null }) {
  const from = input.from ?? SUI;
  const target = input.target ?? SALE_B;
  const route = await recordedRoute(from, target, input.amount ?? 100_000_000n, input.fee ?? null);
  const issuedAtMs = input.issuedAtMs ?? Date.now();
  const slippageBps = input.slippageBps ?? 50;
  const quote = {
    accountId: input.account,
    sender: input.sender,
    side: input.side ?? "buy",
    inCoin: from,
    outCoin: target,
    amountIn: route.amountIn,
    amountOut: route.amountOut,
    minOut: minOut(route.amountOut, slippageBps),
    slippageBps,
    priceImpactBps: null,
    blastFeeBps: input.fee?.bps ?? 0,
    issuedAtMs,
    expiresAtMs: issuedAtMs + 20_000,
    route,
  };
  return { quoteId: sealTradeQuote(KEY, quote), quote };
}

type Fixture = Readonly<{
  admin: Pool;
  /** The test's own database. */
  url: string;
  chain: ReturnType<typeof offlineTradeChain>;
  sponsorCalls: string[];
  executed: Map<string, ExecutedTrade | "lookup_fails">;
  create(body: Readonly<Record<string, unknown>>, as?: "embedded" | "session"): Promise<Response>;
  settle(tradeId: string, as?: "embedded" | "session"): Promise<Response>;
  setNow(ms: number | null): void;
}>;

async function withFixture(run: (fixture: Fixture) => Promise<void>, options: { chain?: OfflineChainOptions; cap?: number; fee?: BlastTradeFee } = {}): Promise<void> {
  const database = await freshTestDatabase();
  const { url } = database;
  const admin = createPool(url, { max: 4 });
  await rebuildChainRead(admin, {
    presales: [
      presale(`0x${"b0b".padStart(64, "0")}`, SALE_B, "BEE"),
      presale(`0x${"a1a1".padStart(64, "0")}`, YUM, "YUM", { venue: "aftermath", pool: YUM_POOL }),
    ],
    prices: [{ coin_type: SUI, usd_price: "1.19", as_of_ms: Date.now(), source: "pyth" }],
  });
  await admin.query(
    `INSERT INTO social_accounts (account_id, privy_did, callsign, onboarded_at, privacy, sharing_since) VALUES ($1, $2, 'embedded', now(), 'public', now())`,
    [ACCOUNT, DID],
  );
  await admin.query(`INSERT INTO social_accounts (account_id, sui_address, callsign) VALUES ($1, $2, 'session')`, [SESSION_ACCOUNT, SESSION_WALLET]);
  if (options.cap !== undefined) {
    await admin.query("INSERT INTO social_config (key, value, updated_by) VALUES ('trade_sponsor_daily_cap', $1::jsonb, 'fixture')", [JSON.stringify(options.cap)]);
  }

  const webPool = createRuntimePool(urlAs(url, "blast_web"), POOL, "social-swap-web");
  let clock: number | null = null;
  try {
    const kit = createSocialRouteKit({
      tradingVisible: () => true,
      expectedOrigin: ORIGIN,
      verifyAccessToken: createPrivyTokenVerifier({
        appId: APP_ID,
        verificationKey: keys.publicKey.export({ format: "pem", type: "spki" }).toString(),
      }),
      limiter: new PostgresRateLimitEnforcer({
        pool: webPool,
        subjectPepper: PEPPER,
        clock: () => new Date(clock ?? Date.now()),
      }),
      accounts: new PostgresSocialAccounts(() => webPool),
      walletSessions: { live: async (token) => (token === SESSION_TOKEN ? { address: SESSION_WALLET } : null) },
      primary: () => webPool,
      metricSampleRate: 0,
    });
    const chain = offlineTradeChain({
      balances: {
        [balanceKey(EMBEDDED, SUI)]: 10n ** 12n,
        [balanceKey(EMBEDDED, USDC)]: 10n ** 9n,
        [balanceKey(SESSION_WALLET, SUI)]: 10n ** 12n,
        [balanceKey(SESSION_WALLET, USDC)]: 10n ** 9n,
      },
      ...options.chain,
    });
    // The presale sponsor's real service over its fixture gas pool, with no contract allowlist.
    const sponsorCalls: string[] = [];
    const real = createSponsorService({
      deployment: createPresaleDeploymentGate({ environment: identity(), node: async () => fixtureChainNode(SUI_MAINNET_CHAIN_IDENTIFIER) }),
      wallets: { async require(did) { return did === DID ? EMBEDDED : `0x${"0".repeat(64)}`; } },
      chain: fixtureChain().chain,
      reservations: memoryReservations().store,
      executions: { async today() { return { allowed: true }; } },
      config: () => ({ sponsorAddress: SPONSOR, maxGasMist: CAP, swapTargets: [], tradeFee: () => options.fee ?? null }),
      // The sponsor's per-IP, per-account daily and platform budgets, in the shared table (review M1).
      limits: new PostgresRateLimitEnforcer({ pool: webPool, subjectPepper: PEPPER }),
    });
    const sponsor: TradeSponsor = {
      async sponsor(request) {
        sponsorCalls.push(request.intent);
        return real.sponsor(request);
      },
    };
    const executed = new Map<string, ExecutedTrade | "lookup_fails">();
    const config = createSocialConfigReader(autocommitReader(webPool, "social"), { now: () => 0 });
    const routes = createSocialSwapRoutes({
      kit,
      database: () => autocommitReader(webPool, "social"),
      router: () => appRouter(options.fee ?? null),
      chain: () => chain,
      quoteKey: () => KEY,
      sponsor: () => sponsor,
      config: config.getSocialConfig,
      transactions: () => ({
        async executed(digest) {
          const found = executed.get(digest);
          if (found === "lookup_fails") throw new Error(RAW_CHAIN_ERROR);
          return found ?? null;
        },
      }),
      blastWallet: async (caller) => (caller.kind === "privy" ? EMBEDDED : caller.address),
      now: () => clock ?? Date.now(),
    });
    const headers = (as: "embedded" | "session"): Record<string, string> =>
      as === "embedded"
        ? { authorization: bearer(DID) }
        : { cookie: `${SOCIAL_WALLET_SESSION_COOKIE}=${SESSION_TOKEN}`, "sec-fetch-site": "same-origin" };
    await run({
      admin,
      url,
      chain,
      sponsorCalls,
      executed,
      create: (body, as = "embedded") =>
        routes.create.POST(new Request(`${ORIGIN}${SOCIAL_TRADES_PATH}`, {
          method: "POST",
          headers: { origin: ORIGIN, "content-type": "application/json", ...headers(as) },
          body: JSON.stringify(body),
        }), testClient()),
      settle: (tradeId, as = "embedded") =>
        routes.settle.POST(new Request(`${ORIGIN}${socialTradeSettlePath(tradeId)}`, { method: "POST", headers: { origin: ORIGIN, ...headers(as) } }), testClient()),
      setNow: (ms) => {
        clock = ms;
      },
    });
  } finally {
    await webPool.end();
    await admin.end();
    await database.drop();
  }
}

async function tradeOf(response: Response, status: number): Promise<SocialTrade> {
  const body = (await response.json()) as SocialTrade;
  assert.equal(response.status, status, JSON.stringify(body));
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const checked = validator.validate("trade-response", body);
  assert.ok(checked.valid, JSON.stringify(checked.errors));
  return body;
}

function requestFor(quoteId: string, quote: { amountIn: bigint; minOut: bigint }, extra: Record<string, unknown> = {}) {
  const body = { quote_id: quoteId, amount_in: quote.amountIn.toString(), min_out: quote.minOut.toString(), idempotency_key: randomUUID(), ...extra };
  assert.ok(validator.validate("trade-request", body).valid);
  return body;
}

type LogRow = { tx_id: string; kind: string; state: string; digest: string | null; failure_code: string | null; coin_type: string; amount: string; quote_type: string; quote_amount: string };
const logRows = (admin: Pool) =>
  admin.query<LogRow>("SELECT tx_id::text, kind, state, digest, failure_code, coin_type, amount::text, quote_type, quote_amount::text FROM social_transactions ORDER BY created_at_ms").then((result) => result.rows);

/** What the fullnode shows for an executed swap: the wallet got `filled` of the coin. */
function landed(sender: string, coin: string, filled: bigint): ExecutedTrade {
  return { success: true, sender, balanceChanges: [{ coinType: coin, address: sender, amount: filled.toString() }], gasMist: 1_500_000n, abort: null };
}

test("an embedded wallet's one-hop trade is built over the quoted pool, sponsored, logged, and confirms at or above min_out (R3-31-AC-1, AC-5)", { skip }, async () => {
  await withFixture(async ({ admin, chain, sponsorCalls, executed, create, settle }) => {
    const { quoteId, quote } = await offer({ account: ACCOUNT, sender: EMBEDDED });
    const built = await tradeOf(await create(requestFor(quoteId, quote)), 201);
    assert.equal(built.status, "built");
    assert.deepEqual(built.network_fee, { payer: "blast", label: "Paid by Blast" });
    assert.deepEqual(sponsorCalls, ["trade"]);
    assert.equal(built.route_label, "SUI → BEE · Cetus");
    const bytes = fromBase64(built.transaction_bytes!);
    assert.equal(built.digest, TransactionDataBuilder.getDigestFromBytes(bytes));
    const data = bcs.TransactionData.parse(bytes).V1!;
    assert.equal(normalizeSuiAddress(data.sender), EMBEDDED);
    assert.equal(normalizeSuiAddress(data.gasData.owner!), SPONSOR, "Blast's gas pool pays");
    const calls = data.kind.ProgrammableTransaction!.commands.flatMap((command) => (command.MoveCall ? [command.MoveCall] : []));
    const swap = calls.find((call) => call.function === "swap")!;
    const pool = data.kind.ProgrammableTransaction!.inputs[(swap.arguments[2] as { Input: number }).Input]!;
    assert.equal(normalizeSuiAddress(pool.Object!.SharedObject!.objectId), SALE_B_POOL, "the quoted pool");
    // The minimum is in the transaction: the swap context carries the quoted amount out and the slippage.
    const context = calls.find((call) => call.function === "new_swap_context_v3")!;
    const pure = (n: number) => Buffer.from(data.kind.ProgrammableTransaction!.inputs[(context.arguments[n] as { Input: number }).Input]!.Pure!.bytes, "base64");
    assert.equal(normalizeSuiAddress(context.package), AGGREGATOR_PACKAGE);
    assert.equal(pure(3).readBigUInt64LE(), quote.amountOut);
    assert.equal(pure(4).readBigUInt64LE(), 5_000n);
    assert.deepEqual(chain.log.filter((entry) => entry.kind === "execute"), [], "the server executes nothing");

    let [logged] = await logRows(admin);
    assert.deepEqual(
      [logged!.tx_id, logged!.kind, logged!.state, logged!.digest, logged!.coin_type, logged!.amount, logged!.quote_type, logged!.quote_amount],
      [built.trade_id, "trade_buy", "submitted", built.digest, SALE_B, quote.amountOut.toString(), SUI, quote.amountIn.toString()],
    );

    // Not on chain yet: still built.
    assert.equal((await tradeOf(await settle(built.trade_id), 200)).status, "built");
    executed.set(built.digest!, { ...landed(EMBEDDED, SALE_B, quote.amountOut - 7n), timestampMs: 1792400000000, checkpoint: "326274009" });
    const confirmed = await tradeOf(await settle(built.trade_id), 200);
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.amount_out_filled, (quote.amountOut - 7n).toString());
    assert.ok(BigInt(confirmed.amount_out_filled!) >= quote.minOut);
    assert.equal(confirmed.transaction_bytes, null, "nothing left to sign");
    [logged] = await logRows(admin);
    assert.deepEqual([logged!.state, logged!.digest], ["confirmed", built.digest]);
    const [receipt] = (await admin.query(EXPORT_SWAP_RECEIPTS_SQL, [1792400000000, 1792400000001, 0, "00000000-0000-0000-0000-000000000000"])).rows;
    assert.deepEqual(receipt, {
      trade_id: built.trade_id, digest: built.digest, sender: EMBEDDED,
      bought_coin: SALE_B, bought_amount_atoms: (quote.amountOut - 7n).toString(),
      paid_coin: SUI, paid_amount_atoms: quote.amountIn.toString(), timestamp_ms: "1792400000000",
      checkpoint: "326274009", usd_value: "0.12", usd_basis: "input_value_at_submission",
    });
    await settle(built.trade_id);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_swap_receipts")).rows[0].n, 1);
    assert.equal((await admin.query(EXPORT_SWAP_RECEIPTS_SQL, [1792399999999, 1792400000000, 0, "00000000-0000-0000-0000-000000000000"])).rowCount, 0, "end is exclusive");

  });
});

test("selling an indexed non-Blast coin is sponsored, charges the configured fee, and settles like any other routed swap", { skip }, async () => {
  const amount = 100_000_000_000_000_000n;
  await withFixture(async ({ admin, sponsorCalls, executed, create, settle }) => {
    // Replay existing mainnet objects as a generic indexed coin, without a Blast presale.
    await admin.query("DELETE FROM blast_infra_fixture.presales WHERE sale_token = $1", [SALE_B]);
    await admin.query("INSERT INTO blast_infra_fixture.coin_metadata (coin_type, name, symbol, decimals) VALUES ($1, 'DeepBook', 'DEEP', 9)", [SALE_B]);
    const { quoteId, quote } = await offer({ account: ACCOUNT, sender: EMBEDDED, from: SALE_B, target: SUI, side: "sell", amount, fee: TEST_BLAST_FEE });
    const built = await tradeOf(await create(requestFor(quoteId, quote)), 201);
    assert.equal(built.status, "built");
    assert.equal(built.side, "sell");
    assert.match(built.route_label!, /DEEP → SUI/);
    assert.deepEqual(sponsorCalls, ["trade"]);
    executed.set(built.digest!, { ...landed(EMBEDDED, SUI, quote.amountOut), timestampMs: 1792400000000, checkpoint: "326274009" });
    assert.equal((await tradeOf(await settle(built.trade_id), 200)).status, "confirmed");
    const receipt = (await admin.query(EXPORT_SWAP_RECEIPTS_SQL, [1792400000000, 1792400000001, 0, "00000000-0000-0000-0000-000000000000"])).rows[0];
    assert.equal(receipt.bought_coin, SUI, "sells also record the output coin");
    assert.equal(receipt.bought_amount_atoms, quote.amountOut.toString());
    assert.equal(receipt.usd_value, null, "an unpriced input does not invent USD");
    assert.equal(receipt.usd_basis, null);
  }, { fee: TEST_BLAST_FEE, chain: { balances: { [balanceKey(EMBEDDED, SALE_B)]: amount, [balanceKey(EMBEDDED, SUI)]: 10n ** 12n } } });
});

test("a two-hop trade uses exactly the quoted legs in order; a wallet session is sponsored like an embedded wallet (R3-31-AC-2, AC-5)", { skip }, async () => {
  await withFixture(async ({ sponsorCalls, create }) => {
    const { quoteId, quote } = await offer({ account: SESSION_ACCOUNT, sender: SESSION_WALLET, from: USDC, amount: 1_000_000n });
    const built = await tradeOf(await create(requestFor(quoteId, quote), "session"), 201);
    assert.equal(built.status, "built");
    assert.deepEqual(built.network_fee, { payer: "blast", label: "Paid by Blast" });
    assert.notEqual(built.reservation_id, null);
    assert.deepEqual(sponsorCalls, ["trade"], "a wallet session is sponsored under the same daily cap (owner ruling 2026-11-20, reversing OA-17)");
    const data = bcs.TransactionData.parse(fromBase64(built.transaction_bytes!)).V1!;
    assert.equal(normalizeSuiAddress(data.sender), SESSION_WALLET);
    assert.equal(normalizeSuiAddress(data.gasData.owner!), SPONSOR, "Blast's gas pool pays");
    const { inputs, commands } = data.kind.ProgrammableTransaction!;
    const pools = commands
      .flatMap((command) => (command.MoveCall?.function === "swap" ? [command.MoveCall] : []))
      .map((call) => normalizeSuiAddress(inputs[(call.arguments[2] as { Input: number }).Input]!.Object!.SharedObject!.objectId));
    assert.deepEqual(pools, quote.route.paths.map((path) => path.poolId), "the quoted pools, in the quoted order");
    assert.equal(built.route_label, "USDC → SUI → BEE · Sui pools and Cetus");
  });
});

test("an expired quote is quote_expired and a moved price is price_moved; neither sponsors, builds or sends anything (R3-31-AC-3)", { skip }, async () => {
  await withFixture(async ({ admin, chain, sponsorCalls, create }) => {
    const stale = await offer({ account: ACCOUNT, sender: EMBEDDED, issuedAtMs: Date.now() - 21_000 });
    const expired = await tradeOf(await create(requestFor(stale.quoteId, stale.quote)), 201);
    assert.deepEqual([expired.status, expired.failure_code, expired.transaction_bytes, expired.digest], ["failed", "quote_expired", null, null]);
    assert.equal(chain.log.length, 0, "an expired quote reads nothing from the chain");

    const moved = await offer({ account: ACCOUNT, sender: EMBEDDED });
    chain.log.length = 0;
    const refused = await tradeOf(await create(requestFor(moved.quoteId, moved.quote)), 201);
    assert.deepEqual([refused.status, refused.failure_code, refused.transaction_bytes], ["failed", "price_moved", null]);
    assert.deepEqual(chain.log.map((entry) => entry.kind), ["balance", "price", "simulate"], "one dry run, no execution");
    assert.deepEqual(sponsorCalls, []);
    assert.deepEqual((await logRows(admin)).map((row) => [row.state, row.failure_code]), [["failed", "quote_expired"], ["failed", "price_moved"]]);
  }, { chain: { simulation: () => simulationAbort(AGGREGATOR_PACKAGE, "errors", 1) } });
});

test("owner 2026-10-08: with Blast's 0.5% fee the sponsored trade pays it inside the swap, and the fill is the wallet's own net gain", { skip }, async () => {
  await withFixture(async ({ sponsorCalls, executed, create, settle }) => {
    const { quoteId, quote } = await offer({ account: ACCOUNT, sender: EMBEDDED, fee: TEST_BLAST_FEE });
    assert.ok(quote.route.blastFee > 0n);
    const built = await tradeOf(await create(requestFor(quoteId, quote)), 201);
    assert.equal(built.status, "built");
    assert.deepEqual(sponsorCalls, ["trade"], "the sponsor's policy admits the fee'd swap");
    assert.equal(built.amount_out, quote.amountOut.toString(), "the quoted amount out is net of the fee");
    const data = bcs.TransactionData.parse(fromBase64(built.transaction_bytes!)).V1!;
    const { inputs, commands } = data.kind.ProgrammableTransaction!;
    const context = commands.find((command) => command.MoveCall?.function === "new_swap_context_v3")!.MoveCall!;
    const pure = (n: number) => Buffer.from(inputs[(context.arguments[n] as { Input: number }).Input]!.Pure!.bytes, "base64");
    assert.equal(pure(3).readBigUInt64LE(), quote.amountOut, "the on-chain minimum is the net output's");
    assert.equal(pure(6).readUInt32LE(), 5_000);
    assert.equal(normalizeSuiAddress(`0x${pure(7).toString("hex")}`), TEST_FEE_RECEIVER);
    assert.ok(!commands.some((command) => command.TransferObjects && normalizeSuiAddress(`0x${Buffer.from(inputs[(command.TransferObjects.address as { Input: number }).Input]!.Pure!.bytes, "base64").toString("hex")}`) !== EMBEDDED), "no command transfers to anyone but the sender");

    // On chain the receiver gains the fee and the sender the rest: the fill is the sender's change alone.
    const landing = landed(EMBEDDED, SALE_B, quote.amountOut);
    executed.set(built.digest!, { ...landing, balanceChanges: [...landing.balanceChanges, { coinType: SALE_B, address: TEST_FEE_RECEIVER, amount: quote.route.blastFee.toString() }] });
    const confirmed = await tradeOf(await settle(built.trade_id), 200);
    assert.deepEqual([confirmed.status, confirmed.amount_out_filled], ["confirmed", quote.amountOut.toString()]);
  }, { fee: TEST_BLAST_FEE });
});

test("Aftermath: a DAO-fee pool's trade is built over the quoted pool, sponsored with Blast's fee split to its receiver, and settles at the wallet's net fill", { skip }, async () => {
  await withFixture(async ({ sponsorCalls, executed, create, settle, admin }) => {
    const { quoteId, quote } = await offer({ account: ACCOUNT, sender: EMBEDDED, target: YUM, amount: 1_000_000_000n, fee: TEST_BLAST_FEE });
    assert.deepEqual(quote.route.paths.map((path) => path.poolId), [YUM_WRAPPER]);
    const built = await tradeOf(await create(requestFor(quoteId, quote)), 201);
    assert.equal(built.status, "built");
    assert.deepEqual(sponsorCalls, ["trade"], "the sponsor's policy admits the DAO-fee swap and its fee transfer");
    assert.equal(built.route_label, "SUI → YUM · Aftermath");
    const data = bcs.TransactionData.parse(fromBase64(built.transaction_bytes!)).V1!;
    const { inputs, commands } = data.kind.ProgrammableTransaction!;
    const swap = commands.find((command) => command.MoveCall?.function === "swap_exact_in")!.MoveCall!;
    const pure = (argument: unknown) => Buffer.from(inputs[(argument as { Input: number }).Input]!.Pure!.bytes, "base64");
    assert.equal(pure(swap.arguments[8]).readBigUInt64LE(), quote.minOut + quote.route.blastFee, "the on-chain minimum is the promised minimum before Blast's fee");
    const recipients = commands.flatMap((command) => (command.TransferObjects ? [normalizeSuiAddress(`0x${pure(command.TransferObjects.address).toString("hex")}`)] : []));
    assert.deepEqual(recipients, [TEST_FEE_RECEIVER, EMBEDDED]);

    const landing = landed(EMBEDDED, YUM, quote.amountOut);
    executed.set(built.digest!, { ...landing, balanceChanges: [...landing.balanceChanges, { coinType: YUM, address: TEST_FEE_RECEIVER, amount: quote.route.blastFee.toString() }] });
    const confirmed = await tradeOf(await settle(built.trade_id), 200);
    assert.deepEqual([confirmed.status, confirmed.amount_out_filled], ["confirmed", quote.amountOut.toString()]);
    const [row] = await logRows(admin);
    assert.deepEqual([row!.kind, row!.state, row!.coin_type], ["trade_buy", "confirmed", YUM]);
  }, { fee: TEST_BLAST_FEE });
});

test("a quote priced at another Blast fee rate than the one charged now is quote_expired, and nothing is built or sponsored", { skip }, async () => {
  await withFixture(async ({ chain, sponsorCalls, create }) => {
    const unpaid = await offer({ account: ACCOUNT, sender: EMBEDDED });
    const refused = await tradeOf(await create(requestFor(unpaid.quoteId, unpaid.quote)), 201);
    assert.deepEqual([refused.status, refused.failure_code, refused.transaction_bytes], ["failed", "quote_expired", null]);
    assert.equal(chain.log.length, 0, "nothing is read from the chain");
    assert.deepEqual(sponsorCalls, []);
  }, { fee: TEST_BLAST_FEE });
});

test("a replayed key returns the first outcome and never builds again; another quote under it is trade_conflict (R3-31-AC-4)", { skip }, async () => {
  await withFixture(async ({ admin, sponsorCalls, create }) => {
    const { quoteId, quote } = await offer({ account: ACCOUNT, sender: EMBEDDED });
    const body = requestFor(quoteId, quote);
    const first = await tradeOf(await create(body), 201);
    const again = await tradeOf(await create(body), 200);
    assert.deepEqual(again, first);
    assert.deepEqual(sponsorCalls, ["trade"], "one sponsorship, one transaction");
    const other = await offer({ account: ACCOUNT, sender: EMBEDDED });
    const conflict = await create({ ...requestFor(other.quoteId, other.quote), idempotency_key: body.idempotency_key });
    assert.equal(conflict.status, 409);
    assert.equal(((await conflict.json()) as { error: { code: string } }).error.code, "trade_conflict");
    assert.equal((await logRows(admin)).length, 1);
  });
});

test("past the daily cap an embedded wallet is told the fee, and may still trade paying it (R3-31-AC-6)", { skip }, async () => {
  await withFixture(async ({ admin, sponsorCalls, create }) => {
    const first = await offer({ account: ACCOUNT, sender: EMBEDDED });
    assert.equal((await tradeOf(await create(requestFor(first.quoteId, first.quote)), 201)).network_fee?.payer, "blast");

    const second = await offer({ account: ACCOUNT, sender: EMBEDDED });
    const body = requestFor(second.quoteId, second.quote);
    const prompt = await create(body);
    assert.equal(prompt.status, 409);
    const answer = (await prompt.json()) as { error: { code: string; fee_mist: string } };
    assert.equal(answer.error.code, "sponsorship_unavailable");
    assert.equal(answer.error.fee_mist, "1500000", "the fee the wallet would pay, from the dry run");
    assert.equal((await logRows(admin)).length, 1, "a prompt records nothing");

    const paid = await tradeOf(await create({ ...body, accept_fee: true }), 201);
    assert.deepEqual([paid.status, paid.network_fee?.payer, paid.reservation_id], ["built", "wallet", null]);
    const data = bcs.TransactionData.parse(fromBase64(paid.transaction_bytes!)).V1!;
    assert.equal(normalizeSuiAddress(data.gasData.owner!), EMBEDDED, "the embedded wallet's own SUI pays");
    assert.deepEqual(sponsorCalls, ["trade"], "the cap held");
  }, { cap: 1 });
});

test("every failure path is a failed trade with a published code, and no raw chain error reaches a response or a log (R3-31-AC-8)", { skip }, async () => {
  const lines: string[] = [];
  const info = console.info;
  const error = console.error;
  console.info = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await withFixture(async ({ admin, executed, create, settle, setNow }) => {
      const answers: string[] = [];
      const body = async (response: Response) => {
        const text = await response.text();
        answers.push(text);
        return new Response(text, { status: response.status, headers: response.headers });
      };
      // A built trade the wallet never sends (it lapses below).
      const unsent = await offer({ account: ACCOUNT, sender: EMBEDDED, from: USDC, amount: 1_000_000n });
      const pending = await tradeOf(await body(await create(requestFor(unsent.quoteId, unsent.quote))), 201);
      assert.equal(pending.status, "built");

      // A trade that executed and aborted on chain: execution_failed, with the abort's text nowhere.
      const sent = await offer({ account: ACCOUNT, sender: EMBEDDED });
      const built = await tradeOf(await body(await create(requestFor(sent.quoteId, sent.quote))), 201);
      executed.set(built.digest!, { success: false, sender: EMBEDDED, balanceChanges: [], gasMist: 0n, abort: { packageId: normalizeSuiAddress("0xdead"), module: "pool", code: 7 } });
      const failed = await tradeOf(await body(await settle(built.trade_id)), 200);
      assert.deepEqual([failed.status, failed.failure_code], ["failed", "execution_failed"]);

      // A fullnode that cannot answer settles nothing, even past expiry.
      executed.set(pending.digest!, "lookup_fails");
      setNow(Date.now() + 10 * 60_000);
      assert.equal((await tradeOf(await body(await settle(pending.trade_id)), 200)).status, "built");
      // Once it answers that it has never seen the digest, past the bytes' expiry and grace: expired.
      executed.delete(pending.digest!);
      const lapsed = await tradeOf(await body(await settle(pending.trade_id)), 200);
      assert.deepEqual([lapsed.status, lapsed.failure_code], ["failed", "expired"]);
      setNow(null);
      // Review L2: the trade that failed on chain cost Blast its gas, so the daily cap counts it; the lapsed
      // one never landed and does not.
      assert.equal(await sponsoredToday(autocommitReader(admin, "social"), ACCOUNT, Date.now(), 20), 1);

      const states = (await logRows(admin)).map((row) => [row.tx_id === built.trade_id ? "sent" : "unsent", row.state, row.failure_code]);
      assert.deepEqual(states.sort(), [["sent", "failed", "execution_failed"], ["unsent", "failed", "expired"]]);
      for (const text of [...answers, ...lines]) {
        assert.ok(!text.includes("secret-trace-1234") && !text.includes("MoveAbort("), `raw chain error leaked: ${text.slice(0, 200)}`);
      }
    });
    // Insufficient balance and a vanished pool, each refused before anything is built.
    await withFixture(async ({ admin, create }) => {
      const { quoteId, quote } = await offer({ account: ACCOUNT, sender: EMBEDDED });
      const refused = await tradeOf(await create(requestFor(quoteId, quote)), 201);
      assert.deepEqual([refused.status, refused.failure_code], ["failed", "insufficient_balance"]);
      assert.deepEqual(refused.balance_failure, { reason: "input", coin_type: SUI, required_atoms: "100000000", available_atoms: "99999999" });
      assert.deepEqual((await logRows(admin)).map((row) => [row.state, row.failure_code]), [["failed", "insufficient_balance"]]);
    }, { chain: { balances: { [balanceKey(EMBEDDED, SUI)]: 99_999_999n } } });
    await withFixture(async ({ create }) => {
      const { quoteId, quote } = await offer({ account: ACCOUNT, sender: EMBEDDED });
      const gone = await tradeOf(await create(requestFor(quoteId, quote)), 201);
      assert.deepEqual([gone.status, gone.failure_code], ["failed", "pool_unavailable"]);
    }, { chain: { simulation: () => simulationAbort(normalizeSuiAddress("0xdead"), "pool", 7) } });
  } finally {
    console.info = info;
    console.error = error;
  }
});

test("a quote that is not this account's, edited, or with other numbers is invalid_request, and nothing is recorded", { skip }, async () => {
  await withFixture(async ({ admin, create }) => {
    const theirs = await offer({ account: SESSION_ACCOUNT, sender: SESSION_WALLET });
    const mine = await offer({ account: ACCOUNT, sender: EMBEDDED });
    for (const body of [
      requestFor(theirs.quoteId, theirs.quote),
      { ...requestFor(mine.quoteId, mine.quote), min_out: "1" },
      { ...requestFor(mine.quoteId, mine.quote), amount_in: (mine.quote.amountIn + 1n).toString() },
      { ...requestFor(mine.quoteId, mine.quote), quote_id: `${mine.quoteId.slice(0, -2)}AA` },
      { ...requestFor(mine.quoteId, mine.quote), idempotency_key: "not-a-uuid" },
    ]) {
      const response = await create(body);
      assert.equal(response.status, 400, JSON.stringify(body).slice(0, 80));
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, "invalid_request");
    }
    assert.equal((await logRows(admin)).length, 0);
    assert.equal((await admin.query("SELECT count(*)::int AS n FROM social_swap_intents")).rows[0].n, 0);
  });
});

test("past the social_intent bucket the trade route is 429 rate_limited with Retry-After (R3-31-AC-9)", { skip }, async () => {
  await withFixture(async ({ create, setNow }) => {
    setNow(Date.UTC(2026, 0, 1));
    for (let n = 0; n < 60; n += 1) assert.equal((await create({ nope: true })).status, 400, `request ${n}`);
    const limited = await create({ nope: true });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers.get("retry-after")) > 0);
    assert.equal(((await limited.json()) as { error: { code: string } }).error.code, "rate_limited");
  });
});

test("sponsor unavailable, zero native SUI: failed gas requirement is persisted and replayed", { skip }, async () => {
  const balances = { [balanceKey(EMBEDDED, USDC)]: 9949790000000000n, [balanceKey(EMBEDDED, SUI)]: 0n };
  await withFixture(async ({ admin, create, chain }) => {
    const offered = await offer({ account: ACCOUNT, sender: EMBEDDED, from: USDC, amount: 1_000_000n });
    const request = requestFor(offered.quoteId, offered.quote);
    const prompt = await create(request);
    assert.equal(prompt.status, 409);
    const error = (await prompt.json()).error;
    assert.equal(error.code, "sponsorship_unavailable");
    assert.equal(error.required_mist, "2000000");
    const failed = await tradeOf(await create({ ...request, accept_fee: true }), 201);
    assert.equal(failed.status, "failed");
    assert.equal(failed.failure_code, "insufficient_balance");
    assert.deepEqual(failed.balance_failure, { reason: "gas", coin_type: SUI, required_atoms: "2000000", available_atoms: "0" });
    assert.equal(failed.transaction_bytes, null);
    assert.equal(failed.digest, null);
    balances[balanceKey(EMBEDDED, SUI)] = 10_000_000_000n;
    const reads = chain.log.length;
    const replay = await tradeOf(await create({ ...request, accept_fee: true }), 200);
    assert.equal(chain.log.length, reads, "funding the wallet does not rebuild a terminal attempt");
    assert.deepEqual(replay, failed);
    assert.equal((await logRows(admin)).length, 1);
    assert.equal(chain.log.filter((call) => call.kind === "execute").length, 0);
  }, { cap: 0, chain: { balances } });
});

test("an embedded wallet with zero SUI is sponsored without any contract allowlist", { skip }, async () => {
  await withFixture(async ({ create, sponsorCalls }) => {
    const offered = await offer({ account: ACCOUNT, sender: EMBEDDED, from: USDC, amount: 1_000_000n });
    const trade = await tradeOf(await create(requestFor(offered.quoteId, offered.quote)), 201);
    assert.equal(trade.status, "built");
    assert.equal(trade.network_fee?.payer, "blast");
    assert.deepEqual(sponsorCalls, ["trade"]);
  }, { chain: { balances: { [balanceKey(EMBEDDED, USDC)]: 9949790000000000n, [balanceKey(EMBEDDED, SUI)]: 0n } } });
});


test("tracking excludes pre-existing swaps even when they settle after the migration", { skip }, async () => {
  await withFixture(async ({ admin, url, executed, create, settle }) => {
    const migration = new URL("../../../../../../packages/core/src/modules/database/migrations/0125_frontend_swap_receipts.up.sql", import.meta.url);
    const rollback = new URL("../../../../../../packages/core/src/modules/database/migrations/0125_frontend_swap_receipts.down.sql", import.meta.url);
    await admin.query(await readFile(rollback, "utf8"));
    const { quoteId, quote } = await offer({ account: ACCOUNT, sender: EMBEDDED });
    const built = await tradeOf(await create(requestFor(quoteId, quote)), 201);
    await admin.query(await readFile(migration, "utf8"));
    assert.equal((await admin.query("SELECT track_receipt FROM social_swap_intents")).rows[0].track_receipt, false);
    executed.set(built.digest!, { ...landed(EMBEDDED, SALE_B, quote.amountOut), timestampMs: 1792400000000, checkpoint: "326274009" });
    assert.equal((await tradeOf(await settle(built.trade_id), 200)).status, "confirmed");
    assert.equal((await admin.query("SELECT * FROM social_swap_receipts")).rowCount, 0);
    const runtime = createPool(urlAs(url, "blast_web"), { max: 1 });
    try {
      const report = await collectSwapReceipts({
        database: autocommitReader(runtime, "social"),
        transactions: { executed: async () => { throw new Error("historical swaps must never be looked up"); } },
        transaction: (operation) => withTransaction(runtime, (tx) => operation(tx.forModule("social"))),
      });
      assert.equal(report.scanned, 0);
      assert.equal(report.unavailable, 0);
    } finally {
      await runtime.end();
    }
  });
});

test("tracking retires checkpointed failures while retrying delayed swaps and exports only purchases", { skip }, async () => {
  await withFixture(async ({ admin, url, create }) => {
    const failedQuote = await offer({ account: ACCOUNT, sender: EMBEDDED });
    const failed = await tradeOf(await create(requestFor(failedQuote.quoteId, failedQuote.quote)), 201);
    const delayedQuote = await offer({ account: SESSION_ACCOUNT, sender: SESSION_WALLET });
    const delayed = await tradeOf(await create(requestFor(delayedQuote.quoteId, delayedQuote.quote), "session"), 201);
    const runtime = createPool(urlAs(url, "blast_web"), { max: 1 });
    const lookedUp: string[] = [];
    let checkpointed = false;
    const timestampMs = 1792400000000;
    try {
      const collect = () => collectSwapReceipts({
        database: autocommitReader(runtime, "social"),
        transactions: { executed: async (digest) => {
          lookedUp.push(digest);
          if (digest === failed.digest) return { ...landed(EMBEDDED, SALE_B, 0n), success: false, timestampMs, checkpoint: "326274009" };
          return { ...landed(SESSION_WALLET, SALE_B, delayedQuote.quote.amountOut), timestampMs: checkpointed ? timestampMs : null, checkpoint: checkpointed ? "326274009" : null };
        } },
        transaction: (operation) => withTransaction(runtime, (tx) => operation(tx.forModule("social"))),
      });
      const first = await collect();
      assert.equal(first.failed, 1);
      assert.equal(first.pending, 1);
      assert.equal(first.recorded, 0);
      assert.equal((await collect()).scanned, 1);
      checkpointed = true;
      assert.equal((await collect()).recorded, 1);
      assert.equal((await collect()).scanned, 0);
      assert.equal(lookedUp.filter((digest) => digest === failed.digest).length, 1);
      const failureReceipt = (await admin.query("SELECT success, amount_out FROM social_swap_receipts WHERE trade_id = $1", [failed.trade_id])).rows[0];
      assert.deepEqual(failureReceipt, { success: false, amount_out: null });
      const exported = await admin.query(EXPORT_SWAP_RECEIPTS_SQL, [timestampMs, timestampMs + 1, 0, "00000000-0000-0000-0000-000000000000"]);
      assert.deepEqual(exported.rows.map((receipt) => receipt.trade_id), [delayed.trade_id]);
    } finally {
      await runtime.end();
    }
  });
});

test("tracking recovers abandoned swaps after checkpointing, excludes wrong-sender outcomes and writes once", { skip }, async () => {
  await withFixture(async ({ admin, url, executed, create }) => {
    const { quoteId, quote } = await offer({ account: ACCOUNT, sender: EMBEDDED });
    const built = await tradeOf(await create(requestFor(quoteId, quote)), 201);
    const runtime = createPool(urlAs(url, "blast_web"), { max: 1 });
    try {
      const collect = () => collectSwapReceipts({
        database: autocommitReader(runtime, "social"),
        transactions: { executed: async (digest) => {
          const result = executed.get(digest);
          if (result === "lookup_fails") throw new Error("offline");
          return result ?? null;
        } },
        transaction: (operation) => withTransaction(runtime, (tx) => operation(tx.forModule("social"))),
      });
      const landedSwap = { ...landed(EMBEDDED, SALE_B, quote.amountOut - 7n), timestampMs: 1792400000000, checkpoint: "326274009" };
      executed.set(built.digest!, "lookup_fails");
      assert.equal((await collect()).unavailable, 1);
      for (const outcome of [
        { ...landedSwap, success: false, timestampMs: null, checkpoint: null },
        { ...landedSwap, sender: SESSION_WALLET },
        { ...landedSwap, timestampMs: null, checkpoint: null },
        { ...landedSwap, balanceChanges: [] },
      ]) {
        executed.set(built.digest!, outcome);
        assert.equal((await collect()).recorded, 0);
      }
      // The browser never called settle, so recovery must not depend on that state.
      executed.set(built.digest!, landedSwap);
      assert.equal((await collect()).recorded, 1);
      assert.equal((await collect()).scanned, 0);
      const receipt = (await admin.query("SELECT * FROM social_swap_receipts")).rows[0];
      assert.equal(receipt.amount_out, (quote.amountOut - 7n).toString());
      assert.equal(receipt.timestamp_ms, "1792400000000");
      const exported = execFileSync(process.execPath, [
        "--no-warnings", "--experimental-strip-types",
        fileURLToPath(new URL("../../../../scripts/swap-tracking.ts", import.meta.url)),
        "export", "--from", "2026-10-19T08:53:20Z", "--to", "2026-10-20T08:53:20Z",
      ], { env: { ...process.env, DATABASE_URL: urlAs(url, "blast_web") }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
      const exportedReceipt = JSON.parse(exported.trim());
      assert.equal(exportedReceipt.trade_id, built.trade_id);
      assert.equal(exportedReceipt.bought_amount_atoms, (quote.amountOut - 7n).toString());

      assert.equal((await admin.query("SELECT state FROM social_swap_intents")).rows[0].state, "built");
      const rollback = await readFile(new URL("../../../../../../packages/core/src/modules/database/migrations/0125_frontend_swap_receipts.down.sql", import.meta.url), "utf8");
      await assert.rejects(admin.query(rollback), /while receipts exist/);
      // Both the immediate path and recovery use the same uniqueness constraint.
      const row = (await admin.query("SELECT * FROM social_swap_intents")).rows[0];
      assert.equal(await withTransaction(runtime, (tx) => recordSwapReceipt(tx.forModule("social"), row, landedSwap)), false);
      for (const sql of ["UPDATE social_swap_receipts SET amount_out = 1", "DELETE FROM social_swap_receipts"]) {
        await assert.rejects(runtime.query(sql), { code: "42501" });
      }
    } finally {
      await runtime.end();
    }
  });
});

test("curve sponsor reservations share the swap cap, expire when abandoned, and are not double counted", { skip }, async () => {
  await withFixture(async ({ admin, create }) => {
    const db = autocommitReader(admin, "social");
    const insert = async (state: string, expires: number, submitted = false, id: string = randomUUID()) => {
      await admin.query(`INSERT INTO presale_sponsor_reservations
        (id, privy_did, sender, presale_id, intent, gas_budget, pool_deadline, expires_at, state, tx_bytes, digest, submitted_at)
        VALUES ($1, $2, $3, NULL, 'trade', 2000000, now(), to_timestamp($4::double precision / 1000), $5, $6, $7, CASE WHEN $8 THEN now() ELSE NULL END)`,
        [id, DID, EMBEDDED, expires, state, Buffer.from([1]), "1".repeat(32), submitted]);
      return id;
    };
    const now = Date.now();
    await insert("reserved", now - 1000);
    assert.equal(await sponsoredToday(db, ACCOUNT, now, 20), 0, "abandoned expired reviews release the cap");
    await insert("reserved", now + 60_000);
    assert.equal(await sponsoredToday(db, ACCOUNT, now, 20), 1);
    await insert("unconfirmed", now - 1000, true);
    assert.equal(await sponsoredToday(db, ACCOUNT, now, 20), 2, "possibly submitted gas remains counted");
    const offered = await offer({ account: ACCOUNT, sender: EMBEDDED });
    const built = await tradeOf(await create(requestFor(offered.quoteId, offered.quote)), 201);
    assert.ok(built.reservation_id);
    assert.equal(await sponsoredToday(db, ACCOUNT, now, 20), 3);
    await insert("reserved", now + 60_000, false, built.reservation_id);
    assert.equal(await sponsoredToday(db, ACCOUNT, now, 20), 3, "a reservation linked to a swap counts once");
  });
});

test("0162: a wallet session's curve reservation, keyed sui:<its address>, counts toward its account's swap cap", { skip }, async () => {
  await withFixture(async ({ admin }) => {
    const db = autocommitReader(admin, "social");
    const other = normalizeSuiAddress("0x07e4");
    // A curve trade's reservation: no social_swap_intents row names it.
    const insert = async (sender: string, submitted: boolean) => {
      await admin.query(`INSERT INTO presale_sponsor_reservations
        (id, privy_did, sender, presale_id, intent, gas_budget, pool_deadline, expires_at, state, tx_bytes, digest, submitted_at)
        VALUES ($1, 'sui:' || $2::text, $2, NULL, 'trade', 2000000, now(), now() + interval '1 minute', $3, $4, $5, CASE WHEN $6 THEN now() ELSE NULL END)`,
        [randomUUID(), sender, submitted ? "submitted" : "reserved", Buffer.from([1]), "1".repeat(32), submitted]);
    };
    const now = Date.now();
    assert.equal(await sponsoredToday(db, SESSION_ACCOUNT, now, 20), 0);
    await insert(SESSION_WALLET, false);
    assert.equal(await sponsoredToday(db, SESSION_ACCOUNT, now, 20), 1, "an open review holds a slot");
    await insert(SESSION_WALLET, true);
    assert.equal(await sponsoredToday(db, SESSION_ACCOUNT, now, 20), 2, "a submitted one counts");
    await insert(other, true);
    assert.equal(await sponsoredToday(db, SESSION_ACCOUNT, now, 20), 2, "another wallet's reservation is not this account's");
    assert.equal(await sponsoredToday(db, ACCOUNT, now, 20), 0, "nor the Privy account's");
  });
});
