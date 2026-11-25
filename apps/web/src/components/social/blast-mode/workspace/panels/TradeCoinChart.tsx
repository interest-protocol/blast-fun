import { useMemo } from "react";
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { candleIntervalMs } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import type { TradeCoinHistory } from "./trade-coin-history";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { ChartVisual } from "./NativeCoinChart";
import { CoinDetails } from "./CoinDetails";
import { ChartState } from "./ChartState";
import styles from "./CoinChartVisual.module.css";

export function TradeCoinChart({
  history,
  chart,
  retry,
}: Readonly<{
  history: TradeCoinHistory;
  chart: PanelSetup["coin"]["chart"];
  retry?: () => void;
}>) {
  const { page } = history;
  const poolSwaps = page.source === "chain_pool_swaps";
  const viewport = chart.renderer === "recharts" ? chart.viewport : null;
  const observations = useMemo(
    () =>
      page.candles
        .filter(
          (candle) =>
            !viewport ||
            (candle.at_ms >= viewport.from_ms &&
              candle.at_ms <= viewport.to_ms),
        )
        .map((candle) => ({
          at: candle.at_ms,
          value: candle.close,
          source: poolSwaps ? "migration pool swaps" : "transaction balances",
          candle: { open: candle.open, high: candle.high, low: candle.low },
          volume: candle.volume,
        })),
    [page.candles, viewport, poolSwaps],
  );
  if (page.status === "unavailable")
    return <ChartState state="error" retry={retry} />;
  if (page.status === "too_many_trades")
    return <p className={styles.coverage} role="status">Too many trades in this range. Choose a shorter range to load complete candles.</p>;
  if (page.status !== "available") return <ChartState state="unavailable" />;
  const quote = page.quote!.symbol;
  return (
    <>
      <ChartVisual
        key={`${page.coin_type}:${page.window}:${page.interval}:${JSON.stringify(viewport)}`}
        observations={observations}
        intervalMs={candleIntervalMs(page.interval)}
        units={`${quote} / coin`}
        label={
          poolSwaps
            ? "Migration pool price and volume"
            : "Recorded transaction price and volume"
        }
        style={chart.renderer === "recharts" ? chart.style : undefined}
        volume={chart.renderer !== "recharts" || chart.volume !== false}
        volumeUnits={quote}
        emptyState={page.window === "launch" && !viewport ? "no-history" : "empty"}
      />
      <TradeChartCoverage page={page} poolSwaps={poolSwaps} />
      <CoinDetails kind="chart" label="Chart details">
        <p>
          {poolSwaps
            ? "Migration pool trades"
            : "Trades estimated from wallet balance changes"}{" "}
          · {page.interval} candles · volume in {quote}.{" "}
          {poolSwaps
            ? "Prices and volume use individual swaps in this coin’s migration pool. Trading in other pools is excluded. Swap amounts include pool fees; Aftermath input amounts exclude protocol and DAO fees."
            : "Prices and volume reflect wallet balance changes. Trades involving multiple tracked tokens are excluded."}{" "}
          Intervals without trades remain gaps.
        </p>
      </CoinDetails>
    </>
  );
}

function TradeChartCoverage({ page, poolSwaps }: Readonly<{ page: TradeCoinHistory["page"]; poolSwaps: boolean }>) {
  const lastCandle = page.candles.at(-1);
  return <>
      {lastCandle && (
        <p className={styles.coverage}>
          Last candle{" "}
          <DateStamp at={lastCandle.at_ms} label="last candle time" />
        </p>
      )}
      {page.as_of.lag_ms > 60_000 && (
        <p className={styles.coverage} role="status">
          Market data is delayed. Showing the last recorded candles.
        </p>
      )}
      {page.excluded_trades > 0 && (
        <p className={styles.coverage} role="status">
          Partial coverage: {page.excluded_trades}{" "}
          {poolSwaps
            ? "swaps have incomplete or mismatched amounts."
            : "trades involve multiple tokens, another quote currency, or incomplete amounts."}
        </p>
      )}
      {page.truncated && (
        <p className={styles.coverage} role="status">
          Showing the newest 2,000 candles. Choose a longer interval to see more
          history.
        </p>
      )}
    </>;
}
