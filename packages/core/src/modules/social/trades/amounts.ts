import { SOCIAL_TRADE_BASE_COINS } from "@blast/core/modules/social/contracts/trades.ts";
import { knownVenueName } from "@blast/core/lib/format.ts";
import { isSlippageBps, minimumOut } from "@blast/core/lib/bps.ts";

/**
 * Preserve exact atoms and fractional rates even above Number.MAX_SAFE_INTEGER.
 * R3-30-AC-7: docs/product/social-feed/tickets/R3-30.md.
 */

/** A non-negative or negative fraction `n / d` with `d > 0`. */
export type Fraction = Readonly<{ n: bigint; d: bigint }>;

const DECIMAL = /^(-?)(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/** A plain decimal string (`"0.0001"`, `"-0.00061442"`, `"1"`) as an exact fraction; null for anything else. */
export function parseDecimal(text: string): Fraction | null {
  const match = DECIMAL.exec(text.trim());
  if (!match) return null;
  const fraction = match[3] ?? "";
  if (fraction.length > 36) return null;
  const n = BigInt(`${match[2]}${fraction}`);
  return { n: match[1] === "-" ? -n : n, d: 10n ** BigInt(fraction.length) };
}

const ONE: Fraction = { n: 1n, d: 1n };
const mul = (a: Fraction, b: Fraction): Fraction => ({ n: a.n * b.n, d: a.d * b.d });
const div = (a: Fraction, b: Fraction): Fraction => (b.n < 0n ? { n: -a.n * b.d, d: a.d * -b.n } : { n: a.n * b.d, d: a.d * b.n });
const add = (a: Fraction, b: Fraction): Fraction => ({ n: a.n * b.d + b.n * a.d, d: a.d * b.d });
const sub = (a: Fraction, b: Fraction): Fraction => ({ n: a.n * b.d - b.n * a.d, d: a.d * b.d });
const whole = (value: bigint): Fraction => ({ n: value, d: 1n });

/** `value × 10000`, rounded half up, as basis points. */
function toBps(value: Fraction): number {
  const scaled = value.n * 10_000n;
  const rounded = scaled >= 0n ? (scaled * 2n + value.d) / (value.d * 2n) : -((-scaled * 2n + value.d) / (value.d * 2n));
  return Number(rounded);
}

/** The swap's floor: `amountOut × (1 − slippageBps / 10000)`, rounded up (R3-30-AC-4). */
export function minOut(amountOut: bigint, slippageBps: number): bigint {
  if (!Number.isSafeInteger(slippageBps) || !isSlippageBps(BigInt(slippageBps))) throw new RangeError("slippage out of range");
  return minimumOut(amountOut, BigInt(slippageBps));
}

/** One leg of a route as the arithmetic needs it. */
export type RouteLeg = Readonly<{
  from: string;
  target: string;
  /** The venue's fee on this leg, a decimal fraction of its input (`"0.0025"`). */
  feeRate: string;
  amountIn: bigint;
  amountOut: bigint;
}>;

/**
 * The share of the trade the venues' fees take, as an exact fraction. Each
 * coin's flow is followed in the route's order (the order the swap executes):
 * what arrives at a coin, and what would have arrived with no fee on any leg
 * before it. A leg's fee-free output is its output ÷ (1 − fee), scaled by its
 * input coin's fee-free share. The answer is `1 − actual ÷ fee-free` at the
 * target, so split routes and hops in series both count. Null for a leg whose
 * fee is not a decimal in [0, 1), or a route that does not reach `target`.
 */
export function routeFeeFraction(legs: readonly RouteLeg[], source: string, amountIn: bigint, target: string): Fraction | null {
  const actual = new Map<string, bigint>([[source, amountIn]]);
  const feeFree = new Map<string, Fraction>([[source, whole(amountIn)]]);
  for (const leg of legs) {
    const fee = parseDecimal(leg.feeRate);
    if (!fee || fee.n < 0n || fee.n >= fee.d) return null;
    const arrived = actual.get(leg.from);
    const arrivedFree = feeFree.get(leg.from);
    if (arrived === undefined || arrivedFree === undefined || arrived <= 0n) return null;
    const share = div(arrivedFree, whole(arrived));
    const legFree = mul(div(whole(leg.amountOut), sub(ONE, fee)), share);
    actual.set(leg.target, (actual.get(leg.target) ?? 0n) + leg.amountOut);
    feeFree.set(leg.target, add(feeFree.get(leg.target) ?? whole(0n), legFree));
  }
  const out = actual.get(target);
  const outFree = feeFree.get(target);
  if (out === undefined || outFree === undefined || outFree.n <= 0n) return null;
  return sub(ONE, div(whole(out), outFree));
}

/** A fraction as whole basis points, rounded half up. */
export function fractionBps(value: Fraction): number {
  return toBps(value);
}

/** `amount × value`, rounded down (a fee in atoms). */
export function scaleAtoms(amount: bigint, value: Fraction): bigint {
  const scaled = (amount * value.n) / value.d;
  return scaled < 0n ? 0n : scaled;
}

/**
 * Price impact in basis points, never negative, from the Cetus aggregator's
 * own route data: its `deviation_ratio` is the fill against its
 * market price, `R − 1`, with the venues' fees in it; the fees alone would
 * leave `1 − fee`, so the impact of the trade's size is `1 − R ÷ (1 − fee)`.
 * Null when the aggregator has no market price for the pair (an empty
 * ratio, as for every new Blast sale coin) or sends a malformed one.
 */
export function impactFromDeviation(deviation: string | null, fee: Fraction): number | null {
  if (deviation === null || deviation.trim() === "") return null;
  const parsed = parseDecimal(deviation);
  if (!parsed) return null;
  return impactOfRatio(add(ONE, parsed), fee);
}

function impactOfRatio(ratio: Fraction, fee: Fraction): number | null {
  const kept = sub(ONE, fee);
  if (kept.n <= 0n || ratio.n < 0n) return null;
  const impact = sub(ONE, div(ratio, kept));
  return impact.n <= 0n ? 0 : toBps(impact);
}

/** The venue a route leg's provider trades on, lowercase (`CETUS` and `CETUSDLMM` are both Cetus; an `AFTERMATH_DAO` leg is Aftermath). */
export function venueOf(provider: string): string {
  const upper = provider.toUpperCase();
  if (upper === "CETUS" || upper === "CETUSDLMM") return "cetus";
  if (upper === "BLUEFIN") return "bluefin";
  if (upper === "AFTERMATH" || upper === "AFTERMATH_DAO") return "aftermath";
  return provider.toLowerCase();
}

const isBaseCoin = (coin: string) => coin === SOCIAL_TRADE_BASE_COINS.sui || coin === SOCIAL_TRADE_BASE_COINS.usdc;

/**
 * The gate's route string (FEATURE-MAP-R3 §14.1): the coins the trade passes
 * through, then where. The coins follow the route's main path (at each coin,
 * the leg carrying the most); a coin without a known symbol (an intermediate
 * the aggregator chose that Blast does not list) is left out. Where: the
 * venue of each leg touching a Blast sale coin by name, and every other leg
 * (USDC and SUI liquidity) as "Sui pools": `USDC → MRDN · Cetus`,
 * `SUI → USDC → MRDN · Sui pools and Cetus`, `SUI → USDC · Sui pools`.
 */
export function routeLabel(
  legs: readonly (RouteLeg & Readonly<{ venue: string }>)[],
  source: string,
  target: string,
  symbols: ReadonlyMap<string, string>,
): string | null {
  const chain: string[] = [source];
  let at = source;
  for (let guard = 0; at !== target && guard <= legs.length; guard += 1) {
    const next = legs.filter((leg) => leg.from === at).sort((a, b) => (b.amountIn > a.amountIn ? 1 : b.amountIn < a.amountIn ? -1 : 0))[0];
    if (!next) return null;
    at = next.target;
    chain.push(at);
  }
  if (at !== target) return null;
  const named = chain.filter((coin) => symbols.has(coin)).map((coin) => symbols.get(coin)!);
  const saleVenues = new Set<string>();
  let otherLegs = false;
  for (const leg of legs) {
    if (!isBaseCoin(leg.from) && symbols.has(leg.from)) saleVenues.add(leg.venue);
    else if (!isBaseCoin(leg.target) && symbols.has(leg.target)) saleVenues.add(leg.venue);
    else otherLegs = true;
  }
  const venues = [...saleVenues].sort().map((venue) => knownVenueName(venue) ?? "Sui pools");
  const unique = [...new Set(venues)];
  const where = unique.length === 0 ? "Sui pools" : otherLegs ? `Sui pools and ${unique.join(" and ")}` : unique.join(" and ");
  return `${named.join(" → ")} · ${where}`;
}
