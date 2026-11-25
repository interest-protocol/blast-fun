import type { IChartApi, ISeriesApi, MouseEventParams, SeriesType, Time } from "lightweight-charts";
import { useState } from "react";
import { exactChartCandle, exactChartPrice, nearestPriceSeries, type ExactSeries } from "./chart-inspection-model";

type Inspection = Readonly<{
  at: number;
  series: number;
  mode: "line" | "candles";
  onVolume: boolean;
  guide?: Readonly<{ x: number; height: number }>;
}>;

export function useChartInspection() {
  const [inspected, setInspected] = useState<Inspection | null>(null);

  function observe(chart: IChartApi, host: HTMLElement, series: readonly ISeriesApi<SeriesType>[], mode: Inspection["mode"]) {
    let pointer = "mouse";
    const trackPointer = (event: PointerEvent) => { pointer = event.pointerType; };
    const stage = host.closest<HTMLElement>("[data-chart-stage]") ?? host;
    const leave = () => {
      if (pointer === "mouse" && !stage.querySelector('[data-chart-exact-trigger][aria-expanded="true"]')) setInspected(null);
    };
    const inspection = (event: MouseEventParams<Time>): Inspection | null => {
      const onVolume = mode === "candles" && event.paneIndex === 1;
      if (typeof event.time !== "number" || (event.paneIndex !== 0 && !onVolume)) return null;
      return { at: event.time, series: onVolume ? -1 : hitPriceSeries(event, series, pointer === "mouse"), mode, onVolume };
    };
    const followCrosshair = (event: MouseEventParams<Time>) => {
      if (!event.sourceEvent) return;
      const next = inspection(event);
      setInspected((prior) => next && prior?.at === next.at && prior.series === next.series && prior.onVolume === next.onVolume && !prior.guide ? prior : next);
    };
    const timeScale = chart.timeScale();
    const click = (event: MouseEventParams<Time>) => {
      const next = inspection(event);
      if (pointer === "mouse" || !next || event.time === undefined) {
        setInspected(next);
        return;
      }
      const x = timeScale.timeToCoordinate(event.time);
      setInspected(x === null ? next : { ...next, guide: { x, height: chart.paneSize(0).height } });
    };
    const viewChanged = () => setInspected((prior) => prior?.guide ? null : prior);
    const outside = (event: PointerEvent) => {
      const path = event.composedPath();
      if (path.includes(stage) || path.some((node) => node instanceof HTMLElement && node.hasAttribute("data-chart-exact-values"))) return;
      chart.clearCrosshairPosition();
      setInspected(null);
    };
    const listeners = new AbortController();
    const { signal } = listeners;
    host.ownerDocument.addEventListener("pointerdown", outside, { capture: true, signal });
    host.addEventListener("pointerdown", trackPointer, { capture: true, signal });
    host.addEventListener("pointermove", trackPointer, { capture: true, signal });
    stage.addEventListener("pointerleave", leave, { signal });
    chart.subscribeCrosshairMove(followCrosshair);
    chart.subscribeClick(click);
    timeScale.subscribeVisibleLogicalRangeChange(viewChanged);
    return () => {
      listeners.abort();
      chart.unsubscribeCrosshairMove(followCrosshair);
      chart.unsubscribeClick(click);
      timeScale.unsubscribeVisibleLogicalRangeChange(viewChanged);
      setInspected(null);
    };
  }

  function priceAt(points: readonly ExactSeries[], volumes: ReadonlyMap<number, string>, mode: Inspection["mode"], hidden: boolean, gapStatus?: (at: number) => string, stepped = false) {
    if (hidden || inspected?.mode !== mode) return undefined;
    const { at, series, guide, onVolume } = inspected;
    const gap = () => gapStatus && { at, guide, gap: gapStatus(at * 1_000) };
    if (mode === "line") {
      const value = exactChartPrice(points, at, series, stepped ? "step" : !gapStatus);
      return value === undefined ? gap() : { at, guide, value };
    }
    const candle = exactChartCandle(points, at, series);
    const volume = onVolume ? volumes.get(at) : candle?.volume;
    return volume === undefined ? gap() : { at, guide, candle, volume };
  }

  return { priceAt, observe };
}
function hitPriceSeries(event: MouseEventParams<Time>, series: readonly ISeriesApi<SeriesType>[], mouse: boolean) {
  const hovered = mouse ? event.hoveredInfo?.series : undefined;
  const direct = hovered ? series.findIndex((item) => item === hovered && item.seriesType() !== "Histogram") : -1;
  if (direct !== -1 || !event.point) return direct;

  // A tap can omit the hit series. Prefer the candle under the pointer
  // when two pools trade in the same time bucket.
  return nearestPriceSeries(series.map((item) => priceBand(event, item)), event.point.y);
}

function priceBand(event: MouseEventParams<Time>, series: ISeriesApi<SeriesType>) {
  if (series.seriesType() === "Histogram") return null;
  const data = event.seriesData.get(series);
  if (!data) return null;
  if ("close" in data) {
    const close = series.priceToCoordinate(data.close);
    const top = series.priceToCoordinate(data.high);
    const bottom = series.priceToCoordinate(data.low);
    return close === null || top === null || bottom === null ? null : { close, top, bottom };
  }
  const close = "value" in data ? series.priceToCoordinate(data.value) : null;
  return close === null ? null : { close, top: close, bottom: close };
}
