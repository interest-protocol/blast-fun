import { testClient } from "../../../../../core/test/fixtures/lib/web-security/client-address.ts";
import assert from "node:assert/strict";
import test from "node:test";
import type { QueryResultRow } from "pg";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_TRADE_BASE_COINS } from "@blast/core/modules/social/contracts/trades.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import type { SocialRequestContext, SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import type { TradeRouteAnswer, TradeRouter } from "@blast/server/modules/social/trades/aggregator.ts";
import { observeQuoteStage, startQuoteStage } from "@blast/server/modules/social/trades/quote-metrics.ts";
import { quoteTrade, type TradeQuoteDependencies, type TradeQuoteInput } from "@blast/server/modules/social/trades/quote.ts";
import { TRADE_PRICES_SQL, TRADE_SALE_COINS_SQL } from "@blast/server/modules/social/trades/coins.ts";
import { balanceKey, offlineTradeChain, replayRouter, SALE_B, SALE_B_POOL, SENDER, simulatedSwap, simulationSuccess, SUI } from "../../../../test/fixtures/modules/social/trades/fixtures.ts";
import { tradeQuoteKey } from "@blast/server/modules/social/trades/quote-token.ts";
import { createSocialTradeRoutes } from "@blast/server/modules/social/trades/route.ts";

const input: TradeQuoteInput = { inCoin: SOCIAL_TRADE_BASE_COINS.sui, outCoin: SOCIAL_TRADE_BASE_COINS.usdc, side: "sell", amountIn: 100n, amountOut: null, slippageBps: 50 };
const caller = { kind: null, accountId: null, wallet: null };
const emptyRows = { rows: [], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
const route: TradeRouteAnswer = { status: "route", route: { requestId: "private-provider-request", amountIn: 100n, amountOut: 20n, paths: [], aggregatorPackage: "", deviationRatio: null, blastFee: 0n } };

function dependencies(database: ReadableDatabase, findRoute: TradeRouter["findRoute"]): TradeQuoteDependencies {
  return {
    database: () => database,
    router: () => ({ fee: null, findRoute, appendSwap: async () => { throw new Error("no swap expected"); } }),
    chain: () => { throw new Error("no fullnode work expected"); },
    quoteKey: () => { throw new Error("no executable quote expected"); },
    now: () => 1_791_000_000_000,
  };
}

const events = (lines: string[]) => lines.map((line) => JSON.parse(line)).filter((event) => event.metric === "social.trade_quote.stage");

test("stage observations use monotonic duration, sample only successes, and preserve exact result and error identities", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(line));
  let clock = 100;
  t.mock.method(performance, "now", () => clock);
  const random = t.mock.method(Math, "random", () => 0.01);
  const result = Object.freeze({ value: "private-operation-value" });
  assert.equal(await observeQuoteStage("coin_read", async () => { clock += 23; return result; }), result);
  random.mock.mockImplementation(() => 0.99);
  const error = new Error("private provider detail");
  await assert.rejects(observeQuoteStage("route_discovery", async () => { clock += 41; throw error; }), (caught) => caught === error);
  const recorded = events(lines);
  assert.deepEqual(recorded.map(({ stage, outcome, durationMs, sampleRate }) => ({ stage, outcome, durationMs, sampleRate })), [
    { stage: "coin_read", outcome: "ok", durationMs: 23, sampleRate: 0.02 },
    { stage: "route_discovery", outcome: "error", durationMs: 41, sampleRate: undefined },
  ]);
  assert.equal(random.mock.callCount(), 1, "observed errors are unsampled");
  assert.ok(lines.every((line) => !line.includes("private")));
});

test("clock, sampler and sink failures leave stage operations and errors unchanged", async (t) => {
  const result = Object.freeze({ success: true });
  const clock = t.mock.method(performance, "now", () => { throw new Error("telemetry clock unavailable"); });
  assert.equal(await observeQuoteStage("coin_read", async () => result), result);
  clock.mock.mockImplementation(() => 1);
  const finish = startQuoteStage("route_discovery");
  clock.mock.mockImplementation(() => { throw new Error("finish clock unavailable"); });
  assert.doesNotThrow(() => finish("error"));
  clock.mock.mockImplementation(() => 1);
  t.mock.method(Math, "random", () => { throw new Error("sampler unavailable"); });
  t.mock.method(console, "info", () => { throw new Error("sink unavailable"); });
  assert.equal(await observeQuoteStage("coin_read", async () => result), result);
  assert.equal(await observeQuoteStage("route_discovery", async () => result, () => { throw new Error("classifier unavailable"); }), result);
  const error = new Error("operation failed");
  await assert.rejects(observeQuoteStage("route_discovery", async () => { throw error; }), (caught) => caught === error);
});

test("exact-out second leg timeout exposes completed coin work and both route legs without private labels", async (t) => {
  let clock = 0;
  const lines: string[] = [];
  t.mock.method(performance, "now", () => clock);
  t.mock.method(Math, "random", () => 0);
  t.mock.method(console, "info", (line: string) => lines.push(line));
  let reads = 0;
  const database: ReadableDatabase = { read: async () => { reads += 1; clock += 30; return emptyRows; } };
  const routeCalls: boolean[] = [];
  const deps = dependencies(database, async (request) => {
    routeCalls.push(request.byAmountIn);
    clock += 40;
    return routeCalls.length === 1 ? route : { status: "unavailable", reason: "timeout" };
  });
  assert.equal((await quoteTrade(deps, { ...input, amountIn: null, amountOut: 20n }, caller)).unavailable_reason, "pool_unavailable");
  assert.equal(reads, 1);
  assert.deepEqual(routeCalls, [false, true]);
  assert.deepEqual(events(lines).map(({ stage, outcome, durationMs }) => ({ stage, outcome, durationMs })), [
    { stage: "coin_read", outcome: "ok", durationMs: 30 },
    { stage: "route_discovery", outcome: "unavailable", durationMs: 80 },
  ]);
  for (const event of events(lines)) assert.deepEqual(Object.keys(event).sort(), (event.outcome === "ok" ? ["metric", "at", "level", "stage", "outcome", "durationMs", "sampleRate"] : ["metric", "at", "level", "stage", "outcome", "durationMs"]).sort());
  assert.ok(events(lines).every((event) => event.level === 30));
  assert.ok(lines.every((line) => !line.includes("private-provider-request")));
});

test("quote coin-read failure remains the original error despite a throwing metric sink", async (t) => {
  t.mock.method(console, "info", () => { throw new Error("sink unavailable"); });
  t.mock.method(Math, "random", () => 0);
  const error = new Error("coin storage unavailable");
  const deps = dependencies({ read: async () => { throw error; } }, async () => { throw new Error("routing must not run"); });
  await assert.rejects(quoteTrade(deps, input, caller), (caught) => caught === error);
});

function quoteHandler(deps: TradeQuoteDependencies, consume: SocialRequestContext["consume"]) {
  let handler: ((context: SocialRequestContext) => Promise<Response>) | undefined;
  const kit = { route: (_spec: unknown, work: typeof handler) => { handler = work; return work; } } as unknown as SocialRouteKit;
  createSocialTradeRoutes({ ...deps, kit, blastWallet: async () => { throw new Error("anonymous quote needs no wallet"); } });
  assert.ok(handler);
  return (body: unknown) => handler!({
    request: new Request("https://blast.fun/api/social/trades/quote", { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    requestId: "private-request-id", client: testClient(), caller: null, account: null,
    json: (body) => Response.json(body), consume,
  } as SocialRequestContext);
}

test("durable quota and body-wallet preparation are distinct and stop at their actual failure boundaries", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(line));
  t.mock.method(Math, "random", () => 0);
  let consumed = 0;
  const deps = dependencies({ read: async () => emptyRows }, async () => ({ status: "no_route" }));
  const quotaError = new SocialRouteError("rate_limited");
  const refused = quoteHandler(deps, async () => { consumed += 1; throw quotaError; });
  await assert.rejects(refused({}), (caught) => caught === quotaError);
  assert.deepEqual(events(lines).map(({ stage, outcome }) => ({ stage, outcome })), [{ stage: "durable_quota", outcome: "error" }]);
  lines.length = 0;
  const admitted = quoteHandler(deps, async (bucket) => { assert.equal(bucket, "social_trade_quote_anon"); consumed += 1; });
  await assert.rejects(admitted({}), (error) => error instanceof SocialRouteError && error.code === "invalid_request");
  assert.deepEqual(events(lines).map(({ stage, outcome }) => ({ stage, outcome })), [{ stage: "durable_quota", outcome: "ok" }, { stage: "body_wallet_preparation", outcome: "error" }]);
  lines.length = 0;
  const response = await admitted({ in_coin: input.inCoin, out_coin: input.outCoin, side: "sell", amount_in: "100" });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).unavailable_reason, "no_pool");
  assert.equal(consumed, 3, "metrics never repeat a durable quota operation");
  assert.deepEqual(events(lines).map(({ stage, outcome }) => ({ stage, outcome })), [
    { stage: "durable_quota", outcome: "ok" }, { stage: "body_wallet_preparation", outcome: "ok" },
    { stage: "coin_read", outcome: "ok" }, { stage: "route_discovery", outcome: "unavailable" },
  ]);
});

function saleDatabase(): ReadableDatabase {
  return { async read<Row extends QueryResultRow>(sql: string) {
    const rows = sql === TRADE_SALE_COINS_SQL
      ? [{ presale_id: "fixture-presale", sale_token: SALE_B, sale_symbol: "BEE", sale_decimals: 9, venue: "cetus", pool_id: SALE_B_POOL }]
      : sql === TRADE_PRICES_SQL
        ? [{ coin_type: SUI, usd_price: "1.19", as_of_ms: "1790999995000" }, { coin_type: SALE_B, usd_price: "0.00000000006", as_of_ms: "1790999995000" }]
        : [];
    return { ...emptyRows, rows: rows as unknown as Row[], rowCount: rows.length };
  } };
}

test("a failed reference is observed unsampled while the unchanged main quote remains offered", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(line));
  t.mock.method(Math, "random", () => 0.99);
  const original = offlineTradeChain({ balances: { [balanceKey(SENDER, SUI)]: 10n ** 12n } });
  const chain = { ...original, simulate: async (bytes: Uint8Array) => {
    if (simulatedSwap(bytes).amountIn === 1_000_000n) throw new Error("private reference provider failure");
    return simulationSuccess();
  } };
  const tracked: Promise<unknown>[] = [];
  const quote = await quoteTrade({ database: saleDatabase, router: () => replayRouter().router, chain: () => chain, quoteKey: () => tradeQuoteKey("metrics-fixture-pepper-0123456789abcdef"), now: () => 1_791_000_000_000, trackWork: (work) => { tracked.push(work); return work; } }, { ...input, outCoin: SALE_B, side: "buy", amountIn: 100_000_000n }, { kind: "privy", accountId: "00000000-0000-4000-8000-000000000001", wallet: SENDER });
  assert.ok(quote.quote_id);
  assert.equal(quote.dry_run, "passed");
  assert.equal(quote.price_impact_unavailable, "reference_failed");
  assert.equal(tracked.length, 1);
  await tracked[0];
  assert.deepEqual(events(lines).map(({ stage, outcome, sampleRate }) => ({ stage, outcome, sampleRate })), [{ stage: "fullnode_reference", outcome: "error", sampleRate: undefined }]);
  assert.ok(lines.every((line) => !line.includes("private reference provider failure")));
});

test("a main fullnode failure does not finish its tracked reference stage before the reference work settles", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "info", (line: string) => lines.push(line));
  t.mock.method(Math, "random", () => 0);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  t.after(() => release());
  const original = offlineTradeChain({ balances: { [balanceKey(SENDER, SUI)]: 10n ** 12n } });
  const chain = { ...original, simulate: async (bytes: Uint8Array) => {
    if (simulatedSwap(bytes).amountIn === 100_000_000n) throw new Error("private main provider failure");
    await pending;
    return simulationSuccess();
  } };
  const tracked: Promise<unknown>[] = [];
  const quote = await quoteTrade({ database: saleDatabase, router: () => replayRouter().router, chain: () => chain, quoteKey: () => { throw new Error("no quote may be offered"); }, now: () => 1_791_000_000_000, trackWork: (work) => { tracked.push(work); return work; } }, { ...input, outCoin: SALE_B, side: "buy", amountIn: 100_000_000n }, { kind: "privy", accountId: "00000000-0000-4000-8000-000000000001", wallet: SENDER });
  assert.equal(quote.unavailable_reason, "pool_unavailable");
  assert.equal(tracked.length, 1);
  assert.deepEqual(events(lines).filter(({ stage }) => stage.startsWith("fullnode")).map(({ stage, outcome }) => ({ stage, outcome })), [{ stage: "fullnode_main", outcome: "error" }]);
  release();
  await tracked[0];
  assert.deepEqual(events(lines).filter(({ stage }) => stage.startsWith("fullnode")).map(({ stage, outcome }) => ({ stage, outcome })), [{ stage: "fullnode_main", outcome: "error" }, { stage: "fullnode_reference", outcome: "ok" }]);
});
