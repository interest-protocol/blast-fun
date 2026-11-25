"use client";

import type { DrawnSeries } from "#web/components/launchpad/chart/chart-geometry.ts";

import type { AutoscaleInfoProvider } from "lightweight-charts";

import { useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
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
import { Button } from "#web/components/blast-ui/Button.tsx";
import { Switch } from "#web/components/blast-ui/Checkbox.tsx";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import { comparePrices } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { dyn } from "#web/components/blast-ui/csp-style.ts";
import { shiftDecimal } from "#web/components/launchpad/coin/coin-format.ts";
import styles from "./PoolCandleChart.module.css";
import { combinedVolumes, lineCloseTime, poolLinePoints, poolPrices, sourceLineBounds } from "./candle-data";
import { migrationCaptionOffset } from "./chart-inspection-model";
import { useMobileChartLayout } from "./use-mobile-chart-layout";

import { saveChartPreference, useChartPreference } from "#web/components/launchpad/chart/chart-preferences.ts";
import { walletMarkerBadges, walletMarkers, type PlottedWalletMarker, type WalletChartTrade } from "./wallet-markers";
import { WalletChartMarkers } from "./WalletChartMarkers";

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
  rollingWindow,
  latestAvailable = true,
  presentation,
  migrationAt,
  migrationLabel = "Migration",
  from,
  to,
  label = "Price and volume chart",
  memeDecimals = null,
  quoteDecimals = null,
  quoteUsd = null,
  walletTrades,
}: Readonly<{
  walletTrades?: readonly WalletChartTrade[];
  sources: readonly Source[];
  rollingWindow?: boolean;
  latestAvailable?: boolean;
  presentation?: "line" | "candles";
  migrationAt?: number;
  migrationLabel?: ReactNode;
  from?: number;
  to?: number;
  label?: string;
  memeDecimals?: number | null;
  quoteDecimals?: number | null;
  quoteUsd?: string | null;
}>) {
  const [localMode, setMode] = useState<"line" | "candles">("candles");
  const [localVolume, setShowVolume] = useState(true);
  const mobile = useMobileChartLayout();
  const mode = mobile ? "line" : presentation ?? localMode;
  const showVolume = presentation ? mode === "candles" : localVolume;
  const { showWalletTags, setWalletTags } = useWalletTags();
  const labels = usePoolLabels(migrationAt);
  const model = useMemo(
    () => poolChartModel({ sources, migrationAt, from, to, rollingWindow, memeDecimals, quoteDecimals, quoteUsd, mode, showVolume, walletTrades: walletTrades ?? NO_WALLET_TRADES }),
    [sources, migrationAt, from, to, rollingWindow, memeDecimals, quoteDecimals, quoteUsd, mode, showVolume, walletTrades],
  );
  const plottedSeries = useMemo(() => latestAvailable ? model.series : model.series.map((series) => ({
    ...series, options: { ...series.options, lastValueVisible: false },
  })), [latestAvailable, model.series]);
  const { badges, touch, projectWalletMarkers } = useWalletChartBadges(model.markers);
  const showMarkers = showWalletTags && model.markers.length > 0;
  const project = (handle: ChartHandle) => {
    projectWalletMarkers(handle);
    labels.projectLabels(handle.chart);
  };
  const walletToggle = <WalletTagsToggle available={Boolean(walletTrades)} checked={showWalletTags} onChange={setWalletTags} />;
  return (
    <>
      <PoolChartControls mobile={mobile} mode={mode} onModeChange={setMode} showVolume={showVolume} onToggleVolume={() => setShowVolume((value) => !value)} />
      <div data-chart-stage="">
        <div className={styles.plot}>
          <TradingViewChart
            livePool
            rollingWindow={rollingWindow}
            series={plottedSeries}
            intervalMs={model.intervalMs}
            timeline={model.timeline}
            priceFormatter={model.format}
            label={label}
            onProject={project}
            projectionKey={String(touch)}
            onReady={({ chart }) => configurePoolPanes(chart)}
          />
          {showMarkers && <WalletChartMarkers badges={badges} />}
          <PoolPlotLabels labels={labels} migrationLabel={migrationLabel} />
        </div>
        {walletToggle}
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

function PoolChartControls({ mobile, mode, onModeChange, showVolume, onToggleVolume }: Readonly<{
  mobile: boolean;
  mode: "line" | "candles";
  onModeChange: (mode: "line" | "candles") => void;
  showVolume: boolean;
  onToggleVolume: () => void;
}>) {
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

function PoolPlotLabels({ labels, migrationLabel }: Readonly<{
  labels: ReturnType<typeof usePoolLabels>;
  migrationLabel: ReactNode;
}>) {
  const { marker, markerLabel } = labels;
  return marker && <span aria-hidden="true" className={styles.migration} {...dyn({ left: marker.x })}>
    <span className={styles.migrationCaption} ref={markerLabel} {...dyn({ left: marker.captionOffset })}>{migrationLabel}</span>
  </span>;
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

function configurePoolPanes(chart: ChartHandle["chart"]) {
  const [price, volume] = chart.panes();
  price?.setStretchFactor(4);
  volume?.setStretchFactor(1);
  volume?.priceScale(VOLUME_SCALE).applyOptions({ scaleMargins: { top: 0.15, bottom: 0 } });
}

function usePoolLabels(migrationAt?: number) {
  const markerLabel = useRef<HTMLSpanElement>(null);
  const [marker, setMarker] = useState<Readonly<{ x: number; captionOffset: number }> | null>(null);

  function projectLabels(chart: ChartHandle["chart"]) {
    const x =
      migrationAt === undefined
        ? null
        : chart.timeScale().timeToCoordinate(chartTimestamp(migrationAt));
    const plotWidth = chart.timeScale().width();
    const captionWidth = markerLabel.current?.offsetWidth ?? MIGRATION_LABEL_ROOM_PX;
    const next = x === null || x < 0 || x >= plotWidth ? null : {
      x: Number(x),
      captionOffset: migrationCaptionOffset(x, plotWidth, captionWidth),
    };
    // Same place keeps the same object, so per-frame projections on hover do not re-render.
    setMarker(prev => prev && next && prev.x === next.x && prev.captionOffset === next.captionOffset ? prev : next);
  }

  return { markerLabel, marker, projectLabels };
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

function poolChartModel({
  sources, migrationAt, from, to, rollingWindow, memeDecimals, quoteDecimals, quoteUsd, mode, showVolume, walletTrades,
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
  const up = "var(--up)";
  const down = "var(--down)";
  // The newest source owns the latest readout (after migration, the venue).
  const tagged = sources.findLastIndex(({ page, carriedClose }) => page.candles.length > 0 || carriedClose);
  const markers: PlottedWalletMarker[] = [];
  let seriesIndex = 0;
  const series: ChartSeries[] = sources.flatMap((history, sourceIndex) => {
    const { source, page } = history;
    const { priceFrom, priceThrough } = sourceLineBounds(history, migrationAt);
    const interval = candleIntervalMs(page.interval);
    markers.push(...scaledWalletMarkers(walletTrades, history, mode, seriesIndex, interval, priceFrom, priceThrough, raw => scale.coordinate(price(raw))));
    const hollow = source === "venue";
    // Only opt out. A tagged series still follows the chart's hidden-amounts rule.
    const tag = sourceIndex !== tagged ? { lastValueVisible: false } : {};
    const line = lines[sourceIndex];
    const priceSeries: ChartSeries[] =
      mode === "line"
        ? !line?.length ? [] : [
            {
              type: "Area" as const,
              data: chartData(
                line.map(({ timestampMs, price: raw }) => ({
                  time: chartTimestamp(timestampMs),
                  value: scale.coordinate(price(raw)),
                })),
              ),
              options: {
                priceLineVisible: false,
                ...tag,
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
    markers,
    format: (value: number, significant?: number) =>
      `${usd ? "$" : ""}${scale.format(value, significant)}`,
  };
}
