"use client";

import { useMemo, useState } from "react";
import { Button } from "../../../src/components/blast-ui/Button.tsx";
import { setShellPref } from "../../../src/components/blast-ui/use-shell-prefs.ts";
import { ChartVisual } from "../../../src/components/social/blast-mode/workspace/panels/NativeCoinChart.tsx";
import { ChartTradesContext } from "../../../src/components/social/blast-mode/workspace/panels/chart-trades-context.ts";
import {
  DEFAULT_TRADE_FILTERS,
  filterChartTrades,
} from "../../../src/components/social/blast-mode/workspace/panels/chart-trades.ts";
import theme from "../../../src/components/social/blast-mode/workspace/WorkspaceTheme.module.css";
import { denseChartHistory } from "./coin-fixtures";
import { chartTradesFixture } from "./chart-trades-fixture";

/** Test data only: canvas projection, privacy and retained-panel lifecycle. */
export function TradingViewFixture() {
  const [mode, setMode] = useState("dense");
  const [shown, setShown] = useState(true);
  const observations = useMemo(() => {
    const data = denseChartHistory("coin", "24h").points;
    if (mode === "single")
      return [
        { at: data[0]![0], value: "0.00000000000000000001", source: "curve" },
      ];
    if (mode === "tight")
      return ["1.00000000000000000001", "1.00000000000000000002"].map(
        (value, index) => ({ at: data[index]![0], value, source: "curve" }),
      );
    if (mode === "duplicates")
      return data.slice(0, 4).flatMap(([at, value]) => [
        { at, value, source: "curve" },
        { at, value: `${value}1`, source: "venue" },
      ]);
    return data.flatMap(([at, value], index) =>
      mode === "gaps" && index > 70 && index < 150
        ? []
        : [
            {
              at,
              value,
              source: mode === "gaps" && index >= 180 ? "venue" : "curve",
            },
          ],
    );
  }, [mode]);
  const trades = useMemo(() => {
    const rows = filterChartTrades(
      chartTradesFixture("coin").participants,
      DEFAULT_TRADE_FILTERS,
      new Set(["maralin", "inesduarte"]),
      new Map(),
      () => true,
    );
    const start = observations[0]!.at;
    const end = observations.at(-1)!.at;
    return rows.map((row, index) => ({
      ...row,
      event: {
        ...row.event,
        occurred_at_ms:
          start +
          (end - start) * [0.12, 0.2, 0.35, 0.55, 0.75, 0.85][index % 6]!,
      },
    }));
  }, [observations]);
  return (
    <div data-blast-ui="" data-theme="light">
      <div
        className={theme.theme}
        style={{ padding: 16, background: "var(--bg)", minHeight: "100vh" }}
      >
        <p>TradingView verification · synthetic data · no transactions</p>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {["dense", "gaps", "single", "tight", "duplicates"].map((value) => (
            <Button key={value} size="sm" onClick={() => setMode(value)}>
              {value}
            </Button>
          ))}
          <Button size="sm" onClick={() => setShellPref("amountsHidden", true)}>
            Hide prices
          </Button>
          <Button
            size="sm"
            onClick={() => setShellPref("amountsHidden", false)}
          >
            Show prices
          </Button>
          <Button size="sm" onClick={() => setShellPref("theme", "dark")}>
            Dark theme
          </Button>
          <Button size="sm" onClick={() => setShellPref("theme", "light")}>
            Light theme
          </Button>
          <Button size="sm" onClick={() => setShown(!shown)}>
            Toggle panel
          </Button>
        </div>
        <div
          style={{
            display: shown ? "flex" : "none",
            flexDirection: "column",
            height: 420,
            marginTop: 16,
            padding: 16,
            borderRadius: 16,
            background: "var(--card)",
          }}
        >
          <ChartTradesContext
            value={{
              trades,
              coin: null,
              enabled: true,
              notice: null,
              partial: false,
              ready: true,
              window: "24h",
            }}
          >
            <ChartVisual
              observations={observations}
              intervalMs={360_000}
              units="USD"
              label="TradingView test price"
            />
          </ChartTradesContext>
        </div>
      </div>
    </div>
  );
}
