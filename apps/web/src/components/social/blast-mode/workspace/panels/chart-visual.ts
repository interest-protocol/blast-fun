import { chartPrice } from "#web/components/charts/chart-price.ts";
import { subscriptZeros } from "#web/lib/market-format.ts";
import { exactDecimal, unitsAt, type Exact } from "@blast/core/web/exact-amount.ts";
export type Observation = Readonly<{
  at: number;
  value: string;
  source: string;
  candle?: Readonly<{ open: string; high: string; low: string }>;
  volume?: string;
}>;
export type PlacedObservation = Observation &
  Readonly<{ x: number; y: number }>;
function decimal(n: bigint, scale: number): string {
  const digits = n.toString().padStart(scale + 1, "0");
  return scale
    ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
        .replace(/0+$/, "")
        .replace(/\.$/, "")
    : digits;
}
/** Short scale labels only; inspection retains original decimals. One price format site-wide: subscript zeros, compact large values, never e-notation. */
export function axisPrice(value: string, precision = 5): string {
  const exact = exactDecimal(value);
  if (!exact || exact.n === 0n) return "0";
  const digits = exact.n.toString();
  const exponent = digits.length - exact.scale - 1;
  // Precision is the caller's (tick labels raise it until they differ), so only the notation is shared with chartPrice.
  if (exponent >= 6) return chartPrice(value, precision);
  if (exponent < -4) return subscriptZeros(`0.${"0".repeat(-exponent - 1)}${digits.slice(0, precision).replace(/0+$/, "")}`);
  const kept = digits.slice(0, precision);
  const scale = exact.scale - (digits.length - kept.length);
  return scale < 0 ? kept + "0".repeat(-scale) : decimal(BigInt(kept), scale);
}

/** Tight price moves need more significant digits than ordinary compact labels. */
export function priceTickLabels(values: readonly string[]): string[] {
  const maxDigits = Math.max(...values.map(value => exactDecimal(value)!.n.toString().length));
  for (let precision = 5; precision < maxDigits; precision++) {
    const labels = values.map(value => axisPrice(value, precision));
    if (new Set(labels).size === values.length) return labels;
  }
  return values.map(value => axisPrice(value, maxDigits));
}

const secondsFormatter = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "UTC" });
const timeFormatter = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
const dateFormatter = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const dayTimeFormatter = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
const yearFormatter = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "2-digit", timeZone: "UTC" });

/** These are positions on the observed span, not invented observations. */
export function chartTimeTicks(start: number, end: number) {
  const span = end - start;
  const count = Math.min(5, Math.floor(span / 1000) + 1);
  const format = span < 240_000 ? secondsFormatter
    : span < 86_400_000 ? timeFormatter
    : end - start < 4 * 86_400_000 ? dayTimeFormatter
    : new Date(start).getUTCFullYear() === new Date(end).getUTCFullYear() ? dateFormatter : yearFormatter;
  return Array.from({ length: count }, (_, index) => {
    const ratio = count === 1 ? .5 : index / (count - 1);
    const at = start + span * ratio;
    return { at, label: format.format(at), x: ratio * 100 };
  });
}
/** Only integer ratios become pixels; prices never pass through floats. */
export function chartVisual(
  observations: readonly Observation[],
  intervalMs: number,
) {
  const valid = observations
    .flatMap((point) => {
      const exact = exactDecimal(point.value);
      return exact && Number.isFinite(point.at) ? [{ ...point, exact }] : [];
    })
    .sort((a, b) => a.at - b.at);
  if (!valid.length) return null;
  const prices = valid.flatMap(point => [point.exact, ...(point.candle ? [point.candle.open, point.candle.high, point.candle.low].map(value => exactDecimal(value)!) : [])]);
  const scale = Math.max(...prices.map(exact => exact.scale)) + 3;
  const atScale = (value: Exact) => unitsAt(value, scale, "floor");
  const values = prices.map(atScale);
  let low = values.reduce((a, b) => (a < b ? a : b));
  let high = values.reduce((a, b) => (a > b ? a : b));
  if (low === high) {
    const pad = high / 20n || 1n;
    low = high > pad ? high - pad : 0n;
    high += pad;
  }
  const start = valid[0]!.at;
  const end = valid.at(-1)!.at;
  const y = (value: bigint) =>
    18 + Number(((high - value) * 264_000n) / (high - low)) / 1000;
  const points: PlacedObservation[] = valid.map(({ exact, ...point }) => ({
    ...point,
    x: end === start ? 500 : ((point.at - start) / (end - start)) * 1000,
    y: y(atScale(exact)),
  }));
  const segments: PlacedObservation[][] = [];
  const gaps: number[] = [];
  for (const point of points) {
    const previous = segments.at(-1)?.at(-1);
    const missing = previous && point.at - previous.at > intervalMs * 1.5;
    if (!previous || missing || previous.source !== point.source)
      segments.push([]);
    if (missing) gaps.push((point.at + previous.at) / 2);
    segments.at(-1)!.push(point);
  }
  const ticks = [0, 1, 2, 3].map((step) => {
    const value = high - ((high - low) * BigInt(step)) / 3n;
    return { value: decimal(value, scale), y: y(value) };
  });
  return { points, segments, gaps, ticks, start, end, coordinate: (value: string) => 300 - y(atScale(exactDecimal(value)!)) };
}
export function nearestObservation(
  points: readonly Observation[],
  at: number,
): number {
  return points.reduce(
    (nearest, point, index) =>
      Math.abs(point.at - at) < Math.abs(points[nearest]!.at - at)
        ? index
        : nearest,
    0,
  );
}
