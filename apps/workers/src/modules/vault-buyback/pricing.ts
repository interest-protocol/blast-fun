// The buyback's money checks, in exact integers (no floating point). Prices
// are Quote atoms per Meme atom, as blast-infra and the SDK state them;
// blast-infra's decimal strings are scaled by 10^36 here.
//
// One run buys one piece (LP-22 and the owner's decisions of 2026-10-27),
// checked cheapest first:
//
// 1. nothing waits: done for the day;
// 2. the waiting Quote is worth less than the minimum piece (default $50):
//    done for the day, it waits for later collections;
// 3. the cap (default 1% of the pool's Quote liquidity) is worth less than the
//    minimum piece: the pool is too thin today, done for the day;
// 4. the reference (a time-weighted price from blast-infra's candles, default
//    30 minutes) is missing or stale: retry;
// 5. the pool's spot price deviates from the reference by the tolerance or
//    more (default 10%; smaller deviations are ignored): retry;
// 6. otherwise buy a piece of `quote_in`, drawn uniformly from a CSPRNG
//    between the minimum and min(waiting Quote, cap), with
//    `min_meme_out` = quote_in ÷ reference × (1 − tolerance). What is left
//    waits for the day's next random time (`schedule.ts`).

export const PRICE_SCALE = 10n ** 36n;
const BPS = 10_000n;
const U64_MAX = (1n << 64n) - 1n;

/** A canonical decimal price string (`"0.0025"`) as an integer scaled by 10^36. */
export function scaledPrice(price: string): bigint {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,36}))?$/.exec(price);
  if (!match) throw new TypeError("A price is a canonical decimal string with at most 36 decimals.");
  return BigInt(match[1]! + (match[2] ?? "").padEnd(36, "0"));
}

/** The candle fields the reference needs: a bucket's start, open and close. */
export type PriceCandle = Readonly<{ bucketStart: number; open: string; close: string }>;

/**
 * The time-weighted average price over `[startMs, endMs)`, scaled by 10^36,
 * or null when no candle says what the price was. The price is a step: from
 * each candle's bucket start it is that candle's close, until the next
 * candle. A bucket without a candle had no trade, so the previous close holds
 * (blast-infra's "gaps stay gaps"). Before the first candle in the window the
 * price is the latest earlier candle's close or, when the page holds none,
 * the first candle's open, which is the previous close by blast-infra's
 * contract. `candles` are oldest first.
 */
export function twapPrice(candles: readonly PriceCandle[], startMs: number, endMs: number): bigint | null {
  if (!(endMs > startMs) || candles.length === 0) return null;
  const before = candles.filter((candle) => candle.bucketStart <= startMs).at(-1);
  const inside = candles.filter((candle) => candle.bucketStart > startMs && candle.bucketStart < endMs);
  const seed = before ? before.close : inside[0]?.open;
  if (seed === undefined) return null;
  let price = scaledPrice(seed);
  let cursor = startMs;
  let weighted = 0n;
  for (const candle of inside) {
    weighted += price * BigInt(candle.bucketStart - cursor);
    cursor = candle.bucketStart;
    price = scaledPrice(candle.close);
  }
  weighted += price * BigInt(endMs - cursor);
  return weighted / BigInt(endMs - startMs);
}

/** An exact rational price, Quote atoms per Meme atom (the SDK's `ExactPrice`). */
export type ExactPrice = Readonly<{ numerator: bigint; denominator: bigint }>;

/** Whether `spot` deviates from `reference` (scaled by 10^36) by less than `toleranceBps`, either side. */
export function withinTolerance(spot: ExactPrice, reference: bigint, toleranceBps: bigint): boolean {
  if (reference <= 0n || spot.denominator <= 0n) return false;
  const scaledSpot = spot.numerator * PRICE_SCALE;
  const scaledReference = reference * spot.denominator;
  const gap = scaledSpot > scaledReference ? scaledSpot - scaledReference : scaledReference - scaledSpot;
  return gap * BPS < toleranceBps * scaledReference;
}

/** The fewest Meme a swap of `quoteIn` at `reference` may return: rounded down, less the tolerance. */
export function minimumMemeOut(quoteIn: bigint, reference: bigint, toleranceBps: bigint): bigint {
  if (reference <= 0n) throw new RangeError("The reference price must be positive.");
  return (quoteIn * PRICE_SCALE * (BPS - toleranceBps)) / (reference * BPS);
}

/** The most Quote one swap may spend: `maxShareBps` of the pool's Quote liquidity, rounded down. */
export function quoteCap(poolQuote: bigint, maxShareBps: bigint): bigint {
  return (poolQuote * maxShareBps) / BPS;
}

/** A Pyth-style USD price (`price × 10^expo` dollars per whole Quote) and the Quote's decimals. */
export type QuoteUsd = Readonly<{ price: bigint; expo: number; decimals: number }>;

/** Whether `quoteAtoms` are worth at least `minUsdCents`. */
export function worthAtLeast(quoteAtoms: bigint, usd: QuoteUsd, minUsdCents: bigint): boolean {
  // cents = atoms × price × 100 × 10^expo / 10^decimals
  const exponent = usd.decimals - usd.expo;
  const left = quoteAtoms * usd.price * 100n;
  return exponent >= 0 ? left >= minUsdCents * 10n ** BigInt(exponent) : left * 10n ** BigInt(-exponent) >= minUsdCents;
}

/** The fewest Quote atoms worth at least `minUsdCents`: the smallest piece. */
export function atomsWorth(minUsdCents: bigint, usd: QuoteUsd): bigint {
  // atoms ≥ cents × 10^(decimals − expo) / (price × 100)
  const exponent = usd.decimals - usd.expo;
  const numerator = exponent >= 0 ? minUsdCents * 10n ** BigInt(exponent) : minUsdCents;
  const denominator = exponent >= 0 ? usd.price * 100n : usd.price * 100n * 10n ** BigInt(-exponent);
  const atoms = (numerator + denominator - 1n) / denominator;
  return atoms < 1n ? 1n : atoms;
}

export type BuybackFacts = Readonly<{
  /** `LpVault.burn_quote`, read on chain now. */
  heldQuote: bigint;
  /** The pool's Quote balance, read on chain now. */
  poolQuote: bigint;
  /** The pool's spot price from its current sqrt price, read on chain now. */
  spot: ExactPrice;
  /** The time-weighted reference (scaled 10^36): `stale` when blast-infra lags beyond the limit. */
  reference: Readonly<{ status: "fresh"; price: bigint }> | Readonly<{ status: "stale" | "unavailable" }>;
  /** The Quote's USD price, or null when blast-infra has none fresh enough. */
  quoteUsd: QuoteUsd | null;
}>;

export type BuybackPolicy = Readonly<{ minUsdCents: bigint; maxPoolShareBps: bigint; slippageBps: bigint }>;

/** `tomorrow`: nothing more today. `retry`: try again later today. */
export type SkipReason =
  | "nothing-held"
  | "below-minimum"
  | "pool-too-thin"
  | "min-out-zero"
  | "min-out-overflow"
  | "usd-unavailable"
  | "reference-unavailable"
  | "reference-stale"
  | "price-deviation";

export type BuybackDecision =
  | Readonly<{ kind: "skip"; reason: SkipReason; until: "tomorrow" | "retry" }>
  | Readonly<{ kind: "buy"; quoteIn: bigint; minMemeOut: bigint; minPiece: bigint; maxPiece: bigint }>;

/** A uniform whole number in `[low, high]`, from the injected (CSPRNG) source. */
export type DrawAmount = (low: bigint, high: bigint) => bigint;

/** Decides one vault's next piece now from fresh facts; `draw` picks its size. */
export function decideBuyback(facts: BuybackFacts, policy: BuybackPolicy, draw: DrawAmount): BuybackDecision {
  const skip = (reason: SkipReason, until: "tomorrow" | "retry"): BuybackDecision => ({ kind: "skip", reason, until });
  if (facts.heldQuote <= 0n) return skip("nothing-held", "tomorrow");
  if (!facts.quoteUsd) return skip("usd-unavailable", "retry");
  const minPiece = atomsWorth(policy.minUsdCents, facts.quoteUsd);
  if (facts.heldQuote < minPiece) return skip("below-minimum", "tomorrow");
  const cap = quoteCap(facts.poolQuote, policy.maxPoolShareBps);
  if (cap < minPiece) return skip("pool-too-thin", "tomorrow");
  const fact = facts.reference;
  if (fact.status !== "fresh") return skip(fact.status === "stale" ? "reference-stale" : "reference-unavailable", "retry");
  const reference = fact.price;
  if (!withinTolerance(facts.spot, reference, policy.slippageBps)) return skip("price-deviation", "retry");
  const maxPiece = facts.heldQuote < cap ? facts.heldQuote : cap;
  const quoteIn = draw(minPiece, maxPiece);
  if (quoteIn < minPiece || quoteIn > maxPiece) throw new RangeError("A piece is drawn within its bounds.");
  const minMemeOut = minimumMemeOut(quoteIn, reference, policy.slippageBps);
  if (minMemeOut < 1n) return skip("min-out-zero", "tomorrow");
  if (minMemeOut > U64_MAX) return skip("min-out-overflow", "tomorrow");
  return { kind: "buy", quoteIn, minMemeOut, minPiece, maxPiece };
}
