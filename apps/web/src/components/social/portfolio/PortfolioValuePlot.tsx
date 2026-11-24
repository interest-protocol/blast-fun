"use client";

import { useMemo } from "react";

import { TradingViewChart, type ChartSeries } from "#web/components/charts/TradingViewChart.tsx";
import { chartData, elapsedTimeScale } from "#web/components/charts/tradingview-model.ts";

import type { PortfolioTrendView } from "../profile/portfolio-trend";

/**
 * The hero's value line over a range (the Portfolio board's area chart): a
 * compact TradingView area in its host's text colour, which the hero sets to
 * `--up` or `--down` by the range's move, with the shared soft fill under it.
 */
export default function PortfolioValuePlot({ trend }: Readonly<{ trend: PortfolioTrendView }>) {
  const time = useMemo(() => elapsedTimeScale(trend.points.map((point) => point.at_ms)), [trend]);
  const series = useMemo<readonly ChartSeries[]>(() => [{
    type: "Area",
    data: chartData(trend.points.map((point) => ({ time: time.timestamp(point.at_ms), value: point.usd }))),
    options: { lineWidth: 2, lastValueVisible: false, priceLineVisible: false },
  }], [trend, time]);
  return <TradingViewChart compact series={series} timeline={time.timeline} />;
}
