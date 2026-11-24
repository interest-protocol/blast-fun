"use client";

import clsx from "clsx";
import { useMemo } from "react";
import { TradingViewChart, type ChartSeries } from "./TradingViewChart";
import {
  chartData,
  elapsedTimeScale,
} from "./tradingview-model";
import { sparkUp, type SparkPoint } from "./spark-model";
import { dyn } from "#web/components/blast-ui/csp-style.ts";
import styles from "./Charts.module.css";

export default function SparklinePlot({
  points,
  width,
  height,
  fill = false,
  up,
  ink = false,
}: Readonly<{
  points: readonly SparkPoint[];
  width: number;
  height: number;
  fill?: boolean;
  up?: boolean;
  ink?: boolean;
}>) {
  const time = useMemo(
    () => elapsedTimeScale(points.map(([at]) => at)),
    [points],
  );
  const series = useMemo<readonly ChartSeries[]>(
    () => [
      {
        type: "Line",
        data: chartData(
          points.map(([at, value]) => ({ time: time.timestamp(at), value })),
        ),
        options: {
          lineWidth: 2,
          lastValueVisible: false,
          priceLineVisible: false,
        },
      },
    ],
    [points, time],
  );
  const tone = ink ? "ink" : (up ?? sparkUp(points)) ? "up" : "down";
  return (
    <span
      className={clsx(styles.spark, styles[tone])}
      {...dyn({ width: fill ? "100%" : `${width}px`, height: `${height}px` })}
    >
      <TradingViewChart series={series} timeline={time.timeline} compact />
    </span>
  );
}
