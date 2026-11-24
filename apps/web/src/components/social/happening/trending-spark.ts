import { sparkCoordinates, type SparkPoint } from "#web/components/charts/spark-model.ts";
import type { PricePoint } from "@blast/core/web/contracts/prices.ts";

/** Real observations only, oldest first; duplicate times keep the last observation. */
export function trendingSparkPath(history: readonly PricePoint[] | undefined): string | null {
  if (!Array.isArray(history)) return null;
  const byTime = new Map<number, number>();
  for (const point of history) {
    if (!Array.isArray(point)) continue;
    const [at, price] = point;
    const value = Number(price);
    if (typeof at === "number" && Number.isFinite(at) && at >= 0 && typeof price === "string" && Number.isFinite(value) && value > 0) byTime.set(at, value);
  }
  const points: SparkPoint[] = [...byTime].sort(([a], [b]) => a - b);
  if (points.length < 2) return null;
  const flat = points.every(([, value]) => value === points[0]![1]);
  const coordinates = sparkCoordinates(flat ? points.map(([at]) => [at, 0]) : points, 72, 24);
  if (coordinates.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return null;
  return coordinates.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x.toFixed(1)},${flat ? "12.0" : y.toFixed(1)}`).join(" ");
}

/** The same validated history used by the shared renderer. */
export function trendingSparkPoints(history: readonly PricePoint[] | undefined): SparkPoint[] {
  const byTime = new Map<number, number>();
  for (const [at, price] of history ?? []) {
    const value = Number(price);
    if (Number.isFinite(at) && at >= 0 && Number.isFinite(value) && value > 0) byTime.set(at, value);
  }
  return [...byTime].sort(([a], [b]) => a - b);
}
