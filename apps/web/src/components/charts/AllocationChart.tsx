"use client";
import { useMemo } from "react";
import { TradingViewChart, type ChartSeries } from "./TradingViewChart";
import { chartTimestamp } from "./tradingview-model";

export function AllocationChart({
  parts,
}: Readonly<{ parts: readonly Readonly<{ bps: number; color: string }>[] }>) {
  const series = useMemo<readonly ChartSeries[]>(
    () => [
      {
        type: "Histogram",
        data: parts.map((part, index) => ({
          time: chartTimestamp(index * 1000),
          value: part.bps,
          color: part.color,
        })),
        options: {
          base: 0,
          autoscaleInfoProvider: () => ({
            priceRange: { minValue: 0, maxValue: 10_000 },
          }),
        },
      },
    ],
    [parts],
  );
  return (
    <TradingViewChart
      series={series}
      compact
      label="Token allocation shares; categories and exact percentages are listed below"
    />
  );
}
