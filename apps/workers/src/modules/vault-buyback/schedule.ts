// When each vault's buyback runs, and how much each piece spends. The owner's
// rule (LP-22, 2026-10-27): nothing about timing or size is predictable from
// the schedule or the chain. Every draw comes from a cryptographically secure
// source (`node:crypto`), never `Math.random`; tests inject their own.
//
// - Each vault draws its first run time of the day uniformly over what is left
//   of the UTC day when it is planned, and the draw is stored, so a restart
//   neither redraws nor reveals it.
// - Each run buys one piece of a random size (`drawAmount`, between the $50
//   minimum and min(waiting Quote, 1% of the pool's Quote)).
// - While Quote is left, the next piece runs at a random later time that day
//   (`nextPieceTime`), at least the configured gap after this one, up to the
//   configured number of pieces: a random number of pieces at random
//   intervals. What is left at the day's end waits for the next day's draw.
// - Due vaults are visited in a freshly shuffled order every pass, and a
//   retry within the day waits a random delay.

import { randomInt } from "node:crypto";

/** A uniform whole number in `[0, maxExclusive)`. */
export type RandomSource = (maxExclusive: number) => number;

/** `node:crypto`'s CSPRNG: uniform without modulo bias, for ranges below 2^48. */
export const secureRandom: RandomSource = (maxExclusive) => randomInt(maxExclusive);

/** A uniform float in `[0, 1)` from the CSPRNG, for the runtime's jittered backoff. */
export function secureUnit(random: RandomSource = secureRandom): number {
  return random(2 ** 47) / 2 ** 47;
}

export const DAY_MS = 24 * 60 * 60 * 1_000;

/** The UTC day holding `nowMs`: its start, and its date as `YYYY-MM-DD`. */
export function utcDay(nowMs: number): Readonly<{ startMs: number; endMs: number; date: string }> {
  const startMs = nowMs - (((nowMs % DAY_MS) + DAY_MS) % DAY_MS);
  return { startMs, endMs: startMs + DAY_MS, date: new Date(startMs).toISOString().slice(0, 10) };
}

/**
 * Today's run time for one vault: uniform over `[now, end of the UTC day)`.
 * Planned at the day's first pass this is the whole day; a vault found later
 * (or a worker started mid-day) draws from what is left of it.
 */
export function drawRunTime(nowMs: number, random: RandomSource = secureRandom): number {
  const { endMs } = utcDay(nowMs);
  const span = endMs - nowMs;
  return nowMs + random(span);
}

/** A Fisher-Yates shuffle with the given source: the pass's visiting order. */
export function shuffled<T>(items: readonly T[], random: RandomSource = secureRandom): T[] {
  const out = [...items];
  for (let index = out.length - 1; index > 0; index -= 1) {
    const other = random(index + 1);
    [out[index], out[other]] = [out[other]!, out[index]!];
  }
  return out;
}

/** A retry's delay: uniform in `[ceiling / 2, ceiling]`, so retries never line up either. */
export function retryDelay(ceilingMs: number, random: RandomSource = secureRandom): number {
  const half = Math.max(1, Math.floor(ceilingMs / 2));
  return half + random(Math.max(1, ceilingMs - half + 1));
}

/** A uniform bigint in `[0, maxExclusive)` from the source, by rejection over 32-bit words. */
export function randomBelow(maxExclusive: bigint, random: RandomSource = secureRandom): bigint {
  if (maxExclusive <= 0n) throw new RangeError("The range must be positive.");
  if (maxExclusive <= 2n ** 47n) return BigInt(random(Number(maxExclusive)));
  const bits = maxExclusive.toString(2).length;
  const words = Math.ceil(bits / 32);
  const mask = (1n << BigInt(bits)) - 1n;
  for (;;) {
    let value = 0n;
    for (let word = 0; word < words; word += 1) value = (value << 32n) | BigInt(random(2 ** 32));
    value &= mask;
    if (value < maxExclusive) return value;
  }
}

/** A piece's size: uniform in `[low, high]`. */
export function drawAmount(low: bigint, high: bigint, random: RandomSource = secureRandom): bigint {
  if (high < low) throw new RangeError("A piece's bounds must be ordered.");
  return low + randomBelow(high - low + 1n, random);
}

/**
 * The next piece's time: uniform over `[now + minGap, end of the UTC day)`,
 * or null when the day ends first (what is left waits for tomorrow's draw).
 */
export function nextPieceTime(nowMs: number, minGapMs: number, random: RandomSource = secureRandom): number | null {
  const earliest = nowMs + minGapMs;
  const { endMs } = utcDay(nowMs);
  return earliest >= endMs ? null : earliest + random(endMs - earliest);
}
