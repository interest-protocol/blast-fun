import { observeMetric } from "@blast/core/lib/metrics.ts";
import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import {
  SOCIAL_TRADE_QUOTE_TTL_MS,
  type SocialTradeImpactUnavailable,
  type SocialTradeNetworkFee,
  type SocialTradeOfferRefusal,
  type SocialTradeQuote,
  type SocialTradeSide,
} from "@blast/core/modules/social/contracts/trades.ts";
import type { TradeRoute, TradeRouteAnswer, TradeRouter, TradeRouteRequest } from "@blast/server/modules/social/trades/aggregator.ts";
import { priceRoute, unavailableQuote } from "@blast/core/modules/social/trades/route-quote.ts";
import { dryRunVerdict, simulationBytes, swapKind, type TradeChain, type TradeDryRun } from "@blast/server/modules/social/trades/chain.ts";
import { readTradeCoins, type TradeCoin } from "@blast/server/modules/social/trades/coins.ts";
import { observeQuoteStage, startQuoteStage } from "@blast/server/modules/social/trades/quote-metrics.ts";
import { sealTradeQuote } from "@blast/server/modules/social/trades/quote-token.ts";
import { impactFromReference, referenceAmountIn, referenceRoute } from "@blast/server/modules/social/trades/reference.ts";

/**
 * The quote service (social feed R3-30): the Cetus aggregator's route for a
 * trade (or, for a coin in an Aftermath DAO-fee pool, `aftermath.ts`'s), its numbers, and — for a signed-in caller whose Blast wallet holds
 * the input — a dry run of exactly that route from the wallet on Sui mainnet,
 * then the sealed `quote_id` R3-31 executes. A quote that is shown but not
 * offered says why (`offer_refused`); a trade with no route says why
 * (`unavailable_reason`) and shows no number.
 *
 * The price impact is the aggregator's (OA-27). Where it has no market price
 * for the pair (a Blast sale coin), a dry-run quote measures it (OA-29): the
 * same route is dry-run a second time at a reference size (`reference.ts`),
 * beside the trade's own dry run, and the impact compares the two fills. That
 * is one more simulation per such quote and nothing more: the caller's quote
 * bucket counts the quote once (`route.ts`).
 */

export type TradeQuoteInput = Readonly<{
  inCoin: string;
  outCoin: string;
  side: SocialTradeSide;
  /** Exactly one of the two. */
  amountIn: bigint | null;
  amountOut: bigint | null;
  slippageBps: number;
}>;

/** Who asks. A signed-out caller has no kind. */
export type TradeQuoteCaller = Readonly<{
  kind: "privy" | "wallet" | null;
  accountId: string | null;
  /** The caller's Blast wallet (embedded Sui wallet, or the session's address); null when it does not exist. */
  wallet: string | null;
}>;

export type TradeQuoteDependencies = Readonly<{
  /** `chain_read_v1` reads (the replica is enough: nothing personal). */
  database: () => ReadableDatabase;
  router: () => TradeRouter;
  chain: () => TradeChain;
  /** The `quote_id` sealing key (`tradeQuoteKey`); throws when the pepper is missing. */
  quoteKey: () => Buffer;
  now?: () => number;
  trackWork?: <T>(promise: Promise<T>) => Promise<T>;
}>;

/** One line per answered quote (never an address or an amount): its outcome, why, its impact and how long the route took. */
function measure(fields: Readonly<Record<string, string | number | boolean | null>>): void {
  observeMetric("social.trade_quote", fields);
}

/**
 * Finds the route: exact-in directly; exact-out as the input the aggregator
 * says buys it, then that input exact-in (the executed swap is always
 * exact-in, so the quote and the swap share one shape).
 */
async function findRoute(router: TradeRouter, input: TradeQuoteInput, aftermath: TradeRouteRequest["aftermath"], signal?: AbortSignal) {
  let amountIn = input.amountIn;
  if (amountIn === null) {
    const exactOut = await router.findRoute({ from: input.inCoin, target: input.outCoin, amount: input.amountOut!, byAmountIn: false, aftermath, signal });
    if (exactOut.status !== "route") return exactOut;
    amountIn = exactOut.route.amountIn;
  }
  return router.findRoute({ from: input.inCoin, target: input.outCoin, amount: amountIn, byAmountIn: true, aftermath, signal });
}

function dryRunOutcome(verdict: TradeDryRun): "ok" | "refused" {
  return verdict.status === "failed" ? "refused" : "ok";
}

/** The answer when the aggregator has no route: `no_pool`, or `pool_unavailable` with the check that failed as its cause. */
function noRoute(input: TradeQuoteInput, answer: Exclude<TradeRouteAnswer, { status: "route" }>, quotedAtMs: number, started: number): SocialTradeQuote {
  const reason = answer.status === "no_route" ? "no_pool" : "pool_unavailable";
  measure({ outcome: "unavailable", reason, cause: answer.status === "unavailable" ? answer.reason : null, routeMs: quotedAtMs - started });
  return unavailableQuote(input, quotedAtMs, reason);
}

/** The pair's Aftermath DAO-fee binding: the sale coin whose sale migrated to one, and its pool. */
function aftermathBinding(...coins: readonly TradeCoin[]): TradeRouteRequest["aftermath"] {
  const coin = coins.find((entry) => entry.aftermathPool !== null);
  return coin ? { coinType: coin.coinType, poolId: coin.aftermathPool! } : null;
}

async function measuredImpact(impact: number | null, route: TradeRoute, reference: TradeRoute | null, referenceRun: Promise<TradeDryRun | null> | null, verdict: Extract<TradeDryRun, { status: "passed" }>) {
  // The impact the dry runs measured (OA-29), when the aggregator gave none: the trade's fill against the reference's.
  let priceImpact: Pick<SocialTradeQuote, "price_impact_bps" | "price_impact_unavailable"> = {
    price_impact_bps: impact,
    price_impact_unavailable: null,
  };
  if (impact === null) {
    let unavailableImpact: SocialTradeImpactUnavailable = "too_small";
    let bps: number | null = null;
    if (reference !== null && referenceRun !== null) {
      const measured = await referenceRun;
      bps = measured?.status === "passed" && measured.received !== null && verdict.received !== null
        ? impactFromReference({ amountIn: route.amountIn, amountOut: verdict.received }, { amountIn: reference.amountIn, amountOut: measured.received })
        : null;
      unavailableImpact = "reference_failed";
    }
    priceImpact = { price_impact_bps: bps, price_impact_unavailable: bps === null ? unavailableImpact : null };
  }

  return priceImpact;
}

/**
 * The input coin's balance and the reference gas price, asked now. Each
 * already has a handler, so a quote that ends before reading them (no route)
 * leaves no unhandled rejection; awaiting one still throws its error.
 */
function startWalletReads(chain: TradeChain, wallet: string, coinType: string, signal?: AbortSignal) {
  const held = chain.balance(wallet, coinType, signal);
  const price = chain.referenceGasPrice(signal);
  held.catch(() => {});
  price.catch(() => {});
  return { held, price };
}

function callerRefusal(caller: TradeQuoteCaller): SocialTradeOfferRefusal | null {
  if (caller.kind === null) return "sign_in";
  if (caller.accountId === null) return "account_required";
  if (caller.wallet === null) return "blast_wallet_missing";
  return null;
}

export async function quoteTrade(
  dependencies: TradeQuoteDependencies,
  input: TradeQuoteInput,
  caller: TradeQuoteCaller,
  signal?: AbortSignal,
): Promise<SocialTradeQuote> {
  const now = dependencies.now ?? Date.now;
  // The router first: a fee that is misconfigured answers `service_unavailable` before anything is read.
  const tradeRouter = dependencies.router();
  const blastFeeBps = tradeRouter.fee?.bps ?? 0;
  const started = now();
  const coins = await observeQuoteStage("coin_read", () => readTradeCoins(dependencies.database(), [input.inCoin, input.outCoin], started));
  const inCoin = coins.get(input.inCoin);
  const outCoin = coins.get(input.outCoin);
  if (!inCoin || !outCoin) {
    measure({ outcome: "unavailable", reason: "not_tradable" });
    return unavailableQuote(input, started, "not_tradable");
  }

  // A caller who may be offered a quote: the wallet's balance and the gas price are read while the route is found.
  const admission = callerRefusal(caller);
  const reader = admission === null ? dependencies.chain() : null;
  const walletReads = reader === null ? null : startWalletReads(reader, caller.wallet!, input.inCoin, signal);
  const answer = await observeQuoteStage("route_discovery", () => findRoute(tradeRouter, input, aftermathBinding(inCoin, outCoin), signal), (answer) =>
    answer.status === "route" ? "ok" : "unavailable");
  const quotedAtMs = now();
  if (answer.status !== "route") return noRoute(input, answer, quotedAtMs, started);
  const { route } = answer;
  const priced = priceRoute(input, route, { in: inCoin, out: outCoin }, quotedAtMs, blastFeeBps);
  const { impact, quote: base } = priced;
  // OA-29: without one, a dry-run quote measures it from the same route at a reference size (null: too small to).
  const referenceIn = impact === null ? referenceAmountIn(route.amountIn, route.amountOut) : null;
  const reference = referenceIn === null ? null : referenceRoute(route, referenceIn, tradeRouter.fee);
  const impactSource = (bps: number | null) => (bps === null ? null : impact === null ? "reference" : "aggregator");
  const refused = (offer: SocialTradeOfferRefusal, extra: Partial<SocialTradeQuote> = {}): SocialTradeQuote => {
    const quote: SocialTradeQuote = { ...base, ...extra, offer_refused: offer };
    measure({
      outcome: "priced",
      refused: offer,
      impactBps: quote.price_impact_bps,
      impactSource: impactSource(quote.price_impact_bps),
      impactUnavailable: quote.price_impact_unavailable,
      hops: route.paths.length,
      routeMs: quotedAtMs - started,
    });
    return quote;
  };

  if (reader === null || walletReads === null) return refused(admission!);
  const chain = reader;

  const networkFee = (estimate: bigint | null): SocialTradeNetworkFee => ({
    payer: "blast",
    label: "Paid by Blast",
    estimate_mist: estimate === null ? null : estimate.toString(),
  });
  const router = tradeRouter;
  const sender = caller.wallet!;

  let verdict: TradeDryRun;
  let referenceRun: Promise<TradeDryRun | null> | null = null;
  const finishFullnode = startQuoteStage("fullnode_main");
  try {
    const held = await walletReads.held;
    if (held < route.amountIn) {
      finishFullnode("refused");
      return refused("insufficient_balance", { network_fee: networkFee(null), balance_failure: { reason: "input", coin_type: input.inCoin, required_atoms: route.amountIn.toString(), available_atoms: held.toString() } });
    }
    const price = await walletReads.price;
    // The swap the wallet would send, from its own coins, simulated with the fullnode's mock gas.
    const dryRun = async (run: TradeRoute, finish?: ReturnType<typeof startQuoteStage>): Promise<TradeDryRun> => {
      try {
        const kind = await swapKind({ router, route: run, sender, inCoin: input.inCoin, slippageBps: input.slippageBps, useGasCoin: false }, chain.client);
        const bytes = simulationBytes({ kind, sender, gasOwner: sender, price });
        const verdict = dryRunVerdict(
          await chain.simulate(bytes, signal),
          { aggregatorPackage: run.aggregatorPackage, sender, outCoin: input.outCoin },
          bytes,
        );
        finish?.(dryRunOutcome(verdict));
        return verdict;
      } catch (error) {
        finish?.("error");
        throw error;
      }
    };
    // OA-29's reference run goes beside the trade's, never in its way: if it cannot run, the impact is null.
    referenceRun = reference === null ? null : (dependencies.trackWork ?? ((promise) => promise))(dryRun(reference, startQuoteStage("fullnode_reference")).catch(() => null));
    verdict = await dryRun(route);
    finishFullnode(dryRunOutcome(verdict));
  } catch {
    finishFullnode("error");
    measure({ outcome: "unavailable", reason: "pool_unavailable", cause: "fullnode", routeMs: quotedAtMs - started });
    return unavailableQuote(input, quotedAtMs, "pool_unavailable");
  }
  if (verdict.status === "failed") {
    measure({ outcome: "unavailable", reason: "dry_run_failed", cause: verdict.failure, routeMs: quotedAtMs - started });
    return unavailableQuote(input, quotedAtMs, "dry_run_failed");
  }

  const priceImpact = await measuredImpact(impact, route, reference, referenceRun, verdict);

  const expiresAtMs = quotedAtMs + SOCIAL_TRADE_QUOTE_TTL_MS;
  const quoteId = sealTradeQuote(dependencies.quoteKey(), {
    accountId: caller.accountId!,
    sender,
    side: input.side,
    inCoin: input.inCoin,
    outCoin: input.outCoin,
    amountIn: route.amountIn,
    amountOut: route.amountOut,
    minOut: priced.minOut,
    slippageBps: input.slippageBps,
    priceImpactBps: priceImpact.price_impact_bps,
    blastFeeBps,
    issuedAtMs: quotedAtMs,
    expiresAtMs,
    route,
  });
  measure({
    outcome: "offered",
    payer: "blast",
    impactBps: priceImpact.price_impact_bps,
    impactSource: impactSource(priceImpact.price_impact_bps),
    impactUnavailable: priceImpact.price_impact_unavailable,
    hops: route.paths.length,
    routeMs: quotedAtMs - started,
    totalMs: now() - started,
  });
  return {
    ...base,
    ...priceImpact,
    quote_id: quoteId,
    expires_at_ms: expiresAtMs,
    network_fee: networkFee(verdict.gasMist),
    dry_run: "passed",
  };
}
