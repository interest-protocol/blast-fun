import assert from "node:assert/strict";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import { normalizeSuiAddress } from "@mysten/sui/utils";

import type { BlastTradeFee } from "@blast/core/lib/blast-trade-fee.ts";
import { grossForNetOut, parseTradeProviders, routeToSdk, TRADE_ROUTE_MAX_PATHS, withBlastFee, type TradeRoute } from "@blast/server/modules/social/trades/aggregator.ts";
import { swapKind } from "@blast/server/modules/social/trades/chain.ts";
import {
  AGGREGATOR_PACKAGE,
  balanceKey,
  offlineTradeChain,
  recordedData,
  replayRouter,
  SALE_A,
  SALE_B,
  SALE_B_POOL,
  SENDER,
  SUI,
  TEST_BLAST_FEE,
  TEST_FEE_RECEIVER,
  USDC,
} from "../../../../test/fixtures/modules/social/trades/fixtures.ts";

/**
 * Social feed R3-30 (OA-25 Q1/Q11): the Cetus aggregator SDK's real mainnet
 * answers, replayed through the SDK's own `findRouters` and swap builder. No
 * request leaves the process: the fixture answers only recorded requests.
 */

test("a direct pool answers one leg through it, exactly as recorded", async () => {
  const { router, log } = replayRouter();
  const answer = await router.findRoute({ from: SUI, target: SALE_B, amount: 100_000_000n, byAmountIn: true });
  assert.equal(answer.status, "route");
  if (answer.status !== "route") return;
  const recorded = recordedData("sui-sale-b");
  assert.equal(answer.route.amountIn, 100_000_000n);
  assert.equal(answer.route.amountOut.toString(), recorded.amountOut, "a u64 above 2^53 survives exactly");
  assert.equal(answer.route.requestId, recorded.requestId);
  assert.equal(answer.route.aggregatorPackage, AGGREGATOR_PACKAGE);
  assert.equal(answer.route.deviationRatio, "", "no market price for a sale coin");
  assert.equal(answer.route.paths.length, 1);
  const [leg] = answer.route.paths;
  assert.deepEqual(
    { pool: leg!.poolId, provider: leg!.provider, from: leg!.from, target: leg!.target, fee: leg!.feeRate },
    { pool: SALE_B_POOL, provider: "CETUS", from: SUI, target: SALE_B, fee: "0.01" },
  );
  assert.deepEqual(log, [{ from: SUI, target: SALE_B, amount: "100000000", byAmountIn: true }]);
});

test("no direct pool answers the legs the aggregator chose, in order, ending in the coin", async () => {
  const { router } = replayRouter();
  const answer = await router.findRoute({ from: USDC, target: SALE_B, amount: 1_000_000n, byAmountIn: true });
  assert.equal(answer.status, "route");
  if (answer.status !== "route") return;
  const { paths } = answer.route;
  assert.equal(paths.length, 3, "USDC, an intermediate the aggregator chose, SUI, then the sale coin");
  assert.equal(paths[0]!.from, USDC);
  paths.slice(1).forEach((leg, index) => assert.equal(leg.from, paths[index]!.target, "each leg starts where the last ended"));
  assert.deepEqual([paths[2]!.provider, paths[2]!.from, paths[2]!.target], ["CETUS", SUI, SALE_B]);
  assert.equal(answer.route.paths.at(-1)!.poolId, SALE_B_POOL);
});

test("a coin no pool reaches is no_route; a provider outside the list or an unreachable API is unavailable", async () => {
  assert.deepEqual(await replayRouter().router.findRoute({ from: SUI, target: SALE_A, amount: 100_000_000n, byAmountIn: true }), { status: "no_route" });
  // The recorded route runs through CETUS; a router limited to BLUEFIN must not quote it.
  assert.deepEqual(
    await replayRouter(["BLUEFIN"]).router.findRoute({ from: SUI, target: SALE_B, amount: 100_000_000n, byAmountIn: true }),
    { status: "unavailable", reason: "unusable_route:provider" },
  );
  // An amount nobody recorded: the fixture refuses the request, as a dead API would.
  assert.deepEqual(
    await replayRouter().router.findRoute({ from: SUI, target: SALE_B, amount: 5n, byAmountIn: true }),
    { status: "unavailable", reason: "error" },
  );
});

test("an exact-output request answers the input that buys it", async () => {
  const answer = await replayRouter().router.findRoute({ from: SUI, target: SALE_B, amount: 100_000_000_000_000_000n, byAmountIn: false });
  assert.equal(answer.status, "route");
  if (answer.status === "route") assert.equal(answer.route.amountIn, BigInt(recordedData("sui-sale-b-exact-out").amountIn));
});

test("the swap is built over the route's pool in its order, with the minimum in the swap context and no fee", async () => {
  const { router } = replayRouter();
  const answer = await router.findRoute({ from: SUI, target: SALE_B, amount: 100_000_000n, byAmountIn: true });
  assert.equal(answer.status, "route");
  if (answer.status !== "route") return;
  const chain = offlineTradeChain({ balances: { [balanceKey(SENDER, SUI)]: 10n ** 12n } });
  const kind = bcs.TransactionKind.parse(
    await swapKind({ router, route: answer.route, sender: SENDER, inCoin: SUI, slippageBps: 50, useGasCoin: false }, chain.client),
  );
  const { commands, inputs } = kind.ProgrammableTransaction!;
  const names = commands.map((command) => (command.$kind === "MoveCall" ? `${command.MoveCall!.module}::${command.MoveCall!.function}` : command.$kind));
  assert.deepEqual(names, ["SplitCoins", "router::new_swap_context_v3", "cetus::swap", "router::confirm_swap_v3", "TransferObjects"]);
  assert.ok(!commands.some((command) => JSON.stringify(command).includes("GasCoin")), "the gas coin is never touched");
  const pure = (argument: { $kind: string; Input?: number }) => Buffer.from(inputs[argument.Input!]!.Pure!.bytes, "base64");
  const context = commands[1]!.MoveCall!;
  assert.equal(normalizeSuiAddress(context.package), AGGREGATOR_PACKAGE);
  assert.equal(pure(context.arguments[2]!).readBigUInt64LE(), 100_000_000n, "quote amount in");
  assert.equal(pure(context.arguments[3]!).readBigUInt64LE(), 330_341_965_386_371_467n, "exact minimum out");
  assert.equal(pure(context.arguments[4]!).readBigUInt64LE(), 0n, "the minimum cannot be discounted again");
  assert.equal(pure(context.arguments[6]!).readUInt32LE(), 0, "no overlay fee");
  assert.equal(normalizeSuiAddress(`0x${pure(context.arguments[7]!).toString("hex")}`), normalizeSuiAddress("0x0"), "no fee recipient");
  const swap = commands[2]!.MoveCall!;
  const pool = inputs[(swap.arguments[2] as { Input: number }).Input]!;
  assert.equal(normalizeSuiAddress(pool.Object!.SharedObject!.objectId), SALE_B_POOL);
  const transfer = commands[4]!.TransferObjects!;
  assert.equal(normalizeSuiAddress(`0x${pure(transfer.address as { $kind: string; Input: number }).toString("hex")}`), SENDER);
});

test("a route round-trips through the SDK's shape", () => {
  const route: TradeRoute = {
    requestId: "r",
    amountIn: 10n,
    amountOut: 20n,
    aggregatorPackage: AGGREGATOR_PACKAGE,
    deviationRatio: null,
    blastFee: 0n,
    paths: [{ poolId: SALE_B_POOL, provider: "CETUS", direction: false, from: SUI, target: SALE_B, feeRate: "0.01", amountIn: 10n, amountOut: 20n, publishedAt: AGGREGATOR_PACKAGE }],
  };
  const sdk = routeToSdk(route, 20n);
  assert.equal(sdk.amountIn.toString(), "10");
  assert.equal(sdk.amountOut.mul(sdk.amountIn).toString(), "200", "the totals are the SDK's own BN");
  assert.equal(sdk.packages?.get("aggregator_v3"), AGGREGATOR_PACKAGE);
  assert.equal(sdk.paths[0]!.amountOut, "20");
  assert.equal(TRADE_ROUTE_MAX_PATHS, 8);
});

test("SOCIAL_TRADE_PROVIDERS names only venues the trade path builds without an oracle", () => {
  assert.deepEqual(parseTradeProviders(undefined), ["CETUS", "BLUEFIN"]);
  assert.deepEqual(parseTradeProviders(" cetus , Bluefin,CETUS "), ["CETUS", "BLUEFIN"]);
  assert.throws(() => parseTradeProviders("HAEDALPMM"), /HAEDALPMM/);
  assert.throws(() => parseTradeProviders("TURBOS"), /TURBOS/);
  assert.throws(() => parseTradeProviders("NOPE"), /NOPE/);
});

/** The swap context's arguments of the swap path's kind for a route of `router`. */
async function swapContextOf(router: ReturnType<typeof replayRouter>["router"], route: TradeRoute) {
  const chain = offlineTradeChain({ balances: { [balanceKey(SENDER, route.paths[0]!.from)]: 10n ** 12n } });
  const kind = bcs.TransactionKind.parse(
    await swapKind({ router, route, sender: SENDER, inCoin: route.paths[0]!.from, slippageBps: 50, useGasCoin: false }, chain.client),
  );
  const { commands, inputs } = kind.ProgrammableTransaction!;
  const context = commands.find((command) => command.MoveCall?.function === "new_swap_context_v3")!.MoveCall!;
  const pure = (index: number) => Buffer.from(inputs[(context.arguments[index] as { Input: number }).Input]!.Pure!.bytes, "base64");
  return {
    names: commands.map((command) => (command.$kind === "MoveCall" ? `${command.MoveCall!.module}::${command.MoveCall!.function}` : command.$kind)),
    quoteOut: pure(3).readBigUInt64LE(),
    slippage: pure(4).readBigUInt64LE(),
    feeRate: pure(6).readUInt32LE(),
    feeRecipient: normalizeSuiAddress(`0x${pure(7).toString("hex")}`),
  };
}

test("owner 2026-10-08: Blast's 0.5% comes off the output, in atoms, exactly as the aggregator takes it on chain", async () => {
  const { router, log } = replayRouter(undefined, TEST_BLAST_FEE);
  assert.equal(router.fee, TEST_BLAST_FEE);
  const answer = await router.findRoute({ from: SUI, target: SALE_B, amount: 100_000_000n, byAmountIn: true });
  assert.equal(answer.status, "route");
  if (answer.status !== "route") return;
  const gross = BigInt(recordedData("sui-sale-b").amountOut);
  const fee = (gross * 5_000n) / 1_000_000n;
  assert.equal(answer.route.blastFee, fee, "⌊gross × 5,000 ÷ 10⁶⌋, confirm_swap_v3's collect_fee");
  assert.equal(answer.route.amountOut, gross - fee, "what the wallet gets is net of it");
  assert.equal(answer.route.amountIn, 100_000_000n, "the input is the trader's, unchanged");
  assert.equal(answer.route.paths[0]!.amountOut, gross, "the venue's leg keeps its own output");
  assert.deepEqual(log, [{ from: SUI, target: SALE_B, amount: "100000000", byAmountIn: true }], "the aggregator is asked the same question");
});

test("the fee's swap names Blast's rate and receiver, and its minimum is the net output's", async () => {
  const { router } = replayRouter(undefined, TEST_BLAST_FEE);
  const answer = await router.findRoute({ from: SUI, target: SALE_B, amount: 100_000_000n, byAmountIn: true });
  if (answer.status !== "route") throw new Error("no route");
  const context = await swapContextOf(router, answer.route);
  assert.deepEqual(context.names, ["SplitCoins", "router::new_swap_context_v3", "cetus::swap", "router::confirm_swap_v3", "TransferObjects"], "no command moves the fee");
  assert.equal(context.feeRate, 5_000, "50 bps is 5,000 ppm of the output");
  assert.equal(context.feeRecipient, TEST_FEE_RECEIVER);
  assert.equal(context.quoteOut, 328_690_255_559_439_610n);
  assert.equal(context.slippage, 0n);

  // A route priced without the fee is never built by a router that charges it, nor the other way round.
  const plain = await replayRouter().router.findRoute({ from: SUI, target: SALE_B, amount: 100_000_000n, byAmountIn: true });
  if (plain.status !== "route") throw new Error("no route");
  await assert.rejects(swapContextOf(router, plain.route), /another Blast fee/);
  await assert.rejects(swapContextOf(replayRouter().router, answer.route), /another Blast fee/);
});

test("a tiny fee-bearing swap pins the minimum of the net payout on chain", async () => {
  const { router } = replayRouter(undefined, TEST_BLAST_FEE);
  const answer = await router.findRoute({ from: SUI, target: SALE_B, amount: 100_000_000n, byAmountIn: true });
  if (answer.status !== "route") throw new Error("no route");
  // 202 gross leaves 201 after the fee. At 0.5%, 199 is too little and 200 is enough.
  const route = { ...answer.route, amountOut: 201n, blastFee: 1n };
  const context = await swapContextOf(router, route);
  assert.equal(context.quoteOut, 200n);
  assert.equal(context.slippage, 0n);
});

test("every whole basis-point rate to 10% reaches the swap context as exact parts per million", async () => {
  const { router: plain } = replayRouter();
  const found = await plain.findRoute({ from: SUI, target: SALE_B, amount: 100_000_000n, byAmountIn: true });
  if (found.status !== "route") throw new Error("no route");
  // 79 bps is one the SDK's float scaling misses (0.0079 × 10⁶ = 7899.999…).
  for (const bps of [1, 50, 79, 157, 652, 1_000]) {
    const fee: BlastTradeFee = { bps, ppm: bps * 100, receiver: TEST_FEE_RECEIVER };
    const { router } = replayRouter(undefined, fee);
    const route: TradeRoute = withBlastFee(found.route, fee)!;
    const context = await swapContextOf(router, route);
    assert.equal(context.feeRate, bps * 100, `${bps} bps`);
    assert.equal(context.quoteOut, route.amountOut - route.amountOut / 200n, `${bps} bps`);
  }
});

test("an exact-out request with the fee asks for the least output that still leaves the amount after it", () => {
  for (const net of [1n, 999n, 1_000_000n, 332_001_975_262_684_891n]) {
    const gross = grossForNetOut(net, TEST_BLAST_FEE);
    const left = (g: bigint) => g - (g * 5_000n) / 1_000_000n;
    assert.ok(left(gross) >= net, `${net}`);
    assert.ok(left(gross - 1n) < net, `${net}: the least such gross`);
  }
  assert.equal(grossForNetOut(1_000n, null), 1_000n);
});
