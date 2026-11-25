import type { IRange, UTCTimestamp } from "lightweight-charts";

export const chartTimestamp = (at: number) => (at / 1000) as UTCTimestamp;
export type SavedChartView = Readonly<{
  range: { from: number; to: number };
  first: number;
  last: number;
}>;

/** Full views keep fitting live data; zoomed views follow only when already at the live edge. */
export function restoredChartRange(previous: SavedChartView, last: number) {
  const { range, first } = previous;
  if (range.from <= first && range.to >= previous.last) return null;
  const shift = range.to >= previous.last ? last - previous.last : 0;
  return { from: range.from + shift, to: range.to + shift };
}

export const LIVE_GUTTER_PX = 32;

function barsPerPixel(range: IRange<number>, width: number) {
  return (range.to - range.from + 1) / width;
}

export function atLiveEdge(range: IRange<number>, pointCount: number, width: number) {
  const gap = (range.to - (pointCount - 1)) / barsPerPixel(range, width);
  return gap >= -1 && gap <= LIVE_GUTTER_PX + 1;
}

export function panChartRange(range: IRange<number>, pixels: number, width: number) {
  const shift = pixels * barsPerPixel(range, width);
  return { from: range.from + shift, to: range.to + shift };
}

export function liveChartRange(range: IRange<number>, pointCount: number, width: number) {
  const to = pointCount - 1 + LIVE_GUTTER_PX * barsPerPixel(range, width);
  const from = to - (range.to - range.from);
  if (from >= 0 || width <= LIVE_GUTTER_PX) return { from, to };
  // The coin chart pins its left edge at the first bar, so a wider view fits every bar plus the gutter.
  const gutter = LIVE_GUTTER_PX / width;
  return { from: 0, to: (pointCount - 1 + gutter) / (1 - gutter) };
}

export function resizedLiveChartRange(range: IRange<number>, pointCount: number, before: number, after: number, initialFit = false) {
  // A native fit can gain extra gutter, or slide right of the pinned first bar, when the price axis settles on a narrow plot.
  if (initialFit && after && range.from > -0.001 && range.to >= pointCount - 1) {
    return liveChartRange(range, pointCount, after);
  }
  if (!before || !after || before === after || !atLiveEdge(range, pointCount, before)) return null;
  return liveChartRange(range, pointCount, after);
}

function regridChartRange(range: IRange<number>, before: readonly number[], after: readonly number[]) {
  const oldStart = before[0]!;
  const newStart = after[0]!;
  const oldStep = (before.at(-1)! - oldStart) / (before.length - 1);
  const newStep = (after.at(-1)! - newStart) / (after.length - 1);
  if (!oldStep || !newStep || Math.abs(newStep - oldStep) < 0.001) return null;
  const uniform = (times: readonly number[], start: number, step: number) =>
    times.every((time, index) => Math.abs(time - (start + index * step)) < 0.001);
  if (!uniform(before, oldStart, oldStep) || !uniform(after, newStart, newStep)) return null;
  const project = (index: number) => (oldStart - newStart + index * oldStep) / newStep;
  return { from: project(range.from), to: project(range.to) };
}

/** Preserve fractional spacing. Keep the newest bar in place at the live edge, or anchor history by time. */
export function rebaseCoinChartRange(range: IRange<number>, before: readonly number[], after: readonly number[], width: number) {
  const following = atLiveEdge(range, before.length, width);
  const regridded = regridChartRange(range, before, after);
  if (regridded) return following ? liveChartRange(regridded, after.length, width) : regridded;
  if (following) {
    const shift = after.length - before.length;
    const shifted = { from: range.from + shift, to: range.to + shift };
    // The coin chart pins its first bar; a view shifted before it would gain gutter and leave the live edge.
    return shifted.from < 0 ? liveChartRange(shifted, after.length, width) : shifted;
  }
  const left = Math.max(0, Math.min(before.length - 1, Math.floor(range.from)));
  const available = new Set(after);
  const retained = before.findIndex((time, index) => index >= left && available.has(time));
  const anchor = retained >= 0 ? retained : before.findLastIndex((time) => available.has(time));
  const oldIndex = anchor >= 0 ? anchor : left;
  const next = after.findIndex((time) => time >= before[oldIndex]!);
  const shift = (next < 0 ? after.length - 1 : next) - oldIndex;
  return { from: range.from + shift, to: range.to + shift };
}

/** A native range write is applied on the next chart frame. Data and input use its pending target until then. */
export function queuedChartRange(readNative: () => IRange<number> | null, writeNative: (range: IRange<number>) => void) {
  let pending: IRange<number> | null = null;
  return {
    read: () => pending ?? readNative(),
    write: (range: IRange<number>) => {
      pending = range;
      writeNative(range);
    },
    settle: () => { pending = null; },
  };
}

export function zoomChartRange(range: IRange<number>, anchor: number, wheelDelta: number) {
  const factor = Math.exp(Math.max(-1, Math.min(1, wheelDelta * 0.002)));
  return {
    from: anchor - (anchor - range.from) * factor,
    to: anchor + (range.to - anchor) * factor,
  };
}

/** Use the target range for pointer zoom even when the canvas still shows the previous frame. */
export function zoomChartRangeAtPixel(range: IRange<number>, x: number | null, width: number, delta: number) {
  const anchor = x === null || !width
    ? (range.from + range.to) / 2
    : range.to - (width - 1 - x) * barsPerPixel(range, width);
  return zoomChartRange(range, anchor, delta);
}

export function keyboardChartRange(key: string, range: IRange<number>, pointCount: number, width: number) {
  if (key === "ArrowLeft" || key === "ArrowRight")
    return panChartRange(range, (key === "ArrowLeft" ? -1 : 1) * width / 8, width);
  if (key !== "+" && key !== "-" && key !== "=") return null;
  const zoom = zoomChartRange(range, (range.from + range.to) / 2, key === "-" ? 120 : -120);
  return atLiveEdge(range, pointCount, width) ? liveChartRange(zoom, pointCount, width) : zoom;
}

/** Sorted, unique library times. Callers keep exact same-time source observations separately. */
export function chartData<T extends { time: UTCTimestamp }>(
  points: readonly T[],
): T[] {
  return [
    ...new Map(points.map((point) => [Number(point.time), point])).values(),
  ].sort((a, b) => Number(a.time) - Number(b.time));
}

/** Uniform elapsed-time coordinates. Subpixel snapping affects drawing only; feature readouts retain original times. */
export function elapsedTimeScale(input: readonly number[], limit = 4096) {
  const times = [...new Set(input)].sort((a, b) => a - b);
  const first = times[0] ?? 0;
  const last = times.at(-1) ?? first;
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
  const divisor = times
    .slice(1)
    .reduce((step, at, index) => gcd(step, Math.round(at - times[index]!)), 0);
  const slots =
    last > first
      ? Math.min(
          limit,
          Math.max(1, Math.round((last - first) / (divisor || 1))),
        )
      : 0;
  const step = slots ? (last - first) / slots : 1;
  const at = (index: number) => first + index * step;
  const timeline = Array.from({ length: slots + 1 }, (_, index) => at(index));
  const snap = (time: number) => at(Math.round((time - first) / step));
  return {
    timeline,
    snap,
    timestamp: (time: number) => chartTimestamp(snap(time)),
  };
}

/** Home charts use stable time slots so a new quote in the same slot mutates only the last point. */
export function sparkTimeScale(first: number, last: number) {
  const span = Math.max(1, last - first);
  const step = Math.max(1, 2 ** Math.ceil(Math.log2(span / 128)));
  const slot = (at: number) => Math.round((at - first) / step);
  const timeline = Array.from({ length: slot(last) + 1 }, (_, index) => first + index * step);
  return { timeline, timestamp: (at: number) => chartTimestamp(first + slot(at) * step) };
}

type Plotted = Readonly<{ time: unknown; value?: number }>;

/** The first or last valued point at or inside a time bound, by binary search over sorted library data. */
function edge(points: readonly Plotted[], bound: number, last: boolean): Plotted | null {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    const time = Number(points[middle]!.time);
    if (last ? time <= bound : time < bound) low = middle + 1;
    else high = middle;
  }
  const step = last ? -1 : 1;
  for (let index = last ? low - 1 : low; index >= 0 && index < points.length; index += step) {
    const point = points[index]!;
    if (typeof point.value === "number") return point;
  }
  return null;
}

/**
 * Whether the plotted price moved up or down across the visible time range
 * (library seconds): its last visible value against its first, over every
 * price series together. Null when fewer than two values are in view.
 */
export function visibleMove(
  series: readonly (readonly Plotted[])[],
  range: Readonly<{ from: number; to: number }>,
): "up" | "down" | null {
  let first: Plotted | null = null;
  let last: Plotted | null = null;
  for (const points of series) {
    const start = edge(points, range.from, false);
    const end = edge(points, range.to, true);
    if (start && Number(start.time) <= range.to && (!first || Number(start.time) < Number(first.time))) first = start;
    if (end && Number(end.time) >= range.from && (!last || Number(end.time) > Number(last.time))) last = end;
  }
  if (!first || !last || first === last) return null;
  return last.value! >= first.value! ? "up" : "down";
}

/** A token colour (`#rgb`, `#rrggbb`, `rgb()`/`rgba()`) at `alpha`, for the area's fade; anything else fades to nothing. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(color.trim());
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color.trim());
  const channels = hex
    ? (hex[1]!.length === 3 ? [...hex[1]!].map((digit) => digit + digit) : hex[1]!.match(/../g)!).map((pair) => parseInt(pair, 16))
    : rgb
      ? rgb.slice(1, 4).map(Number)
      : null;
  return channels ? `rgba(${channels.join(", ")}, ${alpha})` : "rgba(0, 0, 0, 0)";
}

/** The longest label `chartPrice` writes; past it more digits cannot help. */
const MAX_SIGNIFICANT = 12;

/** Tick labels that differ: precision grows with zoom until neighbouring ticks read apart (audit F40). */
export function distinctTicks(
  prices: readonly number[],
  format: (value: number, significant?: number) => string,
): string[] {
  let labels = prices.map((price) => format(price));
  const kinds = (list: readonly string[]) => new Set(list).size;
  for (let significant = 6; kinds(labels) < labels.length && significant <= MAX_SIGNIFICANT; significant += 1) {
    const next = prices.map((price) => format(price, significant));
    if (kinds(next) > kinds(labels)) labels = next;
  }
  return labels;
}

/** What one wheel event over an interactive chart does (audit F41). */
export type WheelAction = "zoom" | "pan" | "page";

/**
 * Ctrl/⌘ + wheel (and a trackpad pinch, which browsers send as Ctrl + wheel) zooms.
 * A sideways swipe pans the chart, so it never turns into browser Back.
 * A vertical wheel belongs to the page.
 */
export function wheelAction(event: Pick<WheelEvent, "ctrlKey" | "metaKey" | "deltaX" | "deltaY">): WheelAction {
  if (event.ctrlKey || event.metaKey) return "zoom";
  return Math.abs(event.deltaX) > Math.abs(event.deltaY) ? "pan" : "page";
}

/** Wheel pixels, whatever unit the device reports them in. */
export const wheelPixels = (delta: number, mode: number) => (mode === 1 ? delta * 16 : mode === 2 ? delta * 800 : delta);

/** The time scale's scroll position after a sideways swipe of `pixels`: one bar per bar-spacing of travel. */
export const pannedPosition = (position: number, pixels: number, barSpacing: number) =>
  position + pixels / Math.max(barSpacing, 0.001);

/** The pointer's x inside the chart, or null when the event carries no usable one (iOS gesture events may not). */
export const pointerX = (clientX: number, left: number): number | null =>
  Number.isFinite(clientX) ? clientX - left : null;

/**
 * Whether to zoom on Safari's gesture events: only for a desktop trackpad pinch. On a
 * touch screen the library already zooms on a pinch, so these would zoom twice.
 */
export const trackpadGestures = (win: object, nav: Pick<Navigator, "maxTouchPoints">) =>
  "GestureEvent" in win && nav.maxTouchPoints === 0;
