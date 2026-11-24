type Point = Readonly<{ time: unknown }>;

/** Published coordinates can all change when a new extreme rescales the exact prices.
 * Only use the library's tail update if every preceding plotted point still matches. */
export function seriesChange(before: readonly Point[] | undefined, after: readonly Point[]): "none" | "tail" | "replace" {
  if (before === after) return "none";
  if (!before || after.length < before.length || after.length > before.length + 1) return "replace";
  for (let index = 0; index < before.length; index++) {
    const old = before[index]!;
    const point = after[index]!;
    if (old === point) continue;
    if (old.time !== point.time) return "replace";
    const entries = Object.entries(old);
    if (entries.length === Object.keys(point).length && entries.every(([key, value]) => value === Reflect.get(point, key))) continue;
    return index === after.length - 1 ? "tail" : "replace";
  }
  return before.length === after.length ? "none" : "tail";
}
