import assert from "node:assert/strict";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import { normalizeStructTag, normalizeSuiAddress } from "@mysten/sui/utils";

import { blastTradeFeeAtoms } from "@blast/core/lib/blast-trade-fee.ts";
import type { TradeRoute, TradeRouter } from "@blast/server/modules/social/trades/aggregator.ts";
import { AFTERMATH_DAO } from "@blast/core/modules/sponsor/aftermath-dao.ts";
import {
  AFTERMATH_DAO_PROVIDER,
  aftermathDaoFeeRate,
  aftermathDaoSwapIn,
  aftermathDaoSwapOut,
  createAftermathDaoRouter,
  isAftermathDaoRoute,
  parseAftermathDaoPool,
  routeByVenue,
} from "@blast/server/modules/social/trades/aftermath.ts";
import {
  AFTERMATH_RECORDING,
  recordedAftermathRouter,
  recordedPool,
  recordedPoolInput,
  recordedPools,
  STUB_CETUS_POOL,
  YUM,
  YUM_BINDING,
  YUM_POOL,
  YUM_WRAPPER,
} from "../../../../test/fixtures/modules/social/trades/aftermath-fixtures.ts";
import { minOut } from "@blast/core/modules/social/trades/amounts.ts";
import { dryRunVerdict, minimumOutFailed, swapKind } from "@blast/server/modules/social/trades/chain.ts";
import { AGGREGATOR_PACKAGE, balanceKey, offlineTradeChain, SENDER, simulationAbort, SUI, TEST_BLAST_FEE, TEST_FEE_RECEIVER, USDC } from "../../../../test/fixtures/modules/social/trades/fixtures.ts";
import { openTradeQuote, sealTradeQuote, tradeQuoteKey } from "@blast/server/modules/social/trades/quote-token.ts";

/**
 * Aftermath DAO-fee pools in the app's trade (contracts ADR 0104): a Blast
 * sale migrated through the Aftermath vendor trades in its pool's wrapper,
 * called directly. The pool is a real mainnet DAO-fee pool, recorded with
 * what the chain gave for nine swaps of it; nothing here reaches the network.
 */

const SLIPPAGE = 50;

async function route(router: TradeRouter, from: string, target: string, amount: bigint, byAmountIn = true): Promise<TradeRoute> {
  const answer = await router.findRoute({ from, target, amount, byAmountIn, aftermath: YUM_BINDING });
  if (answer.status !== "route") assert.fail(`no route: ${JSON.stringify(answer)}`);
  return answer.route;
}

/** The swap the trade path builds for `route`, from the sender's own coins, as commands. */
async function commandsOf(router: TradeRouter, built: TradeRoute, inCoin: string) {
  const chain = offlineTradeChain({ balances: { [balanceKey(SENDER, inCoin)]: built.amountIn * 2n } });
  const kind = bcs.TransactionKind.parse(await swapKind({ router, route: built, sender: SENDER, inCoin, slippageBps: SLIPPAGE, useGasCoin: false }, chain.client));
  const { inputs, commands } = kind.ProgrammableTransaction!;
  const pure = (argument: { $kind: string; Input?: number } | undefined) => {
    const bytes = argument?.$kind === "Input" ? inputs[argument.Input!]?.Pure?.bytes : undefined;
    return bytes === undefined ? undefined : bcs.u64().fromBase64(bytes);
  };
  const address = (argument: { $kind: string; Input?: number } | undefined) => {
    const bytes = argument?.$kind === "Input" ? inputs[argument.Input!]?.Pure?.bytes : undefined;
    return bytes === undefined ? undefined : normalizeSuiAddress(bcs.Address.fromBase64(bytes));
  };
  const u32 = (argument: { $kind: string; Input?: number } | undefined) => {
    const bytes = argument?.$kind === "Input" ? inputs[argument.Input!]?.Pure?.bytes : undefined;
    return bytes === undefined ? undefined : bcs.u32().fromBase64(bytes);
  };
  const shared = (argument: { $kind: string; Input?: number } | undefined) =>
    argument?.$kind === "Input" ? inputs[argument.Input!]?.Object?.SharedObject?.objectId : undefined;
  return { commands, pure, u32, address, shared, names: commands.map((command) => (command.$kind === "MoveCall" ? `${command.MoveCall.module}::${command.MoveCall.function}` : command.$kind)) };
}

test("the recorded pool parses: its wrapper, LP type, coins, DAO fee and the protocol fee's shares", () => {
  const pool = recordedPool();
  assert.equal(pool.poolId, YUM_POOL);
  assert.equal(pool.wrapperId, YUM_WRAPPER);
  assert.equal(pool.lpType, normalizeStructTag("0x0d1e4021d2141a891d20250ed3aa90b118648aa1cbdda16d5533e820736c6b1b::af_lp::AF_LP"));
  assert.deepEqual(pool.coins, [SUI, YUM]);
  assert.equal(pool.daoFeeBps, 300);
  assert.equal(pool.protocolFee, 500_000_000_000_000n, "0.05% of what the DAO fee leaves");
  assert.equal(pool.protocolFeeShares.reduce((sum, share) => sum + share, 0n), 10n ** 18n);
});

test("the quote is what the chain gave, to the atom, for every recorded swap in both directions", () => {
  const pool = recordedPool();
  assert.equal(AFTERMATH_RECORDING.swaps.length, 9);
  for (const swap of AFTERMATH_RECORDING.swaps) {
    assert.equal(aftermathDaoSwapOut(pool, swap.from, BigInt(swap.amount_in)).toString(), swap.amount_out, `${swap.from} ${swap.amount_in}`);
  }
  assert.equal(aftermathDaoSwapOut(pool, 0, 0n), 0n);
});

test("the inverse is the least input that buys the amount", () => {
  const pool = recordedPool();
  for (const [from, out] of [[0, 1_000_000_000_000n], [0, 7n], [1, 300_000_000n], [1, 1n]] as const) {
    const input = aftermathDaoSwapIn(pool, from, out)!;
    assert.ok(aftermathDaoSwapOut(pool, from, input) >= out, `${from} ${out}`);
    assert.ok(aftermathDaoSwapOut(pool, from, input - 1n) < out, `${from} ${out} is the least`);
  }
  assert.equal(aftermathDaoSwapIn(pool, 0, pool.normalizedBalances[1] / pool.scalars[1]), null, "never the whole pool");
});

test("a leg's fee rate compounds the DAO, protocol and swap fees", () => {
  // 1 − (1 − 0.03)(1 − 0.0005)(1 − 0.0001): the pool's swap-in fee is 0.01%, its swap-out fee 0.
  assert.equal(aftermathDaoFeeRate(recordedPool(), 0), "0.033393545");
});

test("a pool this route cannot quote is refused: another wrapper type, another pool's wrapper, another vault", () => {
  assert.ok(parseAftermathDaoPool(recordedPoolInput()));
  assert.equal(parseAftermathDaoPool(recordedPoolInput({ wrapperType: AFTERMATH_RECORDING.wrapper.type.replace(AFTERMATH_DAO.typeOrigin.slice(2), "1".repeat(64)) })), null);
  assert.equal(parseAftermathDaoPool(recordedPoolInput({ poolType: AFTERMATH_RECORDING.pool.type.replace("af_lp::AF_LP", "af_lp::OTHER") })), null, "the LP types differ");
  assert.equal(parseAftermathDaoPool(recordedPoolInput({ poolId: normalizeSuiAddress("0xabc") })), null, "the wrapper holds another pool");
  assert.equal(parseAftermathDaoPool(recordedPoolInput({ vaultType: "0x2::coin::Coin<0x2::sui::SUI>" })), null);
});

test("route selection: a request with an Aftermath binding goes to the DAO-fee router, any other to Cetus; each builds its own routes", async () => {
  const asked: string[] = [];
  const cetus: TradeRouter = {
    fee: TEST_BLAST_FEE,
    findRoute: async () => (asked.push("cetus"), { status: "no_route" }),
    appendSwap: async () => (asked.push("cetus-build"), { $kind: "Result", Result: 0 } as never),
  };
  const aftermath = recordedAftermathRouter(TEST_BLAST_FEE);
  const router = routeByVenue(cetus, aftermath);
  assert.equal(router.fee, TEST_BLAST_FEE);
  assert.equal((await router.findRoute({ from: SUI, target: USDC, amount: 1n, byAmountIn: true })).status, "no_route");
  assert.deepEqual(asked, ["cetus"]);
  const built = await route(router, SUI, YUM, 1_000_000_000n);
  assert.ok(isAftermathDaoRoute(built));
  assert.deepEqual(asked, ["cetus"], "the aggregator is not asked for a DAO-fee coin");
  assert.throws(() => routeByVenue(cetus, recordedAftermathRouter(null)), /same Blast fee/);
  assert.throws(() => createAftermathDaoRouter({ pools: recordedPools(), base: cetus, fee: TEST_BLAST_FEE }), /charge no fee/);
});

test("buying with the pool's own quote coin is one DAO-fee leg, Blast's fee taken from its output as the aggregator would", async () => {
  const router = recordedAftermathRouter(TEST_BLAST_FEE);
  const built = await route(router, SUI, YUM, 1_000_000_000n);
  const gross = 5_924_377_913_536n; // the chain's own fill of 1 SUI (fixture)
  assert.equal(built.amountIn, 1_000_000_000n);
  assert.equal(built.blastFee, blastTradeFeeAtoms(gross, TEST_BLAST_FEE));
  assert.equal(built.amountOut, gross - built.blastFee);
  assert.equal(built.paths.length, 1);
  const [leg] = built.paths;
  assert.deepEqual(
    { ...leg },
    { poolId: YUM_WRAPPER, provider: AFTERMATH_DAO_PROVIDER, direction: true, from: SUI, target: YUM, feeRate: "0.033393545", amountIn: 1_000_000_000n, amountOut: gross, publishedAt: AFTERMATH_DAO.package, lpType: recordedPool().lpType },
  );
  assert.equal(built.aggregatorPackage, AFTERMATH_DAO.package);
  assert.equal(built.deviationRatio, null, "no market price: the impact is measured by the reference dry run (OA-29)");
  assert.deepEqual(router.base.log, [], "no Cetus leg");
});

test("PTB shape: the coin, the pinned DAO-fee swap expecting the minimum plus the fee, Blast's fee to its receiver, the rest to the sender", async () => {
  const router = recordedAftermathRouter(TEST_BLAST_FEE);
  const built = await route(router, SUI, YUM, 1_000_000_000n);
  const { commands, names, pure, address, shared } = await commandsOf(router, built, SUI);
  assert.deepEqual(names, ["SplitCoins", "swap::swap_exact_in", "SplitCoins", "TransferObjects", "TransferObjects"]);
  const call = commands[1]!.MoveCall!;
  assert.equal(normalizeSuiAddress(call.package), AFTERMATH_DAO.package);
  assert.deepEqual(call.typeArguments.map((type) => normalizeStructTag(type)), [recordedPool().lpType, SUI, YUM]);
  assert.deepEqual(
    call.arguments.slice(0, 7).map((argument) => normalizeSuiAddress(shared(argument)!)),
    [YUM_WRAPPER, AFTERMATH_DAO.version, AFTERMATH_DAO.registry, AFTERMATH_DAO.vault, AFTERMATH_DAO.treasury, AFTERMATH_DAO.insuranceFund, AFTERMATH_DAO.referralVault],
  );
  assert.deepEqual(call.arguments[7], { $kind: "NestedResult", NestedResult: [0, 0] }, "the sender's own coin");
  assert.equal(pure(call.arguments[8]), (minOut(built.amountOut, SLIPPAGE) + built.blastFee).toString(), "expected out: what the user is promised, before Blast's fee");
  assert.equal(pure(call.arguments[9]), "0", "no slippage of the AMM's own");
  const split = commands[2]!.SplitCoins!;
  assert.deepEqual(split.coin, { $kind: "Result", Result: 1 });
  assert.equal(pure(split.amounts[0]), built.blastFee.toString());
  assert.equal(address(commands[3]!.TransferObjects!.address), TEST_FEE_RECEIVER);
  assert.equal(address(commands[4]!.TransferObjects!.address), normalizeSuiAddress(SENDER));

  // With no fee configured, nothing is split off.
  const plain = recordedAftermathRouter(null);
  const free = await route(plain, SUI, YUM, 1_000_000_000n);
  assert.equal(free.blastFee, 0n);
  assert.deepEqual((await commandsOf(plain, free, SUI)).names, ["SplitCoins", "swap::swap_exact_in", "TransferObjects"]);
});

test("selling for the pool's quote coin takes the fee in it", async () => {
  const router = recordedAftermathRouter(TEST_BLAST_FEE);
  const built = await route(router, YUM, SUI, 2_000_000_000_000n);
  assert.equal(built.amountOut + built.blastFee, 303_071_360n, "the chain's fill (fixture)");
  assert.equal(built.paths[0]!.direction, false);
  assert.deepEqual((await commandsOf(router, built, YUM)).names, ["SplitCoins", "swap::swap_exact_in", "SplitCoins", "TransferObjects", "TransferObjects"]);
});

test("USDC on a SUI pool: a fee-less Cetus leg before a buy, after a sell; the minimum is held by the route's last swap", async () => {
  const router = recordedAftermathRouter(TEST_BLAST_FEE);
  const buy = await route(router, USDC, YUM, 3_000_000n);
  assert.deepEqual(buy.paths.map((path) => path.provider), ["CETUS", AFTERMATH_DAO_PROVIDER]);
  assert.equal(buy.paths[1]!.amountIn, buy.paths[0]!.amountOut);
  assert.equal(buy.aggregatorPackage, AGGREGATOR_PACKAGE, "the Cetus leg's aggregator, for its slippage abort");
  assert.equal(buy.requestId, "stub-quote");
  const bought = await commandsOf(router, buy, USDC);
  assert.deepEqual(bought.names, ["SplitCoins", "router::new_swap_context_v3", "cetus::swap", "router::confirm_swap_v3", "swap::swap_exact_in", "SplitCoins", "TransferObjects", "TransferObjects"]);
  const context = bought.commands[1]!.MoveCall!;
  assert.equal(bought.u32(context.arguments[6]), 0, "the context charges no fee: the DAO route takes Blast's");
  assert.equal(bought.address(context.arguments[7]), normalizeSuiAddress("0x0"), "the context's fee recipient is 0x0");
  assert.equal(bought.pure(context.arguments[3]), "992512500", "the Cetus leg checks its own minimum");
  assert.equal(bought.pure(context.arguments[4]), "0", "the minimum cannot be discounted again");
  assert.equal(bought.pure(bought.commands[4]!.MoveCall!.arguments[8]), (minOut(buy.amountOut, SLIPPAGE) + buy.blastFee).toString());

  const sell = await route(router, YUM, USDC, 2_000_000_000_000n);
  assert.deepEqual(sell.paths.map((path) => path.provider), [AFTERMATH_DAO_PROVIDER, "CETUS"]);
  assert.equal(sell.paths[1]!.poolId, STUB_CETUS_POOL);
  const sold = await commandsOf(router, sell, YUM);
  assert.deepEqual(sold.names, ["SplitCoins", "swap::swap_exact_in", "router::new_swap_context_v3", "cetus::swap", "router::confirm_swap_v3", "SplitCoins", "TransferObjects", "SplitCoins", "MergeCoins", "TransferObjects"]);
  assert.equal(sold.pure(sold.commands[1]!.MoveCall!.arguments[8]), minOut(sell.paths[0]!.amountOut, SLIPPAGE).toString(), "the DAO-fee leg feeding Cetus keeps the slippage on its own output");
  const suffix = sold.commands[2]!.MoveCall!;
  assert.equal(sold.pure(suffix.arguments[3]), (minOut(sell.amountOut, SLIPPAGE) + sell.blastFee).toString(), "the suffix expects the minimum plus the fee …");
  assert.equal(sold.pure(suffix.arguments[4]), "0", "… with no slippage");
  assert.deepEqual(sold.commands[5]!.SplitCoins!.coin, { $kind: "Result", Result: 4 }, "the fee is split from confirm_swap_v3's output");
});

test("a smaller Aftermath fill cannot lower the absolute net payout minimum in the Cetus suffix", async () => {
  const router = recordedAftermathRouter(TEST_BLAST_FEE);
  const sell = await route(router, YUM, USDC, 2_000_000_000_000n);
  const { commands, pure } = await commandsOf(router, { ...sell, amountOut: 200n, blastFee: 1n }, YUM);
  const [split, merge, transfer] = commands.slice(-3);
  const payout = { $kind: "Result", Result: 4 };
  assert.deepEqual(split?.SplitCoins?.coin, payout);
  assert.equal(pure(split?.SplitCoins?.amounts[0]), "199", "198 atoms cannot cover the split");
  assert.deepEqual(merge?.MergeCoins?.destination, payout);
  assert.deepEqual(merge?.MergeCoins?.sources, [{ $kind: "NestedResult", NestedResult: [7, 0] }]);
  assert.deepEqual(transfer?.TransferObjects?.objects, [payout], "the whole net payout goes to the user");

  const error = { $kind: "Unknown", Unknown: null, message: "Insufficient coin balance for operation." } as const;
  assert.equal(minimumOutFailed({ ...error, command: 7 }, () => commands), true);
  assert.equal(minimumOutFailed({ ...error, command: 0 }, () => commands), false, "an input split can still fail for insufficient balance");
});

test("exact out: the least input whose net output after Blast's fee is at least the amount", async () => {
  const router = recordedAftermathRouter(TEST_BLAST_FEE);
  const wanted = 1_000_000_000_000n;
  const exactOut = await route(router, SUI, YUM, wanted, false);
  assert.ok(exactOut.amountOut >= wanted);
  const less = await route(router, SUI, YUM, exactOut.amountIn - 1n);
  assert.ok(less.amountOut < wanted, "one atom less does not buy it");
  const viaUsdc = await route(router, USDC, YUM, wanted, false);
  assert.ok(viaUsdc.amountOut >= wanted);
  const sell = await route(router, YUM, USDC, 300_000n, false);
  assert.ok(sell.amountOut >= 300_000n);
});

test("no route, never a guess: an unbound pair, the pool unreadable or not a DAO-fee pool, a coin not in it, a pair without a base coin", async () => {
  const router = recordedAftermathRouter(TEST_BLAST_FEE);
  assert.deepEqual(await router.findRoute({ from: SUI, target: YUM, amount: 1n, byAmountIn: true }), { status: "no_route" });
  const down = recordedAftermathRouter(TEST_BLAST_FEE, recordedPools({ down: true }));
  assert.deepEqual(await down.findRoute({ from: SUI, target: YUM, amount: 1n, byAmountIn: true, aftermath: YUM_BINDING }), { status: "unavailable", reason: "aftermath_pool_read" });
  assert.deepEqual(
    await router.findRoute({ from: SUI, target: YUM, amount: 1n, byAmountIn: true, aftermath: { coinType: YUM, poolId: normalizeSuiAddress("0xbad") } }),
    { status: "unavailable", reason: "aftermath_pool_unsupported" },
  );
  assert.deepEqual(
    await router.findRoute({ from: SUI, target: USDC, amount: 1n, byAmountIn: true, aftermath: { coinType: USDC, poolId: YUM_POOL } }),
    { status: "unavailable", reason: "aftermath_pool_coin" },
  );
  const other = normalizeStructTag("0x5::other::OTHER");
  assert.deepEqual(await router.findRoute({ from: other, target: YUM, amount: 1_000n, byAmountIn: true, aftermath: YUM_BINDING }), { status: "no_route" });
  assert.deepEqual(await router.findRoute({ from: SUI, target: YUM, amount: 10n ** 19n, byAmountIn: false, aftermath: YUM_BINDING }), { status: "no_route" }, "more than the pool holds");
});

test("a route priced at another fee, or with no single pinned DAO-fee leg, is never built", async () => {
  const router = recordedAftermathRouter(TEST_BLAST_FEE);
  const built = await route(router, SUI, YUM, 1_000_000_000n);
  const chain = offlineTradeChain({ balances: { [balanceKey(SENDER, SUI)]: 10n ** 10n } });
  const build = (changed: TradeRoute) => swapKind({ router, route: changed, sender: SENDER, inCoin: SUI, slippageBps: SLIPPAGE, useGasCoin: false }, chain.client);
  await assert.rejects(build({ ...built, blastFee: 0n }), /another Blast fee/);
  await assert.rejects(build({ ...built, paths: [{ ...built.paths[0]!, publishedAt: normalizeSuiAddress("0x99") }] }), /pinned swap/);
  await assert.rejects(build({ ...built, paths: [{ ...built.paths[0]!, lpType: undefined }] }), /pinned swap/);
  await assert.rejects(build({ ...built, paths: [built.paths[0]!, built.paths[0]!] }), /exactly one DAO-fee leg/);
});

test("the dry run reads the AMM's slippage abort as slippage, wherever the route's aggregator is", () => {
  const context = { aggregatorPackage: AFTERMATH_DAO.package, sender: SENDER, outCoin: YUM };
  assert.equal(dryRunVerdict(simulationAbort(AFTERMATH_DAO.ammPackage, "swap", 48), context).status, "failed");
  assert.deepEqual(dryRunVerdict(simulationAbort(AFTERMATH_DAO.ammPackage, "swap", 48), context), { status: "failed", failure: "slippage", gasMist: 1_000_000n });
  assert.equal((dryRunVerdict(simulationAbort(AFTERMATH_DAO.ammPackage, "swap", 47), context) as { failure: string }).failure, "abort");
  assert.equal((dryRunVerdict(simulationAbort(normalizeSuiAddress("0x77"), "swap", 48), context) as { failure: string }).failure, "abort");
  assert.equal((dryRunVerdict(simulationAbort(AFTERMATH_DAO.ammPackage, "swap", 48), { ...context, aggregatorPackage: AGGREGATOR_PACKAGE }) as { failure: string }).failure, "slippage");
});

test("a quote id carries the DAO-fee leg's LP type, and a quote sealed with nine-field legs still opens", async () => {
  const key = tradeQuoteKey("p".repeat(32));
  const built = await route(recordedAftermathRouter(TEST_BLAST_FEE), USDC, YUM, 3_000_000n);
  const quote = {
    accountId: "acct",
    sender: SENDER,
    side: "buy" as const,
    inCoin: USDC,
    outCoin: YUM,
    amountIn: built.amountIn,
    amountOut: built.amountOut,
    minOut: minOut(built.amountOut, SLIPPAGE),
    slippageBps: SLIPPAGE,
    priceImpactBps: 12,
    blastFeeBps: 50,
    issuedAtMs: 1,
    expiresAtMs: 2,
    route: built,
  };
  const opened = openTradeQuote(key, sealTradeQuote(key, quote));
  assert.deepEqual(opened?.route.paths.map((path) => path.lpType), [undefined, recordedPool().lpType]);
  assert.deepEqual(opened, { ...quote, route: { ...built, paths: [{ ...built.paths[0]! }, built.paths[1]] } });
  assert.equal("lpType" in opened!.route.paths[0]!, false, "an aggregator leg has none");
});
