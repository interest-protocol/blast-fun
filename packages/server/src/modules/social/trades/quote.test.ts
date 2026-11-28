import { createAfterResponseScheduler, createRequestWork, runWithRequestWork, trackRequestWork } from "@blast/server/lib/request-work.ts";
import assert from "node:assert/strict";
import test from "node:test";

import { bcs } from "@mysten/sui/bcs";
import { normalizeSuiAddress } from "@mysten/sui/utils";
import type { QueryResult, QueryResultRow } from "pg";

import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import { SOCIAL_TRADE_QUOTE_TTL_MS, type SocialTradeQuote } from "@blast/core/modules/social/contracts/trades.ts";
import type { TradeRouter } from "@blast/server/modules/social/trades/aggregator.ts";
import { routeByVenue } from "@blast/server/modules/social/trades/aftermath.ts";
import { recordedAftermathRouter, YUM, YUM_POOL, YUM_WRAPPER } from "../../../../test/fixtures/modules/social/trades/aftermath-fixtures.ts";
import { minOut } from "@blast/core/modules/social/trades/amounts.ts";
import { fullnodeTradeChain, type TradeSimulationResult } from "@blast/server/modules/social/trades/chain.ts";
import { COIN_METADATA_SQL } from "@blast/server/modules/social/portfolio/coin-metadata.ts";
import { TRADE_SALE_COINS_SQL, TRADE_PRICES_SQL } from "@blast/server/modules/social/trades/coins.ts";
import {
  AGGREGATOR_PACKAGE,
  balanceKey,
  offlineTradeChain,
  recordedData,
  replayDryRuns,
  replayRouter,
  SALE_A,
  SALE_B,
  SALE_B_POOL,
  SENDER,
  simulatedSwap,
  simulationAbort,
  simulationSuccess,
  SUI,
  TEST_BLAST_FEE,
  unreachableRouter,
  USDC,
  type OfflineChainOptions,
} from "../../../../test/fixtures/modules/social/trades/fixtures.ts";
import { quoteTrade, type TradeQuoteCaller, type TradeQuoteInput } from "@blast/server/modules/social/trades/quote.ts";
import { openTradeQuote, tradeQuoteKey } from "@blast/server/modules/social/trades/quote-token.ts";
import { referenceRoute } from "@blast/server/modules/social/trades/reference.ts";

/**
 * The quote service over the aggregator's recorded mainnet
 * answers, an in-memory fullnode and an in-memory `chain_read_v1`. A quote
 * shown is the aggregator's route; a quote offered was dry-run from the
 * caller's own wallet first; a trade without a route shows no number.
 * A sale coin's price impact comes from a second dry run of the same route at
 * a reference size, replayed from real mainnet simulations.
 */

const NOW = 1_791_000_000_000;
const KEY = tradeQuoteKey("trade-quote-fixture-pepper-0123456789abcdef");
const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const SALE_B_PRESALE = "0x00000000000000000000000000000000000000000000000000000000000b0b0b";
const SALE_A_PRESALE = "0x00000000000000000000000000000000000000000000000000000000000a0a0a";
const YUM_PRESALE = "0x00000000000000000000000000000000000000000000000000000000000a1a1a";
const SUI_PRICE = "1.19";
const SALE_B_PRICE = "0.00000000006";

/** `chain_read_v1` as the two quote reads see it: SALE_B and SALE_A trading, SALE_B and SUI priced now. */
function chainReads(options: { migrated?: boolean; stalePrices?: boolean; generic?: boolean } = {}): ReadableDatabase & { statements: string[] } {
  const statements: string[] = [];
  const sales = [
    { presale_id: SALE_B_PRESALE, sale_token: SALE_B, sale_symbol: "BEE", sale_decimals: 9, venue: "cetus", pool_id: SALE_B_POOL },
    { presale_id: SALE_A_PRESALE, sale_token: SALE_A, sale_symbol: "AYE", sale_decimals: 9, venue: "cetus", pool_id: null },
    { presale_id: YUM_PRESALE, sale_token: YUM, sale_symbol: "YUM", sale_decimals: 6, venue: "aftermath", pool_id: YUM_POOL },
  ];
  const asOf = String(options.stalePrices ? NOW - 121_000 : NOW - 5_000);
  const prices = [
    { coin_type: SUI, usd_price: SUI_PRICE, as_of_ms: asOf },
    { coin_type: SALE_B, usd_price: SALE_B_PRICE, as_of_ms: asOf },
  ];
  return {
    statements,
    async read<Row extends QueryResultRow>(text: string, values: readonly unknown[] = []): Promise<QueryResult<Row>> {
      statements.push(text);
      const wanted = new Set(values[0] as string[]);
      const rows =
        text === TRADE_SALE_COINS_SQL
          ? options.migrated === false ? [] : sales.filter((row) => wanted.has(row.sale_token) && !(options.generic && row.sale_token === SALE_B))
          : text === TRADE_PRICES_SQL
            ? prices.filter((row) => wanted.has(row.coin_type))
            : text === COIN_METADATA_SQL ? [{ coin_type: SALE_B, symbol: "DEEP", name: "DeepBook", decimals: 9, icon_url: null, is_presale: !options.generic }].filter((row) => wanted.has(row.coin_type)) : null;
      if (!rows) throw new Error(`unexpected statement ${text}`);
      return { rows: rows as unknown as Row[], rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
    },
  };
}

const anonymous: TradeQuoteCaller = { kind: null, accountId: null, wallet: null };
const embedded: TradeQuoteCaller = { kind: "privy", accountId: ACCOUNT, wallet: SENDER };
const session: TradeQuoteCaller = { kind: "wallet", accountId: ACCOUNT, wallet: SENDER };

const buy = (amountIn: bigint | null, extra: Partial<TradeQuoteInput> = {}): TradeQuoteInput => ({
  inCoin: SUI,
  outCoin: SALE_B,
  side: "buy",
  amountIn,
  amountOut: null,
  slippageBps: 50,
  ...extra,
});

async function run(
  input: TradeQuoteInput,
  caller: TradeQuoteCaller,
  options: { chain?: OfflineChainOptions; router?: TradeRouter; db?: ReturnType<typeof chainReads> } = {},
) {
  const replay = replayRouter();
  const chain = offlineTradeChain(options.chain);
  const db = options.db ?? chainReads();
  const quote = await quoteTrade(
    { database: () => db, router: () => options.router ?? replay.router, chain: () => chain, quoteKey: () => KEY, now: () => NOW },
    input,
    caller,
  );
  return { quote, chain, routeLog: replay.log, db };
}

const funded = (atoms: bigint): OfflineChainOptions => ({ balances: { [balanceKey(SENDER, SUI)]: atoms } });

function assertNoNumbers(quote: SocialTradeQuote) {
  for (const field of ["quote_id", "amount_in", "amount_out", "min_out", "price_impact_bps", "fee_bps", "fee_amount", "route_label", "price_per_out", "amount_in_usd", "amount_out_usd", "network_fee"] as const) {
    assert.equal(quote[field], null, field);
  }
  assert.deepEqual(quote.route, []);
  assert.equal(quote.dry_run, "not_run");
}

test("a signed-out quote is the aggregator's route with its numbers, priced but not offered", async () => {
  const { quote, chain } = await run(buy(100_000_000n), anonymous);
  const recorded = recordedData("sui-sale-b");
  assert.equal(quote.unavailable_reason, null);
  assert.equal(quote.offer_refused, "sign_in");
  assert.equal(quote.quote_id, null);
  assert.equal(quote.dry_run, "not_run");
  assert.equal(quote.network_fee, null);
  assert.equal(quote.amount_in, "100000000");
  assert.equal(quote.amount_out, recorded.amountOut);
  assert.equal(quote.min_out, minOut(BigInt(recorded.amountOut), 50).toString());
  assert.equal(quote.fee_bps, 100, "Cetus's 1% pool");
  assert.equal(quote.fee_amount, "1000000");
  assert.deepEqual(quote.route, [{ pool_id: SALE_B_POOL, venue: "cetus", in_coin: SUI, out_coin: SALE_B, amount_in: "100000000", amount_out: recorded.amountOut }]);
  assert.equal(quote.route_label, "SUI → BEE · Cetus");
  assert.equal(quote.price_per_out, SALE_B_PRICE);
  assert.equal(quote.amount_in_usd, "0.12");
  assert.equal(quote.quoted_at_ms, NOW);
  // The aggregator has no market price for a new sale coin, so it gives no impact, and nothing stands in;
  // A signed-in dry run measures impact; a visitor's quote is not dry-run.
  assert.equal(quote.price_impact_bps, null);
  assert.equal(quote.price_impact_unavailable, "no_dry_run");
  assert.deepEqual(chain.log, [], "nothing touches the fullnode for a visitor");
});

test("a signed-in quote is dry-run from the caller's wallet, then offered as a sealed quote id", async () => {
  const { quote, chain } = await run(buy(100_000_000n), embedded, { chain: { ...funded(10n ** 12n), simulation: replayDryRuns() } });
  assert.equal(quote.dry_run, "passed");
  assert.equal(quote.offer_refused, null);
  assert.equal(quote.expires_at_ms, NOW + SOCIAL_TRADE_QUOTE_TTL_MS);
  // The recorded mainnet dry run's gas: 100,000 + 11,012,400 − 8,547,264 MIST.
  assert.deepEqual(quote.network_fee, { payer: "blast", label: "Paid by Blast", estimate_mist: "2565136" });
  // The trade's dry run and reference run of the same route: two simulations, no execution, ever.
  assert.deepEqual(chain.log.map((entry) => entry.kind), ["balance", "price", "simulate", "simulate"], "no execution, ever");
  assert.equal(quote.price_impact_bps, 8_233);

  const opened = openTradeQuote(KEY, quote.quote_id!)!;
  assert.equal(opened.accountId, ACCOUNT);
  assert.equal(opened.sender, SENDER);
  assert.equal(opened.amountIn, 100_000_000n);
  assert.equal(opened.minOut.toString(), quote.min_out);
  assert.equal(opened.slippageBps, 50);
  assert.equal(opened.priceImpactBps, 8_233, "the impact it showed is sealed with it");
  assert.equal(opened.expiresAtMs, quote.expires_at_ms);
  assert.deepEqual(opened.route.paths.map((path) => path.poolId), [SALE_B_POOL], "the route it pins is the route it showed");
  assert.equal(opened.route.aggregatorPackage, AGGREGATOR_PACKAGE);
});

test("owner 2026-10-08: Blast's 0.5% is in the quote: its rate and atoms, the amounts net of it, and the rate sealed", async () => {
  const fee = replayRouter(undefined, TEST_BLAST_FEE);
  const { quote } = await run(buy(100_000_000n), embedded, { chain: funded(10n ** 12n), router: fee.router });
  const gross = BigInt(recordedData("sui-sale-b").amountOut);
  const atoms = (gross * 5_000n) / 1_000_000n;
  assert.equal(quote.blast_fee_bps, 50);
  assert.equal(quote.blast_fee_amount, atoms.toString(), "in atoms of the coin bought");
  assert.equal(quote.amount_out, (gross - atoms).toString(), "You get is what is left after it");
  assert.equal(quote.min_out, minOut(gross - atoms, 50).toString(), "the minimum is the net output's");
  assert.equal(quote.fee_bps, 100, "the venue's pool fee is its own, unchanged");
  assert.equal(quote.fee_amount, "1000000");
  assert.equal(quote.dry_run, "passed");
  const opened = openTradeQuote(KEY, quote.quote_id!)!;
  assert.deepEqual([opened.blastFeeBps, opened.route.blastFee, opened.amountOut], [50, atoms, gross - atoms]);

  // Without a fee the quote says so: 0, never null, beside the same route's gross output.
  const plain = await run(buy(100_000_000n), anonymous);
  assert.deepEqual([plain.quote.blast_fee_bps, plain.quote.blast_fee_amount, plain.quote.amount_out], [0, "0", gross.toString()]);
  // A quote with no route shows no fee either.
  const none = await run(buy(100_000_000n), anonymous, { router: unreachableRouter });
  assert.deepEqual([none.quote.blast_fee_bps, none.quote.blast_fee_amount], [null, null]);
});

test("the dry run simulates the swap the wallet would send: its sender, no gas payment, nothing signed", async () => {
  let simulated: Uint8Array | null = null;
  await run(buy(100_000_000n), embedded, {
    chain: {
      ...funded(10n ** 12n),
      simulation: (bytes) => {
        simulated = bytes;
        return offlineTradeChain().simulate(bytes) as never;
      },
    },
  });
  const data = bcs.TransactionData.parse(simulated!).V1!;
  assert.equal(normalizeSuiAddress(data.sender), SENDER);
  assert.equal(normalizeSuiAddress(data.gasData.owner!), SENDER);
  assert.deepEqual(data.gasData.payment, []);
  const calls = data.kind.ProgrammableTransaction!.commands.flatMap((command) => (command.MoveCall ? [`${command.MoveCall.module}::${command.MoveCall.function}`] : []));
  assert.deepEqual(calls, ["router::new_swap_context_v3", "cetus::swap", "router::confirm_swap_v3"]);
});

test("the fullnode simulates with its mocked gas, never selecting gas from the wallet's own SUI", async () => {
  // Mainnet refuses a dry run that selects gas when the swap spends the wallet's SUI or the wallet holds none
  // ("Unable to perform gas selection due to insufficient SUI balance"), a sponsored Blast wallet included.
  const asked: Record<string, unknown>[] = [];
  const client = {
    core: {
      simulateTransaction: async (options: Record<string, unknown>) => {
        asked.push(options);
        return simulationSuccess();
      },
    },
  };
  const bytes = new Uint8Array([1, 2, 3]);
  await fullnodeTradeChain(client as never).simulate(bytes);
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.transaction, bytes);
  assert.equal(asked[0]!.doGasSelection, false);
  assert.deepEqual(asked[0]!.include, { effects: true, balanceChanges: true });
});

test("a Slush wallet can quote a swap of its full SUI balance with gas paid by Blast", async () => {
  const { quote } = await run(buy(100_000_000n), session, { chain: funded(100_000_000n) });
  assert.deepEqual(quote.network_fee, { payer: "blast", label: "Paid by Blast", estimate_mist: "1500000" });
  assert.equal(quote.balance_failure, undefined);
  assert.ok(quote.quote_id);
});

test("a wallet short of the input is shown the price and told so, and nothing is simulated", async () => {
  const { quote, chain } = await run(buy(100_000_000n), embedded, { chain: funded(99_999_999n) });
  assert.equal(quote.offer_refused, "insufficient_balance");
  assert.equal(quote.quote_id, null);
  assert.equal(quote.dry_run, "not_run");
  assert.deepEqual(quote.balance_failure, { reason: "input", coin_type: SUI, required_atoms: "100000000", available_atoms: "99999999" });
  assert.equal(quote.amount_out, recordedData("sui-sale-b").amountOut, "the numbers still show");
  assert.equal(quote.price_impact_unavailable, "no_dry_run");
  assert.deepEqual(chain.log.map((entry) => entry.kind), ["balance", "price"], "read beside the route, before it was known short");
});

test("a route that would not execute is not quoted: the dry run's abort is dry_run_failed, with no numbers", async () => {
  const { quote } = await run(buy(100_000_000n), embedded, {
    chain: { ...funded(10n ** 12n), simulation: () => simulationAbort(AGGREGATOR_PACKAGE, "errors", 1) },
  });
  assert.equal(quote.unavailable_reason, "dry_run_failed");
  assertNoNumbers(quote);
});

test("no pool path is no_pool; an unreachable aggregator or fullnode is pool_unavailable; neither shows a number (R3-30-AC-5)", async () => {
  const none = await run(buy(100_000_000n, { outCoin: SALE_A }), anonymous);
  assert.equal(none.quote.unavailable_reason, "no_pool");
  assertNoNumbers(none.quote);

  const router = await run(buy(100_000_000n), anonymous, { router: unreachableRouter });
  assert.equal(router.quote.unavailable_reason, "pool_unavailable");
  assertNoNumbers(router.quote);

  const fullnode = await run(buy(100_000_000n), embedded, { chain: { ...funded(10n ** 12n), down: true } });
  assert.equal(fullnode.quote.unavailable_reason, "pool_unavailable");
  assertNoNumbers(fullnode.quote);
});

test("unknown decimals and unmigrated Blast sales remain not_tradable, and the aggregator is never asked", async () => {
  const unknown = await run(buy(100_000_000n, { outCoin: "0x0000000000000000000000000000000000000000000000000000000000000abc::x::X" }), anonymous);
  assert.equal(unknown.quote.unavailable_reason, "not_tradable");
  assertNoNumbers(unknown.quote);
  assert.deepEqual(unknown.routeLog, []);

  const notMigrated = await run(buy(100_000_000n), anonymous, { db: chainReads({ migrated: false }) });
  assert.equal(notMigrated.quote.unavailable_reason, "not_tradable");
});

test("a held non-Blast coin is offered after a router route and dry run, even with no indexed USD price", async () => {
  // Reuse the recorded route and objects; only the coin's indexed identity is non-Blast in this fixture.
  const db = chainReads({ generic: true, stalePrices: true });
  const amountIn = 100_000_000_000_000_000n;
  const { quote } = await run({ inCoin: SALE_B, outCoin: SUI, side: "sell", amountIn, amountOut: null, slippageBps: 10 }, embedded, {
    db, router: replayRouter(undefined, TEST_BLAST_FEE).router,
    chain: { balances: { [balanceKey(SENDER, SALE_B)]: amountIn, [balanceKey(SENDER, SUI)]: 10n ** 12n } },
  });
  assert.equal(quote.unavailable_reason, null);
  assert.equal(quote.dry_run, "passed");
  assert.ok(quote.quote_id);
  assert.match(quote.route_label!, /DEEP/);
  assert.equal(quote.amount_in_usd, null);
  assert.equal(quote.blast_fee_bps, 50);
  assert.equal(openTradeQuote(KEY, quote.quote_id)?.inCoin, SALE_B);
});

test("Aftermath: a DAO-fee pool's coin is quoted through its pool, never not_tradable, and the aggregator is never asked", async () => {
  const replay = replayRouter(undefined, TEST_BLAST_FEE);
  const router = routeByVenue(replay.router, recordedAftermathRouter(TEST_BLAST_FEE));
  const signedOut = await run(buy(1_000_000_000n, { outCoin: YUM }), anonymous, { router });
  assert.equal(signedOut.quote.unavailable_reason, null);
  const gross = 5_924_377_913_536n;
  const blastFee = (gross * 5_000n) / 1_000_000n;
  assert.equal(signedOut.quote.amount_out, (gross - blastFee).toString(), "net of Blast's 0.5%, as on Cetus");
  assert.equal(signedOut.quote.blast_fee_bps, 50);
  assert.equal(signedOut.quote.blast_fee_amount, blastFee.toString());
  assert.deepEqual(signedOut.quote.route, [{ pool_id: YUM_WRAPPER, venue: "aftermath", in_coin: SUI, out_coin: YUM, amount_in: "1000000000", amount_out: gross.toString() }]);
  assert.equal(signedOut.quote.route_label, "SUI → YUM · Aftermath");
  assert.equal(signedOut.quote.price_impact_unavailable, "no_dry_run", "no aggregator price: OA-29 measures it when dry-run");

  const offered = await run(buy(1_000_000_000n, { outCoin: YUM }), embedded, { router, chain: funded(10n ** 12n) });
  assert.equal(offered.quote.dry_run, "passed");
  assert.deepEqual(offered.chain.log.map((entry) => entry.kind), ["balance", "price", "simulate", "simulate"], "the trade's dry run and OA-29's reference run");
  assert.ok(openTradeQuote(KEY, offered.quote.quote_id!)!.route.paths[0]!.lpType, "the DAO-fee leg's LP type is sealed");
  assert.deepEqual(replay.log, [], "the aggregator is not asked for a DAO-fee coin");
});

test("an exact output is quoted as the exact input that buys it", async () => {
  const { quote, routeLog } = await run(buy(null, { amountOut: 100_000_000_000_000_000n }), anonymous);
  const exactIn = recordedData("sui-sale-b-exact-out-in");
  assert.deepEqual(routeLog.map((entry) => entry.byAmountIn), [false, true]);
  assert.equal(quote.amount_in, exactIn.amountIn);
  assert.equal(quote.amount_out, exactIn.amountOut);
  assert.ok(BigInt(quote.amount_out!) >= 100_000_000_000_000_000n);
});

test("selling the coin back reads the same prices; the impact is the aggregator's alone, with or without our prices", async () => {
  const sell = await run({ inCoin: SALE_B, outCoin: SUI, side: "sell", amountIn: 100_000_000_000_000_000n, amountOut: null, slippageBps: 10 }, anonymous);
  assert.equal(sell.quote.amount_out, recordedData("sale-b-sui").amountOut);
  assert.equal(sell.quote.min_out, minOut(BigInt(recordedData("sale-b-sui").amountOut), 10).toString());
  assert.equal(sell.quote.route_label, "BEE → SUI · Cetus");
  assert.equal(sell.quote.price_per_out, SUI_PRICE);

  const stale = await run(buy(100_000_000n), anonymous, { db: chainReads({ stalePrices: true }) });
  assert.equal(stale.quote.price_per_out, null);
  assert.equal(stale.quote.amount_in_usd, null);
  assert.equal(stale.quote.price_impact_bps, null, "a sale coin has no aggregator market price");

  const usdc = await run({ inCoin: SUI, outCoin: USDC, side: "sell", amountIn: 1_000_000_000n, amountOut: null, slippageBps: 50 }, anonymous, {
    db: chainReads({ stalePrices: true }),
  });
  assert.equal(usdc.quote.route_label, "SUI → USDC · Sui pools");
  assert.equal(usdc.quote.price_per_out, "1");
  assert.equal(usdc.quote.price_impact_bps, 0, "the aggregator's own deviation, whatever R3-20's price (the recorded fill beat its market)");
  assert.equal(usdc.quote.price_impact_unavailable, null);
  assert.equal(usdc.quote.route.length, 8, "a split route lists every leg");
});

test("a caller without an account or a Blast wallet is priced, not offered", async () => {
  const noAccount = (await run(buy(100_000_000n), { kind: "privy", accountId: null, wallet: null })).quote;
  assert.equal(noAccount.offer_refused, "account_required");
  assert.equal(noAccount.price_impact_unavailable, "no_dry_run");
  const noWallet = (await run(buy(100_000_000n), { kind: "privy", accountId: ACCOUNT, wallet: null })).quote;
  assert.equal(noWallet.offer_refused, "blast_wallet_missing");
  assert.equal(noWallet.price_impact_unavailable, "no_dry_run");
});

test("an X wallet can quote a swap of its full SUI balance with gas paid by Blast", async () => {
  const { quote } = await run(buy(100_000_000n), embedded, { chain: funded(100_000_000n) });
  assert.deepEqual(quote.network_fee, { payer: "blast", label: "Paid by Blast", estimate_mist: "1500000" });
  assert.ok(quote.quote_id);
});

/** Every swap the quote dry-ran, by its input, answered from the recorded mainnet dry runs unless `answer` says otherwise. */
function recordingSwaps(answer: (amountIn: bigint) => TradeSimulationResult | "recorded" = () => "recorded") {
  const seen: Uint8Array[] = [];
  const replay = replayDryRuns();
  const simulation = (bytes: Uint8Array) => {
    seen.push(bytes);
    const own = answer(simulatedSwap(bytes).amountIn!);
    return own === "recorded" ? replay(bytes) : own;
  };
  return { seen, simulation };
}

test("OA-29: a sale coin's impact is the same route dry-run again at 1%, the trade's fill against the reference's", async () => {
  const swaps = recordingSwaps();
  const { quote } = await run(buy(100_000_000n), embedded, { chain: { ...funded(10n ** 12n), simulation: swaps.simulation } });
  // One extra simulation, and only one: the trade at 0.1 SUI and the reference at 1% of it, 0.001 SUI.
  assert.equal(swaps.seen.length, 2);
  const runs = swaps.seen.map(simulatedSwap).sort((a, b) => (a.amountIn! > b.amountIn! ? -1 : 1));
  assert.deepEqual(runs.map((swap) => swap.amountIn), [100_000_000n, 1_000_000n]);
  // The same route: the same sender, the same pools in the same order, the same Move calls.
  assert.deepEqual(runs[1]!.legs, runs[0]!.legs);
  assert.ok(runs[0]!.legs[0]!.includes(SALE_B_POOL));
  assert.equal(runs[1]!.sender, runs[0]!.sender);
  const calls = (bytes: Uint8Array) =>
    bcs.TransactionData.parse(bytes).V1!.kind.ProgrammableTransaction!.commands.flatMap((command) => (command.MoveCall ? [`${command.MoveCall.module}::${command.MoveCall.function}`] : []));
  assert.deepEqual(calls(swaps.seen[0]!), calls(swaps.seen[1]!));
  // Mainnet's fills: 332,001,975,262,684,891 and 18,793,099,960,001,698 SALE_B, so 1 − 0.17666… = 8233 bp.
  assert.equal(quote.price_impact_bps, 8_233);
  assert.equal(quote.price_impact_unavailable, null);
  assert.ok(quote.quote_id, "offered as before");
  assert.equal(quote.fee_bps, 100, "the pool's 1% fee is the fee, not part of the impact");

  // Twice the trade on the same pool: a larger impact.
  const double = await run(buy(200_000_000n), embedded, { chain: { ...funded(10n ** 12n), simulation: replayDryRuns() } });
  assert.equal(double.quote.price_impact_bps, 8_990);
});

test("OA-29: a reference run that fails leaves the impact null with its reason, and the quote is still offered", async () => {
  const aborted = recordingSwaps((amountIn) => (amountIn === 1_000_000n ? simulationAbort(SALE_B_POOL, "pool", 7) : "recorded"));
  const abort = await run(buy(100_000_000n), embedded, { chain: { ...funded(10n ** 12n), simulation: aborted.simulation } });
  assert.equal(abort.quote.price_impact_bps, null);
  assert.equal(abort.quote.price_impact_unavailable, "reference_failed");
  assert.equal(abort.quote.dry_run, "passed");
  assert.ok(abort.quote.quote_id);
  assert.equal(openTradeQuote(KEY, abort.quote.quote_id!)!.priceImpactBps, null);

  const down = recordingSwaps((amountIn) => {
    if (amountIn === 1_000_000n) throw new Error("fullnode down for the reference");
    return "recorded";
  });
  const fullnode = await run(buy(100_000_000n), embedded, { chain: { ...funded(10n ** 12n), simulation: down.simulation } });
  assert.equal(fullnode.quote.price_impact_unavailable, "reference_failed");
  assert.ok(fullnode.quote.quote_id, "the reference never stands in the trade's way");

  // And the trade's own dry run failing is the quote's failure, whatever the reference did.
  const tradeAborts = recordingSwaps((amountIn) => (amountIn === 100_000_000n ? simulationAbort(AGGREGATOR_PACKAGE, "errors", 1) : "recorded"));
  const failed = await run(buy(100_000_000n), embedded, { chain: { ...funded(10n ** 12n), simulation: tradeAborts.simulation } });
  assert.equal(failed.quote.unavailable_reason, "dry_run_failed");
  assert.equal(failed.quote.price_impact_unavailable, null, "an unavailable quote says why once");
  assertNoNumbers(failed.quote);
});

test("OA-29: a trade too small to measure above rounding is too_small, with no second simulation", async () => {
  // The recorded route at 0.0005 SUI: its reference floor (100,000 MIST) would be a fifth of it.
  const replay = replayRouter().router;
  const small: TradeRouter = {
    fee: null,
    findRoute: async (request) => {
      const answer = await replay.findRoute({ ...request, amount: 100_000_000n });
      return answer.status === "route" ? { status: "route", route: referenceRoute(answer.route, 500_000n, null)! } : answer;
    },
    appendSwap: replay.appendSwap,
  };
  const swaps = recordingSwaps(() => simulationSuccess());
  const { quote } = await run(buy(500_000n), embedded, { chain: { ...funded(10n ** 12n), simulation: swaps.simulation }, router: small });
  assert.equal(quote.amount_in, "500000");
  assert.equal(swaps.seen.length, 1, "only the trade's own dry run");
  assert.equal(quote.price_impact_bps, null);
  assert.equal(quote.price_impact_unavailable, "too_small");
  assert.ok(quote.quote_id);
});

test("OA-29: where the aggregator has its own impact, no second dry run is simulated", async () => {
  const { quote, chain } = await run({ inCoin: SUI, outCoin: USDC, side: "sell", amountIn: 1_000_000_000n, amountOut: null, slippageBps: 50 }, embedded, {
    chain: funded(10n ** 12n),
  });
  assert.equal(quote.price_impact_bps, 0, "the aggregator's deviation");
  assert.equal(quote.price_impact_unavailable, null);
  assert.equal(chain.log.filter((entry) => entry.kind === "simulate").length, 1);
});

test("failed main quote retains its actual reference simulation until settlement", async () => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const chain = offlineTradeChain(funded(10n ** 12n));
  const owner = createRequestWork(createAfterResponseScheduler());
  let completed = false;
  try {
    const quote = await runWithRequestWork(owner, () => quoteTrade({
      database: () => chainReads(), router: () => replayRouter().router,
      chain: () => ({ ...chain, simulate: async (bytes) => {
        if (simulatedSwap(bytes).amountIn === 100_000_000n) throw new Error("main dry run unavailable");
        await pending;
        return simulationSuccess();
      } }), quoteKey: () => KEY, now: () => NOW, trackWork: trackRequestWork,
    }, buy(100_000_000n), embedded));
    assert.equal(quote.unavailable_reason, "pool_unavailable");
    const finishing = owner.complete().then(() => { completed = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(completed, false);
    release();
    await finishing;
    assert.equal(completed, true);
  } finally { release(); await owner.complete(); }
});

test("large-atom quotes display and seal exact amounts, fee floors and the slippage minimum", async () => {
  const replay = replayRouter().router;
  const recorded = await replay.findRoute({
    from: SUI,
    target: SALE_B,
    amount: 100_000_000n,
    byAmountIn: true,
  });
  assert.ok(recorded.status === "route");
  const amountIn = 9_007_199_254_740_993n;
  const amountOut = 18_446_744_073_709_551_615n;
  const route = {
    ...recorded.route,
    amountIn,
    amountOut,
    deviationRatio: "-0.00015",
    paths: recorded.route.paths.map((path) => ({
      ...path,
      amountIn,
      amountOut,
      feeRate: "0.00005",
    })),
  };
  const router: TradeRouter = {
    ...replay,
    findRoute: async () => ({ status: "route", route }),
  };
  const { quote } = await run(buy(amountIn), embedded, {
    router,
    chain: funded(amountIn + 10_000_000_000n),
  });
  assert.equal(quote.dry_run, "passed");
  assert.equal(quote.offer_refused, null);
  assert.equal(quote.amount_in, "9007199254740993");
  assert.equal(quote.amount_out, "18446744073709551615");
  assert.equal(quote.min_out, "18354510353341003857");
  assert.equal(quote.fee_amount, "450359962737");
  assert.equal(quote.fee_bps, 1);
  assert.equal(quote.price_impact_bps, 1);
  assert.equal(quote.amount_in_usd, "10718567.11");
  assert.equal(quote.amount_out_usd, "1.11");
  assert.equal(quote.price_per_out, "0.00000000006");
  const opened = openTradeQuote(KEY, quote.quote_id!);
  assert.ok(opened);
  assert.equal(opened.amountIn, 9_007_199_254_740_993n);
  assert.equal(opened.amountOut, 18_446_744_073_709_551_615n);
  assert.equal(opened.minOut, 18_354_510_353_341_003_857n);
  assert.equal(opened.route.paths[0]!.amountOut, 18_446_744_073_709_551_615n);
});
