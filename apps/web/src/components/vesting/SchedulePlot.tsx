"use client";

import { useMemo, useState } from "react";
import {
  isContinuousLinear,
  type PublicVesting,
} from "@blast/core/modules/vesting/model.ts";
import {
  TradingViewChart,
  type ChartSeries,
  type ChartHandle,
} from "#web/components/charts/TradingViewChart.tsx";
import {
  chartData,
  chartTimestamp,
} from "#web/components/charts/tradingview-model.ts";
import { dyn } from "#web/components/blast-ui/csp-style.ts";
import { vestingChartData } from "./vesting-plot";
import { scheduleLines } from "./schedule-series";
import styles from "./SchedulePlot.module.css";

type Point = Readonly<{ x: number; y: number }>;
type Plot = Readonly<{
  projection: readonly Point[];
  unlocked: readonly Point[];
  current: Point | null;
  next: Point | null;
}>;
const SCALE_MARGINS = { top: 0.04, bottom: 0.04 };
const TIMELINE = Array.from(
  { length: 513 },
  (_, index) => (index / 512) * 1_000_000,
);

export function ReleasePlot({
  data,
  stepped,
}: Readonly<{ data: Plot; stepped: boolean }>) {
  const [overlays, setOverlays] = useState<
    readonly Readonly<{
      key: string;
      x: number;
      y: number;
      height: number;
      kind: string;
    }>[]
  >([]);
  const model = useMemo(() => {
    const projection = scheduleLines(data.projection, stepped);
    const unlocked = scheduleLines(data.unlocked, stepped);
    const build = (points: readonly Point[], dashed: boolean): ChartSeries => ({
      type: "Line",
      data: chartData(
        points.map((point) => ({
          time: chartTimestamp(point.x * 1_000_000),
          value: point.y,
        })),
      ),
      options: {
        color: "var(--pink-ink)",
        lineStyle: dashed ? 2 : 0,
        lineType: stepped ? 1 : 0,
        lastValueVisible: false,
        priceLineVisible: false,
        autoscaleInfoProvider: () => ({
          priceRange: { minValue: 0, maxValue: 1 },
        }),
      },
    });
    return {
      series: [
        ...projection.map((points) => build(points, true)),
        ...unlocked.map((points) => build(points, false)),
      ],
      projection,
      unlocked,
    };
  }, [data, stepped]);
  const project = ({ chart, series }: ChartHandle) => {
    const toPixel = (point: Point) => ({
      x: Number(
        chart.timeScale().timeToCoordinate(chartTimestamp(point.x * 1_000_000)),
      ),
      y: Number(series[0]!.priceToCoordinate(point.y)),
    });
    const shapes: {
      key: string;
      x: number;
      y: number;
      height: number;
      kind: string;
    }[] = [];
    if (!stepped)
      for (const [kind, points] of [
        ["projection", data.projection],
        ["unlocked", data.unlocked],
      ] as const) {
        points.forEach((point, index) => {
          const previous = points[index - 1];
          if (previous && previous.x === point.x && previous.y !== point.y) {
            const top = toPixel(point);
            const bottom = toPixel(previous);
            shapes.push({
              key: `${kind}-${index}`,
              x: top.x,
              y: Math.min(top.y, bottom.y),
              height: Math.abs(top.y - bottom.y),
              kind,
            });
          }
        });
      }
    for (const kind of ["current", "next"] as const) {
      const point = data[kind];
      if (point) {
        const position = toPixel(point);
        shapes.push({ ...position, key: kind, kind, height: 0 });
        if (kind === "current")
          shapes.push({
            key: "now",
            kind: "now",
            x: position.x,
            y: 0,
            height: chart.panes()[0]!.getHeight(),
          });
      }
    }
    setOverlays(shapes);
  };
  return (
    <div className={styles.plot}>
      <TradingViewChart
        series={model.series}
        timeline={TIMELINE}
        compact
        scaleMargins={SCALE_MARGINS}
        onProject={project}
      />
      {overlays.map((shape) => (
        <span
          key={shape.key}
          className={styles.overlay}
          data-kind={shape.kind}
          aria-hidden="true"
          {...dyn({
            left: `${shape.x}px`,
            top: `${shape.y}px`,
            height: `${shape.height}px`,
          })}
        />
      ))}
    </div>
  );
}

export default function SchedulePlot({
  schedule,
  now,
}: Readonly<{ schedule: PublicVesting; now: bigint }>) {
  const data = useMemo(() => vestingChartData(schedule, now), [schedule, now]);
  return data ? (
    <ReleasePlot data={data} stepped={!isContinuousLinear(schedule.terms)} />
  ) : null;
}
