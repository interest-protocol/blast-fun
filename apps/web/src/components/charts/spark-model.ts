/**
 * The sparkline's geometry (the gate's `spark()`, FEATURE-MAP §3.4): the line
 * spans the box, the lowest value sits 3 px above the bottom and the highest
 * 3 px below the top, the area under it closes on the box's bottom edge, and
 * a dot marks the last value. Green when the line ends at or above where it
 * started, red below. A flat line sits on the lower edge (the gate divides by
 * 1 there). Pure, so the geometry the chart library is given is tested once.
 *
 * Points are `[x, value]`: a price's own time for a real series (a gap is a
 * straight segment between two real prices, never filled in), the index for
 * the gate's evenly spaced ticks, where the two are the same drawing.
 */

export type SparkPoint = readonly [x: number, value: number];

/** The gate's inset above the highest and below the lowest value. */
export const SPARK_INSET = 3;

/** Whether the line ends at or above where it started (the gate's `up`). */
export function sparkUp(points: readonly SparkPoint[]): boolean {
  return points.length < 2 || points[points.length - 1]![1] >= points[0]![1];
}

/**
 * The value range that maps the lowest value to `height − 3` and the highest
 * to 3 when the box's full height is the range: the gate's
 * `h − 3 − (v − min) / k · (h − 6)` with `k = (max − min) || 1`.
 */
export function sparkDomain(points: readonly SparkPoint[], height: number): readonly [number, number] {
  const values = points.map((point) => point[1]);
  const min = Math.min(...values);
  const k = Math.max(...values) - min || 1;
  const pad = (SPARK_INSET * k) / (height - 2 * SPARK_INSET);
  return [min - pad, min + k + pad];
}

/** The x range: first to last point. */
export function sparkXDomain(points: readonly SparkPoint[]): readonly [number, number] {
  return [points[0]![0], points[points.length - 1]![0]];
}

/** Where a point lands in a `width`×`height` box, as the chart draws it (for tests and the gate comparison). */
export function sparkCoordinates(points: readonly SparkPoint[], width: number, height: number): readonly (readonly [number, number])[] {
  const [x0, x1] = sparkXDomain(points);
  const [y0, y1] = sparkDomain(points, height);
  return points.map(([x, value]) => [((x - x0) / (x1 - x0 || 1)) * width, height - ((value - y0) / (y1 - y0)) * height] as const);
}

/** A pixel coordinate as the gate writes it into its paths: `toFixed(1)`. */
export function gatePixel(value: number): number {
  return Number(value.toFixed(1));
}

/**
 * The data the chart is given: each point moved by at most 0.05 px so that
 * its vertex lands where the gate's path puts it — the gate writes every
 * vertex to one decimal (`toFixed(1)`), and the rasterised edge follows the
 * rounded value. The dot keeps the exact last point, as the gate's does.
 */
export function sparkData(points: readonly SparkPoint[], width: number, height: number): { x: number; v: number }[] {
  const [x0, x1] = sparkXDomain(points);
  const [y0, y1] = sparkDomain(points, height);
  return sparkCoordinates(points, width, height).map(([px, py], index) => ({
    x: x1 === x0 ? points[index]![0] : x0 + (gatePixel(px) / width) * (x1 - x0),
    v: y0 + ((height - gatePixel(py)) / height) * (y1 - y0),
  }));
}

/** The gate's own `spark()` coordinates for evenly spaced values (the reference the chart is compared with). */
export function gateSparkCoordinates(values: readonly number[], width: number, height: number): readonly (readonly [number, number])[] {
  const min = Math.min(...values);
  const k = Math.max(...values) - min || 1;
  return values.map((value, index) => [(index / (values.length - 1)) * width, height - 3 - ((value - min) / k) * (height - 6)] as const);
}
