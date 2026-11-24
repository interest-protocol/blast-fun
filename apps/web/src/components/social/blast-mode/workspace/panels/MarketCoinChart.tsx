import { useMemo } from "react";
import { candleIntervalMs } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { shiftDecimal } from "#web/components/launchpad/coin/coin-format.ts";
import { ChartVisual } from "./NativeCoinChart";
import { ChartState } from "./ChartState";
import type { MarketCoinHistory } from "./coin-market-history";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import styles from "./CoinChartVisual.module.css";

export function MarketCoinChart({
  history,
  chart,
}: Readonly<{
  history: MarketCoinHistory;
  chart: PanelSetup["coin"]["chart"];
}>) {
  const viewport = chart.renderer === "recharts" ? chart.viewport : null;
  const { decimals, quoteDecimals } = history;
  const observations = useMemo(() => {
    if (decimals === null || quoteDecimals === null) return [];
    const shift = decimals - quoteDecimals;
    const price = (value: string) => shiftDecimal(value, shift);
    return history.page.candles
      .filter(
        (candle) =>
          !viewport ||
          (candle.bucketStart >= viewport.from_ms &&
            candle.bucketStart <= viewport.to_ms),
      )
      .map((candle) => ({
        at: candle.bucketStart,
        value: price(candle.close),
        source: "swaps",
        candle: {
          open: price(candle.open),
          high: price(candle.high),
          low: price(candle.low),
        },
        volume: shiftDecimal(
          candle.volumeQuote.toString(),
          -quoteDecimals,
        ),
      }));
  }, [history.page.candles, decimals, quoteDecimals, viewport]);
  if (decimals === null || quoteDecimals === null) return <ChartState state="unavailable" />;
  return (
    <>
      <ChartVisual
        key={`${history.coin_type}:${chart.renderer === "recharts" ? chart.window : "24h"}:${history.page.interval}:${JSON.stringify(viewport)}`}
        migrationAt={history.page.migration?.timestampMs}
        observations={observations}
        intervalMs={candleIntervalMs(history.page.interval)}
        units="Payment token per coin"
        label="Recorded swap price and volume"
        style={chart.renderer === "recharts" ? chart.style : undefined}
        volume={chart.renderer !== "recharts" || chart.volume !== false}
        volumeUnits="payment tokens"
        emptyState={chart.renderer === "recharts" && chart.window === "launch" && !viewport ? "no-history" : "empty"}
      />
      {history.stale && (
        <p className={styles.coverage} role="status">
          Price updates delayed.
        </p>
      )}
      {history.request.capped &&
        history.page.candles.length >= (history.request.limit ?? 2000) && (
          <p className={styles.coverage} role="status">
            Newest 2,000 candles · use a longer interval for older history.
          </p>
        )}
    </>
  );
}
