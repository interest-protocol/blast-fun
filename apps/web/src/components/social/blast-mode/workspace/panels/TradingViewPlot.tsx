"use client";

import {
  useCallback,
  useContext,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  TradingViewChart,
  VOLUME_SCALE,
  type ChartHandle,
  type ChartSeries,
} from "#web/components/charts/TradingViewChart.tsx";
import { combinedVolumes, linePoints } from "#web/components/charts/candle-data.ts";
import { exactChartScale } from "#web/components/charts/exact-chart-scale.ts";
import { MIGRATION_LABEL_ROOM_PX } from "#web/components/charts/TradingViewChart.tsx";
import { compareExact, exactDecimal } from "@blast/core/web/exact-amount.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";
import {
  nearestObservation,
  type PlacedObservation,
} from "./chart-visual";
import { ChartTradeMarkers } from "./ChartTradeMarkers";
import {
  chartTimestamp,
  tradingViewPriceLabel,
  tradingViewTimeline,
  projectChartTime,
  type ChartGeometry,
} from "./tradingview-data";
import { dyn } from "#web/components/blast-ui/csp-style.ts";
import styles from "./CoinChartVisual.module.css";
import { CoinDetailsSlots } from "./panel-context";
import { createPortal } from "react-dom";

type PlotApi = Pick<ChartHandle, "chart" | "series">;
type ProjectedView = Readonly<{
  start: number;
  end: number;
  segments: readonly (readonly PlacedObservation[])[];
  projectTime: (at: number) => number | null;
  width: number;
  height: number;
}>;

/** Workspace data, exact inspection and activity around the shared renderer. */
export function TradingViewPlot({
  visual,
  intervalMs,
  hidden,
  selected,
  onSelect,
  style = "line",
  volume = false,
  migrationAt,
}: Readonly<{
  visual: ChartGeometry;
  intervalMs: number;
  hidden: boolean;
  selected: number | null;
  onSelect: (index: number | null) => void;
  style?: "line" | "candles";
  volume?: boolean;
  migrationAt?: number;
}>) {
  const api = useRef<PlotApi | null>(null);
  const crosshairFrame = useRef(0);
  const [view, setView] = useState<ProjectedView | null>(null);
  const timeline = useMemo(
    () =>
      tradingViewTimeline(visual, intervalMs).map(
        (point) => Number(point.time) * 1000,
      ),
    [visual, intervalMs],
  );
  const formatter = useCallback(
    (value: number, significant?: number) =>
      tradingViewPriceLabel(visual, value, significant),
    [visual],
  );
  const plotSegments = useMemo(
    () => style === "line" ? [visual.points] : visual.segments,
    [style, visual],
  );
  const series = useMemo<readonly ChartSeries[]>(() => {
    const prices: ChartSeries[] = plotSegments.map((segment, index) => {
      const options = {
        lastValueVisible: !hidden && index === plotSegments.length - 1,
        priceLineVisible: index === plotSegments.length - 1,
      };
      if (style === "candles" && segment.every((point) => point.candle))
        return {
          type: "Candlestick",
          data: segment.map((point) => ({
            time: chartTimestamp(point.at),
            open: visual.coordinate(point.candle!.open),
            high: visual.coordinate(point.candle!.high),
            low: visual.coordinate(point.candle!.low),
            close: 300 - point.y,
          })),
          options: {
            ...options,
            upColor:
              segment[0]?.source === "venue" ? "transparent" : "var(--up)",
            downColor:
              segment[0]?.source === "venue" ? "transparent" : "var(--down)",
            borderUpColor: "var(--up)",
            borderDownColor: "var(--down)",
            wickUpColor: "var(--up)",
            wickDownColor: "var(--down)",
          },
        };
      // The BlastMode board's chart: the price line over its gradient fill.
      const closes = [...new Map(segment.map((point) => [point.at, point.value]))]
        .map(([bucketStart, close]) => ({ bucketStart, close }));
      const end = closes.length === 1 ? closes[0]!.bucketStart + intervalMs : visual.end;
      return {
        type: "Area",
        data: linePoints(closes, undefined, intervalMs, -Infinity, end).map(({ timestampMs, price }) => ({
          time: chartTimestamp(timestampMs), value: visual.coordinate(price),
        })),
        options: {
          ...options,
          crosshairMarkerRadius: 3,
          autoscaleInfoProvider: visual.points.every(
            (point) => point.y === visual.points[0]!.y,
          )
            ? () => ({ priceRange: { minValue: 18, maxValue: 282 } })
            : undefined,
        },
      };
    });
    if (volume && visual.points.every((point) => point.volume !== undefined)) {
      const volumes = combinedVolumes(
        visual.points.map((point) => ({
          at: point.at,
          volume: point.volume!,
          down:
            !!point.candle &&
            compareExact(
              exactDecimal(point.value)!,
              exactDecimal(point.candle.open)!,
            ) < 0,
        })),
      );
      const scale = exactChartScale([
        "0",
        ...volumes.map((point) => point.volume),
      ]);
      prices.push({
        type: "Histogram",
        pane: 1,
        data: volumes.map((point) => ({
          time: chartTimestamp(point.at),
          value: scale.coordinate(point.volume),
          color: point.color,
        })),
        options: {
          // Its own unlabelled scale: no volume tick crowds the price axis above (audit F40).
          priceScaleId: VOLUME_SCALE,
          priceLineVisible: false,
          lastValueVisible: false,
          priceFormat: {
            type: "custom",
            minMove: 0.000001,
            // The shared chart scale already writes compact, subscript-zero labels (no e-notation).
            formatter: (value: number) => scale.format(value, 4),
          },
        },
      });
    }
    return prices;
  }, [visual, hidden, style, volume, intervalMs, plotSegments]);
  const syncSelection = useEffectEvent(() => {
    cancelAnimationFrame(crosshairFrame.current);
    crosshairFrame.current = positionSelection(api.current, visual, plotSegments, selected);
  });
  useEffect(() => {
    syncSelection();
  }, [selected, visual]);
  const project = ({ chart, series }: ChartHandle) => {
    const width = chart.timeScale().width();
    const height = chart.panes()[0]!.getHeight();
    const range = chart.timeScale().getVisibleRange();
    if (!width || !height || !range) return;
    const positions = new Map(
      timeline.map((at) => {
        const x = chart.timeScale().timeToCoordinate(chartTimestamp(at));
        return [at, x === null ? null : Number(x) / width] as const;
      }),
    );
    const projectTime = (at: number) =>
      projectChartTime(timeline, at, (time) => positions.get(time) ?? null);
    setView({
      start: Number(range.from) * 1000,
      end: Number(range.to) * 1000,
      width,
      height,
      projectTime,
      segments: plotSegments.map((segment, index) =>
        segment.map((point) => ({
          ...point,
          x: (projectTime(point.at) ?? -1) * 1000,
          y:
            (Number(series[index]!.priceToCoordinate(300 - point.y)) / height) *
            300,
        })),
      ),
    });
  };
  return (
    <>
      <TradingViewChart
        className={styles.tradingView}
        series={series}
        timeline={timeline}
        intervalMs={intervalMs}
        hidden={hidden}
        priceFormatter={formatter}
        onSelect={(at) => onSelect(nearestObservation(visual.points, at))}
        onProject={project}
        onReady={(handle) => {
          handle.chart.panes()[0]?.setStretchFactor(4);
          handle.chart.panes()[1]?.setStretchFactor(1);
          handle.chart
            .panes()[1]
            ?.priceScale(VOLUME_SCALE)
            .applyOptions({ scaleMargins: { top: 0.15, bottom: 0 } });
          api.current = handle;
          cancelAnimationFrame(crosshairFrame.current);
          crosshairFrame.current = positionSelection(handle, visual, plotSegments, selected);
          return () => {
            cancelAnimationFrame(crosshairFrame.current);
            api.current = null;
          };
        }}
      />
      <div
        className={styles.activityLayer}
        {...(view
          ? dyn({ width: `${view.width}px`, height: `${view.height}px` })
          : {})}
      >
        <ChartTradeMarkers
          start={view?.start ?? visual.start}
          end={view?.end ?? visual.end}
          segments={view?.segments ?? plotSegments}
          projectTime={view?.projectTime}
        />
      </div>
      {migrationAt !== undefined &&
        view &&
        view.projectTime(migrationAt) !== null && (
          <span
            className={styles.migration}
            data-flip={(1 - view.projectTime(migrationAt)!) * view.width < MIGRATION_LABEL_ROOM_PX || undefined}
            {...dyn({
              left: `${view.projectTime(migrationAt)! * view.width}px`,
              height: `${view.height}px`,
            })}
          >
            <span>Migration</span>
          </span>
        )}
      <ChartFooter
        onReset={() => {
          api.current?.chart
            .priceScale("right")
            .applyOptions({ autoScale: true });
          api.current?.chart.timeScale().fitContent();
        }}
      />
    </>
  );
}

/** UTC under the price scale; Reset view ends the chart card's "On chart" row when the card has one. */
function ChartFooter({ onReset }: Readonly<{ onReset: () => void }>) {
  const slot = useContext(CoinDetailsSlots).reset;
  const reset = (
    <Button variant="ghost" size="xs" onClick={onReset}>
      Reset view
    </Button>
  );
  return (
    <div className={styles.chartFooter} data-reset-moved={slot ? "" : undefined}>
      <span>UTC</span>
      {slot ? createPortal(reset, slot) : reset}
    </div>
  );
}

function positionSelection(
  current: PlotApi | null,
  visual: ChartGeometry,
  segments: readonly (readonly PlacedObservation[])[],
  selected: number | null,
) {
  if (!current) return 0;
  if (selected === null) {
    current.chart.clearCrosshairPosition();
    return 0;
  }
  const point = visual.points[Math.min(selected, visual.points.length - 1)]!;
  const segment = segments.findIndex((points) => points.includes(point));
  const scale = current.chart.timeScale();
  const time = chartTimestamp(point.at);
  const index = scale.timeToIndex(time);
  const range = scale.getVisibleLogicalRange();
  const place = () =>
    current.chart.setCrosshairPosition(
      300 - point.y,
      time,
      current.series[segment]!,
    );
  // Keep an inspected endpoint inside the viewport, including fractional rounding at its edges.
  if (
    range &&
    index !== null &&
    (index < range.from + 1 || index > range.to - 1)
  ) {
    const shift =
      index < range.from + 1 ? index - range.from - 1 : index - range.to + 1;
    scale.setVisibleLogicalRange({
      from: range.from + shift,
      to: range.to + shift,
    });
    return requestAnimationFrame(place);
  }
  place();
  return 0;
}
