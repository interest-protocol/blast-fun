"use client";

import { useMemo } from "react";

import { TradingViewChart, type ChartSeries } from "#web/components/charts/TradingViewChart.tsx";
import { chartData, sparkTimeScale } from "#web/components/charts/tradingview-model.ts";
import type { SparkPoint } from "#web/components/charts/spark-model.ts";
import { ClientOnly } from "#web/components/ui-libraries/use-hydrated.tsx";

/**
 * Home's sparklines (the Coins table's Trend column): the shared
 * TradingView chart, compact, filling the slot its stylesheet sizes in rem
 * (so it keeps the board's proportions at every width), in the slot's text
 * colour. An empty or
 * one-point history draws nothing; the slot keeps its size.
 */
export function HomeSpark({ points, className, slot, title }: Readonly<{
  points: readonly SparkPoint[] | null | undefined;
  className?: string;
  title?: string;
  /** `data-slot`, for tests and the browser check. */
  slot?: string;
}>) {
  return (
    <span aria-hidden="true" className={className} data-slot={slot} title={title}>
      {points && points.length >= 2 ? <ClientOnly><SparkPlot points={points} /></ClientOnly> : null}
    </span>
  );
}

function SparkPlot({ points }: Readonly<{ points: readonly SparkPoint[] }>) {
  const first = points[0]![0];
  const last = points[points.length - 1]![0];
  const time = useMemo(() => sparkTimeScale(first, last), [first, last]);
  const series = useMemo<readonly ChartSeries[]>(() => {
    const data = chartData(points.map(([at, value]) => ({ time: time.timestamp(at), value })));
    const options = { lineWidth: 2 as const, lastValueVisible: false, priceLineVisible: false };
    return [{ type: "Line", data, options }];
  }, [points, time]);
  return <TradingViewChart compact livePool series={series} timeline={time.timeline} />;
}
