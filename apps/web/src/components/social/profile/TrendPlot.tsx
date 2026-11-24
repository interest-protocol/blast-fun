"use client";
import { useMemo } from "react";
import {
  TradingViewChart,
  type ChartSeries,
} from "#web/components/charts/TradingViewChart.tsx";
import {
  chartData,
  elapsedTimeScale,
} from "#web/components/charts/tradingview-model.ts";
import type { PortfolioTrendView } from "./portfolio-trend";

export default function TrendPlot({
  trend,
}: Readonly<{ trend: PortfolioTrendView }>) {
  const time = useMemo(
    () => elapsedTimeScale(trend.points.map((point) => point.at_ms)),
    [trend],
  );
  const series = useMemo<readonly ChartSeries[]>(
    () => [
      {
        type: "Area",
        data: chartData(
          trend.points.map((point) => ({
            time: time.timestamp(point.at_ms),
            value: point.usd,
          })),
        ),
        options: {
          lineColor: "rgba(255,255,255,.7)",
          topColor: "rgba(255,255,255,.22)",
          bottomColor: "rgba(255,255,255,0)",
        },
      },
    ],
    [trend, time],
  );
  return <TradingViewChart series={series} timeline={time.timeline} compact />;
}
