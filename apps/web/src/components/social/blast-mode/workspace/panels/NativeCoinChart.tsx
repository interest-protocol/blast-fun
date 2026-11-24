import { combinedVolumes } from "#web/components/charts/candle-data.ts";
import { shiftDecimal } from "#web/components/launchpad/coin/coin-format.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";
import {
  compareExact,
  exactAtoms,
  exactDecimal,
  groupedExact,
  pxNumExact,
} from "@blast/core/web/exact-amount.ts";
import { PoolCandleChart } from "#web/components/charts/PoolCandleChart.tsx";
import { ChartState } from "./ChartState";
import { CoinDetails } from "./CoinDetails";
import styles from "./CoinPanel.module.css";
import visualStyles from "./CoinChartVisual.module.css";
import { useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { chartVisual, axisPrice, type Observation } from "./chart-visual";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { useMobileChartLayout } from "#web/components/charts/use-mobile-chart-layout.ts";
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { TradingViewPlot } from "./TradingViewPlot";
import {
  chartGeometry,
  type DrawnSeries,
} from "#web/components/launchpad/chart/chart-geometry.ts";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import type { NativeCoinChart as NativeHistory } from "./coin-reads";
import { ChartTradeStatus } from "./ChartTradeMarkers";
import { candleIntervalMs } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { pageTruncated } from "#web/components/launchpad/chart/chart-model.ts";

const observationDateFormatter = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "long",
  timeZone: "UTC",
});

const inspectionTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  timeZone: "UTC",
});

const NATIVE_EMPTY_NOTE = {
  empty: "No trades in this range.",
  unavailable: "Price history unavailable.",
} as const;

function nativeHistoryLimited(history: NativeHistory): boolean {
  const request = history.request;
  if (!request) return false;
  return [history.chart.curve, history.chart.venue].some(
    (section) =>
      section &&
      (section.state === "available" || section.state === "stale") &&
      pageTruncated(section.data, request),
  );
}

function nativeChartData(
  history: NativeHistory,
  chart: PanelSetup["coin"]["chart"],
) {
  const viewport = chart.renderer === "recharts" ? chart.viewport : null;
  const sections = [
    { source: "curve", section: history.chart.curve },
    { source: "venue", section: history.chart.venue },
  ] as const;
  const series: DrawnSeries[] = sections.flatMap(({ source, section }) =>
    section && (section.state === "available" || section.state === "stale")
      ? [
          {
            source,
            page: {
              ...section.data,
              candles: section.data.candles.filter(
                (candle) =>
                  !viewport ||
                  (candle.bucketStart >= viewport.from_ms &&
                    candle.bucketStart <= viewport.to_ms),
              ),
            },
          },
        ]
      : [],
  );
  const latest = sections
    .flatMap(({ section }) =>
      section && (section.state === "available" || section.state === "stale")
        ? section.data.candles
        : [],
    )
    .sort((a, b) => a.bucketStart - b.bucketStart)
    .at(-1);
  const notices = sections.filter(
    ({ section }) =>
      section && (section.state === "stale" || section.state === "unavailable"),
  );
  const { memeDecimals, quoteDecimals } = history.source;
  const places = memeDecimals === null || quoteDecimals === null ? null : memeDecimals - quoteDecimals;
  const emptyState = places === null || notices.length > 0
    ? "unavailable" as const
    : "empty" as const;
  return { viewport, series, latest, notices, places, emptyState };
}

function NativeChartStatus({
  notices,
}: Readonly<{ notices: ReturnType<typeof nativeChartData>["notices"] }>) {
  if (!notices.length) return null;
  return (
    <p className={visualStyles.nativeStatus} role="status">
      {notices.map(({ source, section }) => (
        <span data-stale="true" key={source}>
          {source === "curve" ? "Bonding curve" : "Exchange"} {section!.state === "stale" ? "price updates delayed" : "price history couldn’t load"}
        </span>
      ))}
    </p>
  );
}

/** Pool history in whole-token prices and payment-token volume. */
export function NativeCoinChart({
  history,
  chart,
  onChart,
}: Readonly<{
  history: NativeHistory;
  chart: PanelSetup["coin"]["chart"];
  onChart: (chart: PanelSetup["coin"]["chart"]) => void;
}>) {
  const hidden = useShellPrefs().amountsHidden;
  const { memeDecimals, quoteDecimals, quoteSymbol, symbol } = history.source;
  const units = `${quoteSymbol} per ${symbol}`;
  const { viewport, series, latest, notices, places, emptyState } = useMemo(
    () => nativeChartData(history, chart),
    [history, chart],
  );
  const observations = useMemo(
    () =>
      places === null ? [] : series.flatMap(({ source, page }) =>
        page.candles.map((candle) => ({
          at: candle.bucketStart,
          value: shiftDecimal(candle.close, places),
          source,
          candle: { open: shiftDecimal(candle.open, places), high: shiftDecimal(candle.high, places), low: shiftDecimal(candle.low, places) },
          volume: shiftDecimal(
            candle.volumeQuote.toString(),
            -(history.source.quoteDecimals ?? 0),
          ),
        })),
      ),
    [series, places, history.source.quoteDecimals],
  );
  const interval =
    series[0]?.page.interval ?? history.request?.interval ?? "1m";
  const limited = nativeHistoryLimited(history);
  const geometry = chartGeometry(
    series,
    history.chart.migration,
    undefined,
    null,
  );
  return (
    <>
      <NativePricePlot
        history={history}
        units={units}
        chart={chart}
        observations={observations}
        interval={interval}
        emptyState={emptyState}
      />
      {limited && (
        <p className={visualStyles.coverage} role="status">
          Newest 2,000 candles per pool · use a longer interval for older history.
        </p>
      )}
      <NativeChartStatus notices={notices} />

      <CoinDetails kind="chart" label="View chart values">
        {geometry && places !== null ? (
          <PoolCandleChart
            memeDecimals={memeDecimals}
            quoteDecimals={quoteDecimals}
            sources={series}
            migrationAt={history.chart.migration?.timestampMs}
            label={`${symbol} price and volume, ${interval} intervals`}
          />
        ) : (
          <p>{places === null ? "Price units couldn’t load." : NATIVE_EMPTY_NOTE[emptyState]}</p>
        )}
        <div className={styles.chartContext}>
          <span>
            <strong>Price in {units}</strong> · {interval} intervals
          </span>
          <span className={styles.chartSources}>
            {history.chart.migration && <span>Graduation</span>}
          </span>
        </div>
        <div className={styles.chartPrice}>
          <p className={styles.observedPrice}>
            Last close{" "}
            {hidden ? (
              "••••"
            ) : latest && places !== null ? (
              <InspectValue value={shiftDecimal(latest.close, places)} label={`Close in ${units}`}>
                {pxNumExact(exactDecimal(shiftDecimal(latest.close, places))!)}
              </InspectValue>
            ) : (
              "Unavailable"
            )}
          </p>
        </div>
        <NativeViewportButton chart={chart} zoomed={Boolean(viewport)} geometry={geometry} onChart={onChart} />

        {places === null ? null : series.map(({ source, page }) => (
          <div key={source}>
            <h4>{source === "curve" ? "Bonding curve" : "Exchange pool"}</h4>
            <NativeCandleValues candles={page.candles} hidden={hidden} places={places} units={units} quoteDecimals={quoteDecimals} quoteSymbol={quoteSymbol} />
          </div>
        ))}
      </CoinDetails>
    </>
  );
}

function NativeViewportButton({ chart, zoomed, geometry, onChart }: Readonly<{
  chart: PanelSetup["coin"]["chart"];
  zoomed: boolean;
  geometry: ReturnType<typeof chartGeometry>;
  onChart: (chart: PanelSetup["coin"]["chart"]) => void;
}>) {
  if (!geometry || geometry.start >= geometry.end) return null;
  const { start, end } = geometry;
  return (
    <Button
      variant="ghost"
      size="sm"
      className={styles.pill}
      type="button"
      onClick={() => onChart({
        ...(chart.renderer === "recharts" ? chart : {}),
        renderer: "recharts",
        window: chart.renderer === "recharts" ? chart.window : "24h",
        viewport: zoomed ? null : { from_ms: (start + end) / 2, to_ms: end },
      })}
    >
      {zoomed ? "Show full window" : "Zoom to recent candles"}
    </Button>
  );
}

function NativeCandleValues({
  candles,
  hidden,
  places,
  units,
  quoteDecimals,
  quoteSymbol,
}: Readonly<{
  candles: DrawnSeries["page"]["candles"];
  hidden: boolean;
  places: number;
  units: string;
  quoteDecimals: number | null;
  quoteSymbol: string;
}>) {
  return (
    <ol>
      {candles.map((candle) => (
        <li key={candle.bucketStart}>
          <DateStamp at={candle.bucketStart} clock plain />
          <p>Volume: {hidden ? "••••" : nativeVolume(candle.volumeQuote, quoteDecimals, quoteSymbol)}</p>
          {(["open", "high", "low", "close"] as const).map((field) => {
            const price = shiftDecimal(candle[field], places);
            return <p key={field}>{field}: {hidden ? "••••" : <InspectValue value={price} label={`${field} in ${units}`}>{price}</InspectValue>}</p>;
          })}
        </li>
      ))}
    </ol>
  );
}

function NativePricePlot({
  history,
  chart,
  observations,
  interval,
  emptyState,
  units,
}: Readonly<{
  history: NativeHistory;
  units: string;
  chart: PanelSetup["coin"]["chart"];
  observations: readonly Observation[];
  interval: Parameters<typeof candleIntervalMs>[0];
  emptyState: keyof typeof NATIVE_EMPTY_NOTE;
}>) {
  return (
    <ChartVisual
      key={`${history.source.curvePoolKey}:${history.source.venuePoolKey}:${chart.renderer === "recharts" ? `${chart.window}:${chart.interval}:${JSON.stringify(chart.viewport)}` : "default"}`}
      observations={observations}
      intervalMs={candleIntervalMs(interval)}
      units={units}
      emptyState={emptyState}
      migrationAt={history.chart.migration?.timestampMs}
      label={`${history.source.symbol} price and volume, ${interval} intervals`}
      style={chart.renderer === "recharts" ? chart.style : undefined}
      volume={chart.renderer !== "recharts" || chart.volume !== false}
      volumeUnits={history.source.quoteSymbol}
    />
  );
}

/** One readable frame for native and indexed observations, with no interpolated missing buckets. */
export function ChartVisual({
  observations,
  intervalMs,
  units,
  label,
  emptyState = "unavailable",
  style = "line",
  volume = false,
  volumeUnits = "quote",
  migrationAt,
}: Readonly<{
  observations: readonly Observation[];
  intervalMs: number;
  units: string;
  label: string;
  emptyState?: "empty" | "no-history" | "unavailable";
  style?: "line" | "candles";
  volume?: boolean;
  volumeUnits?: string;
  migrationAt?: number;
}>) {
  const mobile = useMobileChartLayout();
  const hidden = useShellPrefs().amountsHidden;
  const gradient = useId();
  const frameRef = useRef<HTMLDivElement>(null);
  const restoringFocus = useRef(false);
  const [selected, setSelected] = useState<number | null>(null);
  const visual = useMemo(
    () => chartVisual(observations, intervalMs),
    [observations, intervalMs],
  );
  const volumes = useMemo(
    () =>
      combinedVolumes(
        observations
          .filter((point) => point.volume !== undefined)
          .map((point) => ({
            at: point.at,
            volume: point.volume!,
            down: false,
          })),
      ),
    [observations],
  );
  useLayoutEffect(() => {
    if (selected !== null || !restoringFocus.current) return;
    frameRef.current?.focus({ preventScroll: true });
    restoringFocus.current = false;
  }, [selected]);
  if (!visual)
    return (
      <ChartState state={observations.length === 1 ? "sparse" : emptyState} />
    );
  const current =
    selected === null
      ? null
      : visual.points[Math.min(selected, visual.points.length - 1)]!;

  const inspected = current ?? visual.points.at(-1)!;
  return (
    <div
      className={visualStyles.visual}
      data-coin-chart=""
      data-direction={
        compareExact(
          exactDecimal(visual.points.at(-1)!.value)!,
          exactDecimal(visual.points[0]!.value)!,
        ) > 0
          ? "up"
          : compareExact(
                exactDecimal(visual.points.at(-1)!.value)!,
                exactDecimal(visual.points[0]!.value)!,
              ) < 0
            ? "down"
            : "flat"
      }
      onKeyDown={(event) => {
        if (
          event.defaultPrevented ||
          event.key !== "Escape" ||
          selected === null ||
          !event.currentTarget.contains(event.target as Node)
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        restoringFocus.current = true;
        setSelected(null);
      }}
    >
      <span
        id={`${gradient}-instructions`}
        className={visualStyles.instructions}
      >
        Left and right arrows inspect observations. Home and End go to the first
        and last. Escape clears inspection.
      </span>
      <div
        className={visualStyles.readout}
        data-active={current !== null}
        aria-live="polite"
        aria-atomic="true"
      >
        {current ? (
          <>
            {hidden ? (
              "••••"
            ) : (
              <InspectValue
                value={`${new Date(current.at).toISOString()} · ${current.source} · Close ${current.value} ${units}`}
                label="chart observation"
              >
                {axisPrice(current.value)} {units}
              </InspectValue>
            )}
            <time
              dateTime={new Date(current.at).toISOString()}
              title={observationDateFormatter.format(current.at)}
            >
              {inspectionTimeFormatter.format(current.at)} UTC
            </time>
          </>
        ) : (
          <span>{units}</span>
        )}
      </div>
      <CandleReadout
        inspected={inspected}
        hidden={hidden}
        volume={volume}
        units={units}
        volumeUnits={volumeUnits}
        combinedVolume={
          volumes.find((point) => point.at === inspected.at && point.combined)
            ?.volume
        }
      />
      <div
        className={visualStyles.frame}
        ref={frameRef}
        tabIndex={0}
        role="group"
        aria-label="Inspect price history"
        aria-describedby={`${gradient}-instructions`}
        onPointerDown={(event) => {
          if (
            event.target instanceof Element &&
            event.target.closest("button,a")
          )
            return;
          event.currentTarget.focus({ preventScroll: true });
        }}
        onFocus={(event) => {
          if (event.target === event.currentTarget && !restoringFocus.current)
            setSelected(visual.points.length - 1);
        }}
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.target !== event.currentTarget)
            return;
          const index = selected ?? visual.points.length - 1;
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            setSelected(Math.max(0, index - 1));
          }
          if (event.key === "ArrowRight") {
            event.preventDefault();
            setSelected(Math.min(visual.points.length - 1, index + 1));
          }
          if (event.key === "Home") {
            event.preventDefault();
            setSelected(0);
          }
          if (event.key === "End") {
            event.preventDefault();
            setSelected(visual.points.length - 1);
          }
        }}
      >
        <span
          className={visualStyles.instructions}
          role="img"
          aria-label={label}
        >
          Close price in {units}. Missing observations and source changes are
          gaps.
        </span>
        <TradingViewPlot
          visual={visual}
          intervalMs={intervalMs}
          hidden={hidden}
          selected={selected}
          onSelect={setSelected}
          style={mobile ? "line" : style}
          volume={volume}
          migrationAt={migrationAt}
        />
      </div>
      <ChartTradeStatus start={visual.start} end={visual.end} />
    </div>
  );
}

function CandleReadout({
  inspected,
  hidden,
  volume,
  units,
  volumeUnits,
  combinedVolume,
}: Readonly<{
  combinedVolume?: string;
  inspected: Observation;
  hidden: boolean;
  volume: boolean;
  units: string;
  volumeUnits: string;
}>) {
  if (!inspected.candle) return null;
  return (
    <div className={visualStyles.candleReadout} aria-label="Candle values">
      {(
        [
          ["O", inspected.candle.open],
          ["H", inspected.candle.high],
          ["L", inspected.candle.low],
          ["C", inspected.value],
        ] as const
      ).map(([field, value]) => (
        <span key={field}>
          {field}{" "}
          <b>
            {hidden ? (
              "••••"
            ) : (
              <InspectValue
                label={`candle ${field}`}
                value={`${value} ${units}`}
              >
                {axisPrice(value)}
              </InspectValue>
            )}
          </b>
        </span>
      ))}
      {volume && combinedVolume !== undefined && (
        <span>
          Combined vol{" "}
          <b>
            {hidden ? (
              "••••"
            ) : (
              <InspectValue
                label="combined candle volume"
                value={`${combinedVolume} ${volumeUnits}`}
              >
                {axisPrice(combinedVolume)} {volumeUnits}
              </InspectValue>
            )}
          </b>
        </span>
      )}
      {volume && inspected.volume !== undefined && (
        <span>
          {combinedVolume ? "Source vol" : "Vol"}{" "}
          <b>
            {hidden ? (
              "••••"
            ) : (
              <InspectValue
                label="candle volume"
                value={`${inspected.volume} ${volumeUnits}`}
              >
                {axisPrice(inspected.volume)} {volumeUnits}
              </InspectValue>
            )}
          </b>
        </span>
      )}
    </div>
  );
}

function nativeVolume(atoms: bigint, decimals: number | null, symbol: string) {
  const value =
    decimals === null
      ? "Amount unavailable"
      : `${groupedExact(exactAtoms(atoms.toString(), decimals)!, decimals)} ${symbol}`;
  return (
    <InspectValue label="recorded candle volume" value={value}>
      {value}
    </InspectValue>
  );
}
