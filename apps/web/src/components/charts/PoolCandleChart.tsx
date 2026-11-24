"use client";

import type { DrawnSeries } from "#web/components/launchpad/chart/chart-geometry.ts";

import type { AutoscaleInfoProvider } from "lightweight-charts";
import { shortUtcDate } from "#web/components/blast-ui/date-label.ts";

import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { candleIntervalMs } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import {
  MIGRATION_LABEL_ROOM_PX,
  TradingViewChart,
  VOLUME_SCALE,
  type ChartSeries,
  type ChartHandle,
} from "./TradingViewChart";
import { exactChartScale } from "./exact-chart-scale";
import { chartData, chartTimestamp } from "./tradingview-model";
import { Button, IconButton } from "#web/components/blast-ui/Button.tsx";
import { Switch } from "#web/components/blast-ui/Checkbox.tsx";
import { InfoIcon } from "#web/components/blast-ui/Icons.tsx";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import { comparePrices } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { dyn } from "#web/components/blast-ui/csp-style.ts";
import { shiftDecimal } from "#web/components/launchpad/coin/coin-format.ts";
import { chartPrice } from "./chart-price";
import styles from "./PoolCandleChart.module.css";
import { candleTradeLabel, mountCandleTrade, projectCandleTrade, type CandleTrade } from "./candle-trade.ts";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { combinedVolumes, lineCloseTime, poolLinePoints, poolPrices, sourceLineBounds } from "./candle-data";
import { migrationCaptionOffset, type ExactCandle, type ExactSeries } from "./chart-inspection-model";
import { useChartInspection } from "./use-chart-inspection";
import { useMobileChartLayout } from "./use-mobile-chart-layout";

import { saveChartPreference, useChartPreference } from "#web/components/launchpad/chart/chart-preferences.ts";
import { walletMarkerBadges, walletMarkers, type PlottedWalletMarker, type WalletChartTrade, type WalletRipple } from "./wallet-markers";
import { WalletChartMarkers, WalletMarkerRipple } from "./WalletChartMarkers";

const NO_WALLET_TRADES: readonly WalletChartTrade[] = [];
const coarsePointerQuery = "(pointer: coarse)";

function subscribeCoarsePointer(onChange: () => void) {
  const query = matchMedia(coarsePointerQuery);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

type Source = DrawnSeries;
function poolTimeline(sources: readonly Source[], intervalMs: number, from?: number, to?: number, migrationAt?: number) {
  const timestamps = sources.flatMap(({ page }) =>
    page.candles.map((candle) => candle.bucketStart),
  );
  const start = from ?? Math.min(...timestamps);
  const end = to ?? Math.max(...timestamps);
  const step = Math.max(intervalMs, (end - start) / 4000);
  const timeline: number[] = [];
  if (Number.isFinite(start) && Number.isFinite(end))
    for (let at = start; at <= end; at += step) timeline.push(at);
  if (migrationAt !== undefined && migrationAt >= start && migrationAt <= end)
    timeline.push(migrationAt);
  return timeline;
}

const CHART_STYLES = [["line", "Line"], ["candles", "Candles"]] as const;
export function PoolCandleChart({
  sources,
  compact = false,
  rollingWindow,
  presentation,
  migrationAt,
  migrationLabel = "Migration",
  quoteSymbol,
  from,
  to,
  label = "Price and volume chart",
  memeDecimals = null,
  quoteDecimals = null,
  quoteUsd = null,
  trade,
  walletTrades,
  ripple,
  preview,
}: Readonly<{
  walletTrades?: readonly WalletChartTrade[];
  ripple?: WalletRipple | null;
  sources: readonly Source[];
  trade?: CandleTrade | null;
  compact?: boolean;
  rollingWindow?: boolean;
  /** A compact host owns its single visible style control. */
  presentation?: "line" | "candles";
  migrationAt?: number;
  migrationLabel?: ReactNode;
  quoteSymbol?: string;
  from?: number;
  to?: number;
  label?: string;
  memeDecimals?: number | null;
  quoteDecimals?: number | null;
  quoteUsd?: string | null;
  preview?: ReactNode;
}>) {
  const [localMode, setMode] = useState<"line" | "candles">("candles");
  const [localVolume, setShowVolume] = useState(true);
  const mobile = useMobileChartLayout();
  const mode = mobile ? "line" : presentation ?? localMode;
  const showVolume = presentation ? mode === "candles" : localVolume;
  const { showWalletTags, setWalletTags } = useWalletTags();
  const { amountsHidden } = useShellPrefs();
  const { priceAt, observe } = useChartInspection();
  const labels = usePoolLabels(compact, showVolume, migrationAt);
  const model = useMemo(
    () => poolChartModel({ sources, migrationAt, from, to, rollingWindow, memeDecimals, quoteDecimals, quoteUsd, mode, showVolume, compact, walletTrades: walletTrades ?? NO_WALLET_TRADES }),
    [sources, migrationAt, from, to, rollingWindow, memeDecimals, quoteDecimals, quoteUsd, mode, showVolume, compact, walletTrades],
  );
  const inspectedPrice = priceAt(model.pointPrices, model.pointVolumes, mode, amountsHidden);
  const guide = inspectedPrice?.guide;
  const tradeLabel = candleTradeLabel(trade, sources, memeDecimals, amountsHidden);
  const tradeAt = tradeLabel ? tradePlotTime(sources[tradeLabel.index]!, tradeLabel.bucketStart, mode, migrationAt) : undefined;
  const { mountTrade, projectTrade, tradeKey } = useTradeOverlay(tradeLabel, tradeAt);
  const { badges, touch, projectWalletMarkers } = useWalletChartBadges(model.markers);
  const showMarkers = showWalletTags && model.markers.length > 0;
  const project = (handle: ChartHandle, settled: boolean) => {
    projectWalletMarkers(handle);
    labels.projectLabels(handle.chart);
    projectTrade(handle, model.series, settled);
  };
  const walletToggle = <WalletTagsToggle available={Boolean(walletTrades)} checked={showWalletTags} onChange={setWalletTags} />;
  const readout = { compact, plotMode: mode, hidden: amountsHidden, inspected: inspectedPrice, model, quoteSymbol, walletToggle };
  return (
    <>
      <PoolChartControls compact={compact} mobile={mobile} mode={mode} onModeChange={setMode} showVolume={showVolume} onToggleVolume={() => setShowVolume((value) => !value)} />
      <div data-chart-stage="">
        <PoolReadout {...readout} mode="line" preview={preview} />
        <div className={styles.plot} data-coin-plot={compact || undefined}>
          <TradingViewChart
            coinAxes={compact}
            latestPrice={model.latestTag}
            livePool
            rollingWindow={rollingWindow}
            series={model.series}
            intervalMs={model.intervalMs}
            timeline={model.timeline}
            priceFormatter={model.format}
            label={label}
            preview={preview}
            onProject={project}
            projectionKey={`${touch}:${tradeKey}`}
            onReady={({ chart, host, series: drawn }) => {
              configurePoolPanes(chart);
              if (compact) return observe(chart, host, drawn, mode);
            }}
          />
          <WalletMarkerRipple badges={badges} ripple={showMarkers ? ripple : null} />
          {showMarkers && <WalletChartMarkers badges={badges} />}
          <PoolPlotLabels labels={labels} volumeUnit={compact && showVolume ? quoteSymbol : undefined} guide={guide} migrationLabel={migrationLabel} />
          <span ref={mountTrade} className={styles.tradePosition} aria-hidden="true" hidden>
            <span className={styles.tradeAmount} />
          </span>
        </div>
        <PoolReadout {...readout} mode="candles" />
        {!compact && walletToggle}
      </div>
    </>
  );
}

function WalletTagsToggle({ available, checked, onChange }: Readonly<{ available: boolean; checked: boolean; onChange: (checked: boolean) => void }>) {
  if (!available) return null;
  return <label className={styles.walletToggle}>
    Wallet tags
    <Switch checked={checked} onCheckedChange={onChange} />
  </label>;
}

function PoolChartControls({ compact, mobile, mode, onModeChange, showVolume, onToggleVolume }: Readonly<{
  compact: boolean;
  mobile: boolean;
  mode: "line" | "candles";
  onModeChange: (mode: "line" | "candles") => void;
  showVolume: boolean;
  onToggleVolume: () => void;
}>) {
  if (compact) return null;
  return <div className={styles.controls} role="group" aria-label="Price chart controls">
    {!mobile && <Segmented label="Chart style" options={CHART_STYLES} value={mode} onChange={onModeChange} size="sm" />}
    <Button variant="ghost" size="sm" aria-pressed={showVolume} onClick={onToggleVolume}>
      Volume
    </Button>
  </div>;
}

function useWalletTags() {
  const stored = useChartPreference("wallet-tags");
  const [selected, setSelected] = useState<boolean>();
  function setWalletTags(visible: boolean) {
    setSelected(visible);
    saveChartPreference("wallet-tags", visible ? "shown" : "hidden");
  }
  return { showWalletTags: selected ?? stored !== "hidden", setWalletTags };
}

function PoolPlotLabels({ labels, volumeUnit, guide, migrationLabel }: Readonly<{
  labels: ReturnType<typeof usePoolLabels>;
  volumeUnit?: string;
  guide?: Readonly<{ x: number; height: number }>;
  migrationLabel: ReactNode;
}>) {
  const { volumeTop, marker, markerLabel } = labels;
  return <>
    {volumeUnit && volumeTop > 0 && <span className={styles.volumeLabel} {...dyn({ top: volumeTop })}>Volume · {volumeUnit}</span>}
    {guide && <span aria-hidden="true" className={styles.inspectionGuide} data-chart-inspection-guide="" {...dyn({ left: guide.x, height: guide.height })} />}
    {marker && <span aria-hidden="true" className={styles.migration} {...dyn({ left: marker.x, height: marker.height })}>
      <span className={styles.migrationCaption} ref={markerLabel} {...dyn({ left: marker.captionOffset })}>{migrationLabel}</span>
    </span>}
  </>;
}

function useWalletChartBadges(markers: readonly PlottedWalletMarker[]) {
  const [badges, setBadges] = useState<ReturnType<typeof walletMarkerBadges>>([]);
  const touch = useSyncExternalStore(subscribeCoarsePointer, () => matchMedia(coarsePointerQuery).matches, () => false);
  const viewport = useRef<{ markers: typeof markers; geometry: string } | null>(null);

  function projectWalletMarkers(handle: ChartHandle) {
    const firstMarker = markers[0];
    if (!firstMarker) return;

    const scale = handle.chart.timeScale();
    const range = scale.getVisibleLogicalRange();
    const { width, height } = handle.chart.paneSize(0);
    const owner = handle.series[firstMarker.seriesIndex];
    // All price series share the exact 0..100 scale. Track both axes through live updates, zoom and pan.
    const geometry = [width, height, range?.from, range?.to, owner?.priceToCoordinate(0), owner?.priceToCoordinate(100), touch].join("|");
    if (viewport.current?.markers === markers && viewport.current.geometry === geometry) return;

    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    setBadges(walletMarkerBadges(markers, width, height, rem, mark => {
      const x = scale.timeToCoordinate(mark.time);
      const y = handle.series[mark.seriesIndex]?.priceToCoordinate(mark.price);
      return x == null || y == null ? null : { x, y };
    }, touch));
    viewport.current = { markers, geometry };
  }

  return { badges, touch, projectWalletMarkers };
}

function tradePlotTime(history: Source, bucket: number, mode: "line" | "candles", migrationAt?: number) {
  if (mode === "candles") return chartTimestamp(bucket);
  const { page, opening } = history;
  const { priceFrom, priceThrough } = sourceLineBounds(history, migrationAt);
  const openingAt = bucket === page.candles[0]?.bucketStart ? opening?.timestampMs : undefined;
  return chartTimestamp(lineCloseTime(bucket, openingAt, candleIntervalMs(page.interval), priceFrom, priceThrough));
}

function useTradeOverlay(tradeLabel: ReturnType<typeof candleTradeLabel>, at?: number) {
  const overlay = useRef<ReturnType<typeof mountCandleTrade> | null>(null);
  const mountTrade = useCallback((slot: HTMLSpanElement | null) => {
    if (!slot) return;
    const label = mountCandleTrade(slot);
    overlay.current = label;
    return () => { label.hide(); overlay.current = null; };
  }, []);
  useLayoutEffect(() => {
    if (!tradeLabel) overlay.current?.hide();
  }, [tradeLabel]);
  function projectTrade(handle: ChartHandle, series: readonly ChartSeries[], settled: boolean) {
    overlay.current?.place(tradeLabel, projectCandleTrade(handle, series, tradeLabel?.index, at), settled);
  }
  return { mountTrade, projectTrade, tradeKey: tradeLabel?.cursor ?? "" };
}

function PoolReadout({ compact, plotMode, preview, walletToggle, inspected, ...values }: PoolReadoutValuesProps & Readonly<{
  compact: boolean;
  plotMode: "line" | "candles";
  preview?: ReactNode;
  walletToggle: ReactNode;
}>) {
  const mobilePreview = values.mode === "line" && plotMode === "candles" && Boolean(preview);
  if (!compact || (values.mode !== plotMode && !mobilePreview)) return null;
  return <div className={styles.readout} data-mode={values.mode} data-mobile-preview={mobilePreview || undefined}>
    <PoolReadoutValues {...values} inspected={mobilePreview ? undefined : inspected} />
    {walletToggle}
  </div>;
}

type PoolReadoutValuesProps = Readonly<{
  hidden: boolean;
  inspected?: { at: number; value?: string; candle?: ExactCandle; volume?: string };
  model: ReturnType<typeof poolChartModel>;
  mode: "line" | "candles";
  quoteSymbol?: string;
}>;

function PoolReadoutValues({ hidden, inspected, model, mode, quoteSymbol }: PoolReadoutValuesProps) {
  if (hidden) return null;
  const unit = model.usd ? "USD" : quoteSymbol;
  if (mode === "candles") {
    const candle = inspected ? inspected.candle : model.latestCandle;
    const at = inspected?.at ?? model.latest?.bucket;
    const volume = inspected?.volume ?? candle?.volume;
    return at !== undefined && volume !== undefined
      ? <CandleReadout candle={candle} volume={volume} at={at} inspected={!!inspected} unit={unit} volumeUnit={quoteSymbol} />
      : null;
  }
  if (inspected?.value !== undefined) return <PriceReadout at={inspected.at} value={inspected.value} inspected unit={unit} />;
  return model.latest && <PriceReadout {...model.latest} inspected={false} unit={unit} />;
}

function ChartTime({ at, prefix }: Readonly<{ at: number; prefix?: string }>) {
  const date = new Date(at * 1000);
  const iso = date.toISOString();
  const time = iso.slice(11, date.getUTCSeconds() === 0 ? 16 : 19);
  return <time className={styles.inspectionContext} dateTime={iso}>{prefix}{shortUtcDate(date)} · {time} UTC</time>;
}

function PriceReadout({ value, at, inspected, unit }: Readonly<{ value: string; at: number | null; inspected: boolean; unit?: string }>) {
  const price = chartPrice(value, 3);
  return <>
    <div className={styles.lineContext}>
      <span className={styles.inspectionAmount}>
        <span className={styles.inspectionContext}>{inspected ? "Price" : "Last close"}</span>
        <span data-chart-inspected-price={inspected ? "" : undefined} data-chart-latest-price={inspected ? undefined : ""}>{withUnit(price, unit)}</span>
      </span>
      {at !== null && <ChartTime at={at} prefix={inspected ? undefined : "As of "} />}
    </div>
    <ExactValues label="price" at={at} entries={[["Price", withUnit(value, unit)]]} />
  </>;
}

const candlePrices = [["close", "Close"], ["open", "Open"], ["high", "High"], ["low", "Low"]] as const;

function CandleReadout({ candle, volume, at, inspected, unit, volumeUnit }: Readonly<{
  candle?: ExactCandle; volume: string; at: number; inspected: boolean; unit?: string; volumeUnit?: string;
}>) {
  return <>
    <div className={styles.candleContext}>
      {inspected && <span className={styles.inspectionContext}><ChartTime at={at} />{unit && ` · ${unit}`}</span>}
      <span className={styles.inspectionContext}>Volume <strong>{withUnit(chartPrice(volume, 4), volumeUnit)}</strong></span>
    </div>
    <ExactValues label={candle ? "candle values" : "volume"} at={at} entries={[
      ...(candle ? candlePrices.map(([key, name]) => [name, withUnit(candle[key], unit)] as const) : []),
      ["Volume", withUnit(volume, volumeUnit)],
    ]} />
    <dl className={styles.candleFields} aria-label={unit ? `Candle prices in ${unit}` : "Candle prices"}>
      {candlePrices.map(([key, name]) => <div key={key}>
        <dt>{name}</dt>
        <dd data-chart-inspected-price={inspected && key === "close" ? "" : undefined}
          data-chart-latest-price={!inspected && key === "close" ? "" : undefined}>{candle ? chartPrice(candle[key], 3) : "—"}</dd>
      </div>)}
    </dl>
  </>;
}

function withUnit(value: string, unit?: string) {
  if (unit === "USD") return `$${value}`;
  return unit ? `${value} ${unit}` : value;
}

function ExactValues({ label, at, entries }: Readonly<{
  label: string; at: number | null; entries: readonly (readonly [string, string])[];
}>) {
  const name = `View exact ${label}`;
  return <Popover.Root>
    <Popover.Trigger render={<IconButton aria-label={name} variant="ghost" size="touch" />} className={styles.exactTrigger} data-chart-exact-trigger="">
      <InfoIcon />
    </Popover.Trigger>
    <PopoverSurface positioner={{ className: styles.exactLayer, side: "top", align: "end", sideOffset: 4 }}
      popup={{ className: styles.exactValues, "aria-label": name, "data-chart-exact-values": "" }}>
      {at !== null && <ChartTime at={at} />}
      <dl>{entries.map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>
    </PopoverSurface>
  </Popover.Root>;
}

function configurePoolPanes(chart: ChartHandle["chart"]) {
  const [price, volume] = chart.panes();
  price?.setStretchFactor(4);
  volume?.setStretchFactor(1);
  volume?.priceScale(VOLUME_SCALE).applyOptions({ scaleMargins: { top: 0.15, bottom: 0 } });
}

function latestPrice(source: Source | undefined, price: (raw: string) => string) {
  const candle = source?.page.candles.at(-1);
  const carried = source?.carriedClose;
  const close = candle?.close ?? carried?.price;
  const bucket = candle?.bucketStart ?? carried?.timestampMs;
  if (close === undefined || bucket === undefined) return undefined;
  const observedAt = source?.observedAt;
  return { at: observedAt == null ? null : chartTimestamp(observedAt), bucket: chartTimestamp(bucket), value: price(close) };
}

function usePoolLabels(compact: boolean, showVolume: boolean, migrationAt?: number) {
  const [volumeTop, setVolumeTop] = useState(0);
  const markerLabel = useRef<HTMLSpanElement>(null);
  const [marker, setMarker] = useState<Readonly<{ x: number; captionOffset: number; height?: number }> | null>(null);

  function projectLabels(chart: ChartHandle["chart"]) {
    const x =
      migrationAt === undefined
        ? null
        : chart.timeScale().timeToCoordinate(chartTimestamp(migrationAt));
    const plotWidth = chart.timeScale().width();
    const captionWidth = markerLabel.current?.offsetWidth ?? (compact ? 136 : MIGRATION_LABEL_ROOM_PX);
    const priceHeight = compact ? chart.paneSize(0).height : 0;
    const volumeHeight = compact && showVolume && chart.panes()[1] ? chart.paneSize(1).height + 1 : 0;
    if (compact && showVolume) setVolumeTop(priceHeight);
    const next = x === null || x < 0 || x >= plotWidth ? null : {
      x: Number(x),
      captionOffset: migrationCaptionOffset(x, plotWidth, captionWidth),
      height: compact ? priceHeight + volumeHeight : undefined,
    };
    // Same place keeps the same object, so per-frame projections on hover do not re-render.
    setMarker(prev => prev && next && prev.x === next.x && prev.captionOffset === next.captionOffset && prev.height === next.height ? prev : next);
  }

  return { volumeTop, markerLabel, marker, projectLabels };
}

function scaledWalletMarkers(trades: readonly WalletChartTrade[], history: Source, mode: "line" | "candles", seriesIndex: number,
  interval: number, priceFrom: number, priceThrough: number, coordinate: (raw: string) => number): PlottedWalletMarker[] {
  if (!trades.length) return [];
  const { page, opening } = history;
  const markers = walletMarkers(trades, page, bucket => mode === "candles" ? bucket :
    lineCloseTime(bucket, bucket === page.candles[0]?.bucketStart ? opening?.timestampMs : undefined, interval, priceFrom, priceThrough));
  return markers.map(marker => {
    const { low, high, close } = marker.candle;
    const raw = mode === "line" ? close : marker.side === "buy" ? low : high;
    return { ...marker, seriesIndex, price: coordinate(raw) };
  });
}

function latestPoolMarker(latest: ReturnType<typeof latestPrice>, points: readonly ExactSeries[], coordinate: (price: string) => number, usd: boolean) {
  const seriesIndex = points.findLastIndex((source) => source.times.length > 0);
  if (!latest || seriesIndex === -1) return {};
  return {
    latestCandle: points[seriesIndex]?.candles?.get(latest.bucket),
    latestTag: { seriesIndex, price: coordinate(latest.value), label: `${usd ? "$" : ""}${chartPrice(latest.value, 3)}` },
  };
}

function poolChartModel({
  sources, migrationAt, from, to, rollingWindow, memeDecimals, quoteDecimals, quoteUsd, mode, showVolume, compact, walletTrades,
}: Readonly<{
  walletTrades: readonly WalletChartTrade[];
  sources: readonly Source[];
  migrationAt?: number;
  from?: number;
  to?: number;
  rollingWindow?: boolean;
  memeDecimals: number | null;
  quoteDecimals: number | null;
  quoteUsd: string | null;
  mode: "candles" | "line";
  showVolume: boolean;
  compact: boolean;
}>) {
  const { usd, price } = poolPrices(memeDecimals, quoteDecimals, quoteUsd);
  const quantity = (value: bigint) =>
    shiftDecimal(value.toString(), -(quoteDecimals ?? 0));
  const lines = mode === "line" ? poolLinePoints(sources, migrationAt, to, rollingWindow) : [];
  const prices = mode === "line"
    ? lines.flatMap((points) => points.map((point) => price(point.price)))
    : sources.flatMap(({ page }) => page.candles.flatMap((candle) => [candle.open, candle.high, candle.low, candle.close].map(price)));
  const scale = exactChartScale(prices);
  const autoscaleInfoProvider: AutoscaleInfoProvider = scale.flat
    ? () => ({ priceRange: { minValue: 0, maxValue: 100 } })
    : (original) => original();
  const volumes = combinedVolumes(
    sources.flatMap(({ page }) =>
      page.candles.map((candle) => ({
        at: candle.bucketStart,
        volume: quantity(candle.volumeQuote),
        down: comparePrices(candle.close, candle.open) < 0,
      })),
    ),
  );
  const volume = exactChartScale([
    "0",
    ...volumes.map((point) => point.volume),
  ]);
  const intervalMs = candleIntervalMs(sources[0]?.page.interval ?? "1m");
  const timeline = poolTimeline(sources, intervalMs, from, to, migrationAt);
  const pointPrices: ExactSeries[] = [];
  const up = compact ? "var(--coin-chart-up)" : "var(--up)";
  const down = compact ? "var(--coin-chart-down)" : "var(--down)";
  const lineStyle = compact ? { lineColor: "var(--ink)", topColor: "transparent", bottomColor: "transparent" } : {};
  // The newest source owns the latest readout (after migration, the venue).
  const tagged = sources.findLastIndex(({ page, carriedClose }) => page.candles.length > 0 || carriedClose);
  const latest = latestPrice(sources[tagged], price);
  const markers: PlottedWalletMarker[] = [];
  let seriesIndex = 0;
  const series: ChartSeries[] = sources.flatMap((history, sourceIndex) => {
    const { source, page } = history;
    const { priceFrom, priceThrough } = sourceLineBounds(history, migrationAt);
    const interval = candleIntervalMs(page.interval);
    markers.push(...scaledWalletMarkers(walletTrades, history, mode, seriesIndex, interval, priceFrom, priceThrough, raw => scale.coordinate(price(raw))));
    const points = new Map<number, string>();
    const candles = compact && mode === "candles" ? new Map<number, ExactCandle>() : undefined;
    const pointValue = (at: number, raw: string) => {
      const value = price(raw);
      if (compact) points.set(chartTimestamp(at), value);
      return scale.coordinate(value);
    };
    const hollow = !compact && source === "venue";
    // Only opt out. A tagged series still follows the chart's hidden-amounts rule.
    const tag = compact || sourceIndex !== tagged ? { lastValueVisible: false } : {};
    const line = lines[sourceIndex];
    const priceSeries: ChartSeries[] =
      mode === "line"
        ? !line?.length ? [] : [
            {
              type: "Area" as const,
              data: chartData(
                line.map(({ timestampMs, price: raw }) => ({
                  time: chartTimestamp(timestampMs),
                  value: pointValue(timestampMs, raw),
                })),
              ),
              options: {
                priceLineVisible: false,
                ...tag,
                ...lineStyle,
                pointMarkersVisible: line.length === 1,
                autoscaleInfoProvider,
              },
            },
          ]
        : [
            {
              type: "Candlestick" as const,
              data: chartData(
                page.candles.map((candle) => {
                  const time = chartTimestamp(candle.bucketStart);
                  const open = price(candle.open);
                  const high = price(candle.high);
                  const low = price(candle.low);
                  const close = price(candle.close);
                  candles?.set(time, { open, high, low, close, volume: quantity(candle.volumeQuote) });
                  return { time, open: scale.coordinate(open), high: scale.coordinate(high), low: scale.coordinate(low), close: scale.coordinate(close) };
                }),
              ),
              options: {
                upColor: hollow ? "transparent" : up,
                downColor: hollow ? "transparent" : down,
                borderUpColor: up,
                borderDownColor: down,
                wickUpColor: up,
                wickDownColor: down,
                autoscaleInfoProvider,
                priceLineVisible: false,
                ...tag,
              },
            },
          ];
    if (compact && priceSeries[0]) {
      pointPrices.push({ values: points, candles, times: priceSeries[0].data.map((point) => Number(point.time)) });
    }
    seriesIndex += priceSeries.length;
    return priceSeries;
  });
  if (showVolume)
    series.push({
      type: "Histogram",
      pane: 1,
      data: chartData(
        volumes.map((point) => ({
          time: chartTimestamp(point.at),
          value: volume.coordinate(point.volume),
          color: point.color === "var(--up)" ? up : point.color === "var(--down)" ? down : point.color,
        })),
      ),
      options: {
        // Its own unlabelled scale: no volume tick crowds the price axis above (audit F40).
        priceScaleId: VOLUME_SCALE,
        priceLineVisible: false,
        lastValueVisible: false,
        priceFormat: {
          type: "custom",
          minMove: 0.000001,
          formatter: (value: number) => volume.format(value, 4),
        },
      },
    });
  return {
    series,
    timeline,
    intervalMs,
    pointPrices,
    markers,
    latest,
    pointVolumes: new Map(volumes.map(({ at, volume }) => [Number(chartTimestamp(at)), volume])),
    ...latestPoolMarker(latest, pointPrices, scale.coordinate, usd),
    usd,
    format: (value: number, significant?: number) =>
      `${usd ? "$" : ""}${scale.format(value, significant ?? (compact ? 3 : undefined), compact)}`,
  };
}
