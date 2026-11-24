import { blastTradeFeeAtoms, type BlastTradeFee } from "@blast/core/lib/blast-trade-fee.ts";
import type { TradeRoute } from "@blast/server/modules/social/trades/aggregator.ts";
import { fractionBps } from "@blast/core/modules/social/trades/amounts.ts";

/**
 * Price impact from a second dry run (OA-29). The Cetus aggregator
 * has no market price for a new Blast sale coin, so its route carries no
 * `deviation_ratio` and impact would be null exactly where trading
 * happens. A signed-in quote is dry-run from the caller's wallet anyway; this
 * module sizes a second dry run of the **same route** — the same pools, in the
 * same order, split the same way — at a small reference size, and turns the
 * two fills into the impact. SDK-only (OA-27): two fullnode simulations of
 * the aggregator's own route; no indexer price, no reserves, no `poolDepth()`.
 *
 * Owner choices: docs/product/social-feed/COORDINATION.md (OA-27, OA-29).
 *
 * Amounts stay in `bigint` atoms and rates in fractions through both fills.
 */

/** The reference is 1% of the trade's input … */
export const REFERENCE_SHARE_DIVISOR = 100n;
/**
 * … but at least this many atoms in, and enough in to expect this many out
 * at the trade's own rate, so it stays above rounding: a venue rounds each
 * step's fee up and its output down by an atom, which moves a rate of
 * 100,000 atoms by 0.1 bp.
 */
export const REFERENCE_MIN_ATOMS = 100_000n;
/** … and at most a tenth of the trade: a larger reference is not small next to it, and the trade is too small to measure. */
export const REFERENCE_MAX_SHARE_DIVISOR = 10n;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/**
 * The reference run's input for a route that takes `amountIn` and gives
 * `amountOut`: `max(⌈in ÷ 100⌉, 100,000, ⌈100,000 × in ÷ out⌉)` atoms, or
 * null when that is more than a tenth of `amountIn` (`too_small`).
 */
export function referenceAmountIn(amountIn: bigint, amountOut: bigint): bigint | null {
  if (amountIn <= 0n || amountOut <= 0n) return null;
  let size = ceilDiv(amountIn, REFERENCE_SHARE_DIVISOR);
  if (size < REFERENCE_MIN_ATOMS) size = REFERENCE_MIN_ATOMS;
  const forOutput = ceilDiv(REFERENCE_MIN_ATOMS * amountIn, amountOut);
  if (size < forOutput) size = forOutput;
  return size * REFERENCE_MAX_SHARE_DIVISOR > amountIn ? null : size;
}

/**
 * The route at `amountIn`: the same legs in the same order, each leg's
 * amounts scaled by `amountIn ÷ route.amountIn` (rounded down), so a split
 * stays the same split. The swap builder hands every coin's last leg all that
 * is left of it, so the scaled amounts only steer the legs before it. The
 * total out is the trade's rate at the reference size; the swap's own
 * minimum is that less the quote's slippage, which a smaller swap through the
 * same pools clears whenever the trade's own dry run does. Blast's fee
 * (`fee`, the router's) is taken from the scaled gross output as the
 * aggregator takes it, so both runs pay the same share. Null when a leg
 * would be left empty (`too_small`).
 */
export function referenceRoute(route: TradeRoute, amountIn: bigint, fee: BlastTradeFee | null): TradeRoute | null {
  if (amountIn <= 0n || amountIn >= route.amountIn) return null;
  const scale = (atoms: bigint) => (atoms * amountIn) / route.amountIn;
  const paths = route.paths.map((path) => ({ ...path, amountIn: scale(path.amountIn), amountOut: scale(path.amountOut) }));
  const gross = scale(route.amountOut + route.blastFee);
  const blastFee = blastTradeFeeAtoms(gross, fee);
  const amountOut = gross - blastFee;
  if (amountOut <= 0n || paths.some((path) => path.amountIn === 0n || path.amountOut === 0n)) return null;
  return { ...route, amountIn, amountOut, blastFee, paths };
}

/** What one dry run put in and got out, in atoms. */
export type DryRunFill = Readonly<{ amountIn: bigint; amountOut: bigint }>;

/**
 * The impact in basis points: how much lower the trade's effective rate is
 * than the reference's, `1 − (out ÷ in) ÷ (out_ref ÷ in_ref)`, computed as
 * `(out_ref × in − out × in_ref) ÷ (out_ref × in)` and rounded half up.
 *
 * Net of the route's fees: both rates are what the same pools paid after
 * their fees, and a venue's fee is the same share of a leg's input at any
 * size, so the share cancels in the ratio and only the price's movement
 * remains — a route whose only cost is its fees has an impact of 0, not its
 * fee. A trade no worse than the reference (a favourable fill, or rounding at
 * the reference) is 0; the most is 10000. Null when either run put in or got
 * out nothing (`reference_failed`: there is no rate to compare).
 */
export function impactFromReference(trade: DryRunFill, reference: DryRunFill): number | null {
  if (trade.amountIn <= 0n || trade.amountOut <= 0n || reference.amountIn <= 0n || reference.amountOut <= 0n) return null;
  const d = reference.amountOut * trade.amountIn;
  const n = d - trade.amountOut * reference.amountIn;
  if (n <= 0n) return 0;
  const bps = fractionBps({ n, d });
  return bps > 10_000 ? 10_000 : bps;
}
