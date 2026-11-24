"use client";
import { useState } from "react";
import { setShellPref } from "../../../src/components/blast-ui/use-shell-prefs.ts";
import { Button } from "../../../src/components/blast-ui/Button.tsx";
import { Sparkline } from "../../../src/components/charts/Sparkline.tsx";
import { AllocationChart } from "../../../src/components/charts/AllocationChart.tsx";
import { PoolCandleChart } from "../../../src/components/charts/PoolCandleChart.tsx";
import TrendPlot from "../../../src/components/social/profile/TrendPlot.tsx";
import SalePricePlot from "../../../src/components/presale-pages/SalePricePlot.tsx";
import { RaiseChart } from "../../../src/components/presale-pages/RaiseChart.tsx";
import type { PublicVesting } from "@blast/core/modules/vesting/model.ts";
import { vestingChartData } from "../../../src/components/vesting/vesting-plot.ts";
import { ReleasePlot } from "../../../src/components/vesting/SchedulePlot.tsx";
import {
  FIXTURE_NOW,
  fixtureDetail,
} from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import type { PoolCandlePage } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import theme from "../../../src/components/social/blast-mode/workspace/WorkspaceTheme.module.css";
const start = 1790337600000;
const spark = [
  [start, 1],
  [start + 60_000, 2],
  [start + 86400_000, 1.5],
] as const;
const prices = spark.map(([at, value]) => [at, String(value * 0.001)] as const);
const parts = [
  { bps: 7000, color: "var(--pink)" },
  { bps: 2000, color: "#8b5cf6" },
  { bps: 1000, color: "var(--muted)" },
];
const trend = {
  points: spark.map(([at_ms, usd]) => ({ at_ms, usd })),
  changeBps: "5000",
};
const detail = fixtureDetail("mrdn");
const checkpointSchedule: PublicVesting = {
  schedule_id: "0x1",
  coin_type: "0x2::sui::SUI",
  beneficiary: "0x2",
  creator: null,
  total: "100",
  released: "0",
  refunded: "0",
  refund_recipient: null,
  cancel_cap_id: null,
  terms: {
    kind: "checkpoints",
    checkpoints: [
      { timestamp_ms: "1000", cumulative_amount: "10" },
      { timestamp_ms: "1250", cumulative_amount: "25" },
      { timestamp_ms: "1750", cumulative_amount: "70" },
      { timestamp_ms: "2000", cumulative_amount: "100" },
    ],
  },
  status: "active",
  created_timestamp_ms: null,
  created_digest: null,
  coin_name: null,
  coin_symbol: "SUI",
  coin_decimals: 9,
  coin_icon_url: null,
  indexed: true,
};
const steppedSchedule = vestingChartData(checkpointSchedule, 1500n)!;
const schedule = vestingChartData(
  {
    ...checkpointSchedule,
    terms: {
      kind: "linear",
      start_ms: "1000",
      cliff_ms: "250",
      period_ms: "1",
      periods: "1000",
    },
  },
  1500n,
)!;
const page: PoolCandlePage = {
  poolKey: "blast_curve:synthetic",
  source: "curve",
  venue: "blast_curve",
  interval: "1s",
  migration: null,
  candles: [0, 1, 4, 5, 7].map((i) => ({
    bucketStart: start + i * 1000,
    open: "0.0025",
    high: "0.004",
    low: "0.002",
    close: i % 2 ? "0.0022" : "0.0035",
    volumeQuote: BigInt(i + 1) * 1000000000n,
    volumeMeme: 1n,
    volumeUsd: null,
    buys: 1,
    sells: 1,
    trades: 2,
  })),
};
const sources = [
  {
    source: "curve" as const,
    page: { ...page, candles: page.candles.slice(0, 3) },
  },
  {
    source: "venue" as const,
    page: {
      ...page,
      poolKey: "cetus:synthetic",
      source: "venue" as const,
      venue: "cetus" as const,
      candles: page.candles
        .slice(3)
        .map((candle) => ({
          ...candle,
          bucketStart: candle.bucketStart + 1000,
        })),
    },
  },
];
const proofMarks = [
  {
    t: detail.raise.points[10]![0],
    usd: 250,
    who: "Synthetic backer",
    person: null,
    why: null,
    kind: "mine" as const,
    rank: 0 as const,
  },
];
const noMarks: typeof proofMarks = [];
export function SharedChartsFixture() {
  const [tick, setTick] = useState(0);
  const [markersShown, setMarkersShown] = useState(true);
  return (
    <div data-blast-ui="" data-theme="light">
      <div
        className={theme.theme}
        style={{
          padding: 16,
          background: "var(--bg)",
          color: "var(--ink)",
          minHeight: "100vh",
        }}
      >
        <h1>Shared TradingView verification</h1>
        <p>Synthetic data · no transactions · render {tick}</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          <Button onClick={() => setShellPref("theme", "light")}>
            Light theme
          </Button>
          <Button onClick={() => setShellPref("theme", "dark")}>
            Dark theme
          </Button>
          <Button onClick={() => setShellPref("amountsHidden", true)}>
            Hide prices
          </Button>
          <Button onClick={() => setShellPref("amountsHidden", false)}>
            Show prices
          </Button>
          <Button onClick={() => setTick(tick + 1)}>Unrelated render</Button>
        </div>
        <section data-proof="sparks">
          <h2>Compact charts</h2>
          <Sparkline points={spark} width={120} height={28} />
          <Sparkline points={spark} width={89} height={28} up={false} />
          <Sparkline points={null} width={120} height={28} />
        </section>
        <section
          data-proof="trend"
          style={{ height: 140, background: "#bd971f" }}
        >
          <h2>Portfolio trend</h2>
          <div style={{ height: 90 }}>
            <TrendPlot trend={trend} />
          </div>
        </section>
        <section data-proof="sale">
          <h2>Indexed sale price · USD</h2>
          <div style={{ height: 240 }}>
            <SalePricePlot points={prices} />
          </div>
        </section>
        <section data-proof="raise">
          <h2>Cumulative raise</h2>
          <Button onClick={() => setMarkersShown(!markersShown)}>
            Toggle funding markers
          </Button>
          <RaiseChart
            detail={detail}
            nowMs={FIXTURE_NOW + tick * 1000}
            marks={markersShown ? proofMarks : noMarks}
            overlays={{ mine: true, following: true, big: true, thesis: false }}
          />
        </section>
        <section data-proof="candles">
          <h2>Native 1s OHLC and volume · SUI</h2>
          <PoolCandleChart
            sources={sources}
            migrationAt={start + 5500}
            memeDecimals={6}
            quoteDecimals={9}
          />
        </section>
        <section data-proof="continuous">
          <h2>Continuous vesting with a cliff</h2>
          <div style={{ height: 184 }}>
            <ReleasePlot data={schedule} stepped={false} />
          </div>
        </section>
        <section data-proof="stepped">
          <h2>Stepped vesting</h2>
          <div style={{ height: 184 }}>
            <ReleasePlot data={steppedSchedule} stepped />
          </div>
        </section>
        <section data-proof="allocation">
          <h2>Token allocation</h2>
          <div style={{ height: 192 }}>
            <AllocationChart parts={parts} />
          </div>
          <p>Buyers 70% · Pool 20% · Blast 10%</p>
        </section>
        <a href="https://www.tradingview.com/">Charts by TradingView</a>
      </div>
    </div>
  );
}
