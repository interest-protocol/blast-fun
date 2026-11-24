"use client";
import { useMemo } from "react";
import type { PricePoint } from "@blast/core/web/contracts/prices.ts";
import {
  TradingViewChart,
  type ChartSeries,
} from "#web/components/charts/TradingViewChart.tsx";
import {
  chartData,
  elapsedTimeScale,
} from "#web/components/charts/tradingview-model.ts";
import { exactChartScale } from "#web/components/charts/exact-chart-scale.ts";

export default function SalePricePlot({
  points,
  quoteSymbol,
}: Readonly<{ points: readonly PricePoint[]; quoteSymbol?: string }>) {
  const scale = useMemo(
    () => exactChartScale(points.map(([, value]) => value)),
    [points],
  );
  const time = useMemo(
    () => elapsedTimeScale(points.map(([at]) => at)),
    [points],
  );
  const series = useMemo<readonly ChartSeries[]>(
    () => [
      {
        type: "Area",
        data: chartData(
          points.map(([at, value]) => ({
            time: time.timestamp(at),
            value: scale.coordinate(value),
          })),
        ),
        // No colour of its own: the line follows the price move (green up, red down), as the Coin board draws it.
        options: {
          autoscaleInfoProvider: () => ({
            priceRange: { minValue: 0, maxValue: 100 },
          }),
        },
      },
    ],
    [points, scale, time],
  );
  return (
    <TradingViewChart
      series={series}
      timeline={time.timeline}
      priceFormatter={scale.format}
      label={`Observed pool price in ${quoteSymbol ?? "USD"}`}
    />
  );
}
