"use client";

import { shortUtcDate } from "#web/components/blast-ui/date-label.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";

import { useEffectEvent, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode, type Ref } from "react";
import clsx from "clsx";
import type {
  IChartApi,
  IPriceLine,
  IRange,
  Logical,
  LineStyle,
  ISeriesApi,
  SeriesDataItemTypeMap,
  SeriesDefinition,
  SeriesPartialOptionsMap,
  TickMarkType,
  Time,
} from "lightweight-charts";
import {
  useIsDark,
  useShellPrefs,
} from "#web/components/blast-ui/use-shell-prefs.ts";
import { chartNumber } from "./chart-price";
import {
  atLiveEdge,
  chartTimestamp,
  distinctTicks,
  keyboardChartRange,
  liveChartRange,
  LIVE_GUTTER_PX,
  panChartRange,
  pannedPosition,
  pointerX,
  queuedChartRange,
  rebaseCoinChartRange,
  resizedLiveChartRange,
  restoredChartRange,
  trackpadGestures,
  visibleMove,
  wheelAction,
  wheelPixels,
  withAlpha,
  zoomChartRange,
  zoomChartRangeAtPixel,
  type SavedChartView,
} from "./tradingview-model";
import { chartProjectionQueue } from "./chart-projection.ts";
import { seriesChange } from "./series-change.ts";
import styles from "./TradingViewChart.module.css";
import { useZoomHint } from "./zoom-hint";

const dayTick = new Intl.DateTimeFormat("en-GB", { month: "short", day: "numeric", timeZone: "UTC" });
const DEFAULT_MARGINS = { top: 0.12, bottom: 0.12 };
const loadTradingView = () => import("lightweight-charts");
function coinTimeScale({ TickMarkType: ticks }: Awaited<ReturnType<typeof loadTradingView>>, intervalMs: number) {
  return {
    tickMarkMaxCharacterLength: intervalMs < 60_000 ? 8 : 6,
    tickMarkFormatter: (time: Time, type: TickMarkType) => {
      const date = new Date(Number(time) * 1000);
      if (type === ticks.Year) return String(date.getUTCFullYear());
      if (type === ticks.Month || type === ticks.DayOfMonth) return dayTick.format(date);
      return date.toISOString().slice(11, type === ticks.TimeWithSeconds ? 19 : 16);
    },
  };
}
type Kind = "Line" | "Area" | "Candlestick" | "Histogram";
type CoinChartView = Readonly<{ logical: IRange<number>; times: readonly number[]; width: number }>;
/** A volume pane's overlay scale: bars keep their height, the axis column stays the price's alone. */
export const VOLUME_SCALE = "volume";
/** The "Migration" label's width plus its inset: with less room to the plot's right edge it sits left of the line. */
export const MIGRATION_LABEL_ROOM_PX = 72;

export type ChartSeries = {
  [K in Kind]: Readonly<{
    type: K;
    data: readonly SeriesDataItemTypeMap<Time>[K][];
    options?: SeriesPartialOptionsMap[K];
    pane?: number;
  }>;
}[Kind];
export type ChartHandle = Readonly<{
  chart: IChartApi;
  series: readonly ISeriesApi<Kind>[];
  host: HTMLDivElement;
  timeToCoordinate: (at: number) => number | null;
}>;
export type ChartProjection = (handle: ChartHandle, settled: boolean) => void;

type Props = Readonly<{
  series: readonly ChartSeries[];
  /** Keep the pool chart mounted as trades amend its candle, volume and time axis. */
  livePool?: boolean;
  /** The selected coin history's last close, even when the reader pans into older bars. */
  latestPrice?: Readonly<{ seriesIndex: number; price: number; label: string }>;
  timeline?: readonly number[];
  /** The Live preset's timeline ends at the clock even when the last trade was earlier. */
  rollingWindow?: boolean;
  compact?: boolean;
  interactive?: boolean;
  /** Readable axes and separate credit for the full-width coin board. */
  coinAxes?: boolean;
  /** Keep the latest bar within reach while the reader moves or zooms the chart. */
  liveViewport?: boolean;
  intervalMs?: number;
  scaleMargins?: Readonly<{ top: number; bottom: number }>;
  /** A price label; `significant` asks for more digits when zoomed-in ticks would otherwise read the same. */
  priceFormatter?: (value: number, significant?: number) => string;
  hidden?: boolean;
  className?: string;
  label?: string;
  preview?: ReactNode;
  onReady?: (handle: ChartHandle) => void | (() => void);
  onProject?: ChartProjection;
  projectionKey?: unknown;
  onSelect?: (at: number) => void;
}>;

/**
 * TradingView Lightweight Charts™. Copyright (с) 2025 TradingView, Inc. https://www.tradingview.com/
 *
 * Styled from the theme's tokens, read when the chart mounts (and again when
 * the theme changes): no background of its own, faint hairline grid, muted
 * 11px axis text in the page's face, a neutral crosshair and candles in
 * `--up`/`--down`. A full chart's price line or area without its own colour
 * takes `--up` or `--down` by the move across the visible range, recoloured
 * as the view pans or zooms; a compact chart keeps its host's text colour.
 * Every axis and readout label is written by `chartPrice`, never in exponent form.
 */
export function TradingViewChart({
  className,
  label,
  preview,
  compact = false,
  interactive = !compact,
  coinAxes = false,
  liveViewport = coinAxes,
  ...plot
}: Props) {
  const coinViewport = liveViewport && interactive;
  const { host, returnLive, failed, browsing, firstFramePainted, showZoomHint } = useTradingViewPlot({
    ...plot, preview, compact, interactive, coinAxes, liveViewport,
  });
  return <ChartSurface
    host={host}
    className={className}
    compact={compact}
    label={label}
    preview={firstFramePainted ? null : preview}
    coinViewport={coinViewport}
    showFooter={coinAxes || coinViewport}
    showLiveButton={coinViewport && browsing && !failed}
    onReturnLive={() => returnLive.current?.()}
    interactive={interactive}
    showZoomHint={showZoomHint}
    failed={failed}
  />;
}

function useTradingViewPlot({
  series,
  livePool = false,
  latestPrice,
  timeline,
  rollingWindow = false,
  compact = false,
  interactive = !compact,
  coinAxes = false,
  liveViewport = coinAxes,
  intervalMs = 60_000,
  scaleMargins = DEFAULT_MARGINS,
  priceFormatter,
  hidden: hidePrices,
  preview,
  onReady,
  onProject,
  projectionKey,
  onSelect,
}: Props) {
  const host = useRef<HTMLDivElement>(null);
  const active = useRef<ChartHandle | null>(null);
  const returnLive = useRef<(() => void) | null>(null);
  const savedView = useRef<Readonly<{ rollingWindow: boolean; view: SavedChartView | CoinChartView }> | null>(null);
  const [failed, setFailed] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [firstFramePainted, setFirstFramePainted] = useState(false);
  const zoomHint = useZoomHint();
  const preferences = useShellPrefs();
  const dark = useIsDark();
  const hidden = hidePrices ?? preferences.amountsHidden;
  const showCoinTag = coinAxes && !hidden;
  const coinViewport = liveViewport && interactive;
  const ready = useEffectEvent((handle: ChartHandle) => onReady?.(handle));
  const handoffPreview = useEffectEvent(() => preview && !firstFramePainted
    ? requestAnimationFrame(() => setFirstFramePainted(true))
    : 0);
  const project = useEffectEvent((handle: ChartHandle, settled: boolean) => onProject?.(handle, settled));
  const select = useEffectEvent((at: number) => onSelect?.(at));
  const showHint = useEffectEvent(() => zoomHint.show());
  const hideHint = useEffectEvent(() => zoomHint.hide());

  const model = useMemo(() => ({ series, timeline, priceFormatter, latestPrice }), [series, timeline, priceFormatter, latestPrice]);
  const mountKey = livePool || coinViewport ? series.map((s) => `${s.type}:${s.pane ?? 0}`).join("|") : model;
  const readModel = useEffectEvent(() => model);
  const writeModel = useRef<((next: typeof model) => void) | null>(null);

  useLayoutEffect(() => {
    const node = host.current;
    if (!node) return;
    let chart: IChartApi | undefined;
    let handle: ChartHandle | undefined;
    let disposed = false;
    let mounting = false;
    let readyFrame = 0;
    let viewReady = !rollingWindow && !coinViewport;
    const previousView = !compact && savedView.current?.rollingWindow === rollingWindow ? savedView.current.view : null;
    let cleanupReady: void | (() => void);
    let times: number[] = [];
    const crosshairTone = coinAxes ? "--muted" : "--faint";
    const liveOptions = coinViewport ? { rightOffsetPixels: LIVE_GUTTER_PX } : {};
    let previousBrowsing: boolean | undefined;
    let previousWidth = 0;
    const { schedule, afterChartWrite, cancel } = chartProjectionQueue(() => {
      if (!handle || disposed) return;
      viewport.settle();
      if (coinViewport && viewReady) {
        const width = handle.chart.timeScale().width();
        const logical = viewport.read();
        const initialFit = rollingWindow && !previousView && previousWidth === 0;
        const resized = logical && resizedLiveChartRange(logical, times.length, previousWidth, width, initialFit);
        previousWidth = width;
        if (resized) viewport.write(resized);
        const visible = resized ?? logical;
        const next = Boolean(visible && width && !atLiveEdge(visible, times.length, width));
        if (next !== previousBrowsing) {
          previousBrowsing = next;
          setBrowsing(next);
        }
      }
      project(handle, true);
    });
    const viewport = queuedChartRange(
      () => chart?.timeScale().getVisibleLogicalRange() ?? null,
      (range) => {
        chart?.timeScale().setVisibleLogicalRange(range);
        afterChartWrite();
      },
    );
    returnLive.current = () => {
      const range = viewport.read();
      const width = chart?.timeScale().width();
      if (!range || !width) return;
      viewport.write(liveChartRange(range, times.length, width));
      node.focus({ preventScroll: true });
    };
    async function mount() {
      const library = await loadTradingView();
      if (disposed || !node!.clientWidth || !node!.clientHeight) return;
      let current = typeof mountKey === "string" ? readModel() : mountKey;
      let series = current.series;
      times = chartTimes(current);
      const css = getComputedStyle(node!);
      const axisInk = readChartColor(css, coinAxes ? "--ink-2" : "--muted");
      const hair = readChartColor(css, "--hair");
      const neutral = readChartColor(css, crosshairTone);
      const tones = {
        up: readChartColor(css, "--up"),
        down: readChartColor(css, "--down"),
      };
      const format = (value: number, significant?: number) =>
        hidden ? "••••" : (current.priceFormatter?.(value, significant) ?? chartNumber(value, significant));
      const labelFormat = (value: number) =>
        showCoinTag && current.latestPrice?.price === value ? current.latestPrice.label : format(value);
      const crosshairLine = {
        visible: interactive,
        color: neutral,
        width: 1 as const,
        style: library.LineStyle.Dashed,
        labelVisible: false,
      };
      chart = library.createChart(node!, {
        width: node!.clientWidth,
        height: node!.clientHeight,
        layout: {
          background: { type: library.ColorType.Solid, color: "transparent" },
          textColor: axisInk,
          fontSize: coinAxes ? 12 : 11,
          fontFamily: css.fontFamily,
          attributionLogo: false,
          panes: { separatorColor: hair },
        },
        grid: {
          vertLines: { visible: false },
          horzLines: {
            visible: !compact,
            color: hair,
            style: library.LineStyle.Solid,
          },
        },
        crosshair: {
          mode: library.CrosshairMode.Magnet,
          vertLine: crosshairLine,
          horzLine: coinAxes ? { visible: false, labelVisible: false } : crosshairLine,
        },
        rightPriceScale: {
          visible: !compact,
          borderVisible: false,
          // Wide enough for the TradingView credit in the empty corner under it (audit F40).
          minimumWidth: coinAxes ? 0 : priceAxisWidth(),
          // A tick the plot's top or bottom edge would cut in half is left out (audit acceptance: labels stay whole).
          entireTextOnly: true,
          scaleMargins,
        },
        timeScale: {
          visible: !compact,
          borderVisible: false,
          timeVisible: true,
          secondsVisible: intervalMs < 60_000,
          rightOffset: compact ? 0 : 2,
          minBarSpacing: 0.001,
          lockVisibleTimeRangeOnResize: true,
          ...(coinAxes ? coinTimeScale(library, intervalMs) : {}),
          ...liveOptions,
        },
        localization: {
          locale: "en-GB",
          timeFormatter: (time: Time) => {
            const date = new Date(Number(time) * 1000);
            return `${shortUtcDate(date)} · ${date.toISOString().slice(11, 19)} UTC`;
          },
        },
        // A vertical wheel scrolls the page; the listeners below pan on a sideways swipe and zoom on Ctrl/⌘ + wheel or a pinch (audit F41).
        handleScroll: interactive ? { vertTouchDrag: false, mouseWheel: false } : false,
        handleScale: interactive ? { mouseWheel: false } : false,
        kineticScroll: { mouse: false, touch: false },
      });
      const timelineSeries = chart.addSeries(library.LineSeries, {
        priceScaleId: "timeline",
        visible: false,
        lastValueVisible: false,
        priceLineVisible: false,
      });
      // The native scale stops at the last valued point. Pin its right edge with
      // one value on the hidden timeline so quiet seconds still occupy space.
      const setTimeline = (points: readonly number[]) => timelineSeries.setData(points.map((at, index) => {
        const time = chartTimestamp(at);
        return (rollingWindow || coinViewport) && index === points.length - 1 ? { time, value: 0 } : { time };
      }));
      setTimeline(times);
      // A full chart's uncoloured price line follows the move in view; the
      // first paint uses the whole series, the range subscription the view.
      const toned = compact
        ? []
        : series.flatMap((spec, index) => (followsMove(spec) ? [index] : []));
      const tonedIndices = new Set(toned);
      let tonedData = toned.map((index) => series[index]!.data);
      let tone =
        visibleMove(tonedData, { from: -Infinity, to: Infinity }) ?? "up";
      // A scale takes its tick labels from its first series, while the last-price tag may belong to a later one (the
      // board draws one series per price source), so each series checks every tag in its pane.
      const drawn: ISeriesApi<Kind>[] = [];
      const syncLatestPrice = coinPriceMarker(css, library.LineStyle.Dashed, showCoinTag, !rollingWindow);
      const clearOfTags = (pane: number | undefined) => (price: number) =>
        drawn.every((other, index) => (series[index]!.pane ?? 0) !== (pane ?? 0) || clearOfTag(other, price,
          showCoinTag && index === current.latestPrice?.seriesIndex ? current.latestPrice.price : undefined));
      for (const [index, spec] of series.entries())
        drawn.push(configureSeries(chart!, spec, library, css, format, compact, hidden, tonedIndices.has(index) ? tones[tone] : null, clearOfTags(spec.pane), labelFormat));
      syncLatestPrice?.(drawn, current.latestPrice);
      const retone = (range: { from: Time; to: Time } | null) => {
        if (!range || !toned.length) return;
        const move = visibleMove(tonedData, {
          from: Number(range.from),
          to: Number(range.to),
        });
        if (!move || move === tone) return;
        tone = move;
        for (const index of toned)
          drawn[index]!.applyOptions(moveColors(series[index]!, tones[move]));
      };
      const scale = chart.timeScale();
      writeModel.current = (next) => {
        if (next === current) return;
        const range = scale.getVisibleRange();
        const logical = viewport.read();
        const previousTimes = times;
        const previousSeries = series;
        current = next;
        series = next.series;
        times = chartTimes(next);
        const timelineChanged = !sameTimes(previousTimes, times);
        if (timelineChanged) {
          setTimeline(times);
        }
        tonedData = toned.map((index) => series[index]!.data);
        for (const [index, spec] of series.entries()) {
          configureSeries(chart!, spec, library, css, format, compact, hidden, tonedIndices.has(index) ? tones[tone] : null,
            clearOfTags(spec.pane), labelFormat, drawn[index], previousSeries[index]);
        }
        syncLatestPrice?.(drawn, current.latestPrice);
        // Let the native first fit run before interpreting the viewport as a reader's zoom.
        if (viewReady && timelineChanged && previousTimes.length && times.length) {
          if (coinViewport && logical) viewport.write(rebaseCoinChartRange(logical, previousTimes, times, scale.width()));
          else if (range) preserveLiveView(chart!, range, logical, previousTimes, times);
        }
        retone(scale.getVisibleRange());
        afterChartWrite();
      };
      handle = {
        chart,
        series: drawn,
        host: node!,
        timeToCoordinate: (at) => {
          const exact = scale.timeToCoordinate(chartTimestamp(at));
          if (exact !== null) return Number(exact);
          const right = times.findIndex((time) => time > at);
          if (right <= 0) return null;
          const left = right - 1;
          return scale.logicalToCoordinate(
            (left +
              (at - times[left]!) / (times[right]! - times[left]!)) as Logical,
          );
        },
      };
      active.current = handle;
      chart.timeScale().subscribeVisibleLogicalRangeChange(schedule);
      chart.timeScale().subscribeVisibleTimeRangeChange(retone);
      chart.subscribeCrosshairMove((event) => {
        if (event.sourceEvent && event.point && event.time !== undefined)
          select(Number(event.time) * 1000);
      });
      chart.subscribeClick((event) => {
        if (event.time !== undefined) select(Number(event.time) * 1000);
      });
      restoreView(chart, previousView, times);
      retone(chart.timeScale().getVisibleRange());
      node!.dataset.ready = "true";
      setFailed(false);
      afterChartWrite();
      readyFrame = requestAnimationFrame(() => {
        if (!handle || disposed) return;
        viewReady = true;
        cleanupReady = ready(handle);
        afterChartWrite();
        // Pane configuration schedules a canvas draw. Let it paint before exposing it.
        readyFrame = handoffPreview();
      });
    }
    const resize = new ResizeObserver(() => {
      if (!node.clientWidth || !node.clientHeight) return;
      if (chart) {
        chart.resize(node.clientWidth, node.clientHeight);
        afterChartWrite();
      } else if (!mounting) {
        mounting = true;
        void mount()
          .catch(() => {
            if (!disposed) setFailed(true);
          })
          .finally(() => {
            mounting = false;
          });
      }
    });
    resize.observe(node);
    node.addEventListener("pointermove", schedule);
    node.addEventListener("pointerup", schedule);
    node.addEventListener("wheel", schedule, { passive: true });
    const keydown = (event: KeyboardEvent) => {
      if (event.target !== node || event.altKey || event.ctrlKey || event.metaKey) return;
      const range = viewport.read();
      const width = chart?.timeScale().width();
      if (!range || !width) return;
      const next = keyboardChartRange(event.key, range, times.length, width);
      if (!next) return;
      event.preventDefault();
      viewport.write(next);
    };
    if (coinViewport) node.addEventListener("keydown", keydown);
    const wheel = (event: WheelEvent) => {
      if (!interactive || !chart) return;
      const action = wheelAction(event);
      if (action === "page") return showHint();
      event.preventDefault();
      if (action === "pan") {
        // The live bar spacing: zooming changes it without updating the options.
        const scale = chart.timeScale();
        const delta = wheelPixels(event.deltaX, event.deltaMode);
        const range = viewport.read();
        if (!range) return;
        if (coinViewport) viewport.write(panChartRange(range, delta, scale.width()));
        else scale.scrollToPosition(pannedPosition(scale.scrollPosition(), delta, scale.width() / Math.max(range.to - range.from, 1)), false);
        return;
      }
      hideHint();
      zoomAt(chart, wheelPixels(event.deltaY, event.deltaMode), event.clientX, node, coinViewport ? viewport : undefined);
    };
    node.addEventListener("wheel", wheel, { passive: false });
    // Safari on a Mac sends a trackpad pinch as gesture events, not Ctrl + wheel. On a
    // touch screen the library already zooms on a pinch, so these stay off there.
    let pinch = 1;
    const gestureStart = (event: Event) => {
      if (!interactive || !chart) return;
      event.preventDefault();
      pinch = (event as GestureLike).scale;
    };
    const gestureChange = (event: Event) => {
      if (!interactive || !chart) return;
      event.preventDefault();
      const { scale, clientX } = event as GestureLike;
      if (scale > 0) zoomAt(chart, Math.log(pinch / scale) / 0.002, clientX, node, coinViewport ? viewport : undefined);
      pinch = scale;
    };
    const gestures = trackpadGestures(window, navigator);
    if (gestures) {
      node.addEventListener("gesturestart", gestureStart, { passive: false });
      node.addEventListener("gesturechange", gestureChange, { passive: false });
    }
    return () => {
      disposed = true;
      active.current = null;
      returnLive.current = null;
      writeModel.current = null;
      resize.disconnect();
      node.removeEventListener("pointermove", schedule);
      node.removeEventListener("pointerup", schedule);
      node.removeEventListener("wheel", schedule);
      node.removeEventListener("wheel", wheel);
      node.removeEventListener("keydown", keydown);
      if (gestures) {
        node.removeEventListener("gesturestart", gestureStart);
        node.removeEventListener("gesturechange", gestureChange);
      }
      cancel();
      cancelAnimationFrame(readyFrame);
      cleanupReady?.();
      const scale = viewReady ? chart?.timeScale() : undefined;
      const logical = coinViewport && scale ? viewport.read() : null;
      const range = scale?.getVisibleRange();
      if (scale && logical && times.length) {
        savedView.current = { rollingWindow, view: { logical, times, width: scale.width() } };
      } else if (range && times.length) {
        savedView.current = { rollingWindow, view: {
          range: { from: Number(range.from), to: Number(range.to) },
          first: times[0]! / 1000,
          last: times.at(-1)! / 1000,
        } };
      }
      chart?.remove();
      delete node.dataset.ready;
    };
  }, [
    mountKey,
    rollingWindow,
    compact,
    interactive,
    coinAxes,
    coinViewport,
    showCoinTag,
    intervalMs,
    scaleMargins,
    hidden,
    dark,
  ]);

  useLayoutEffect(() => {
    writeModel.current?.(model);
  }, [model]);

  // The series write above and its overlay belong to the same paint.
  // Pan and resize still reproject from the chart's own frame callbacks.
  useLayoutEffect(() => {
    if (active.current) project(active.current, false);
  }, [projectionKey]);

  return { host, returnLive, failed, browsing, firstFramePainted, showZoomHint: zoomHint.visible };
}

function ChartSurface({ host, className, compact, label, preview, coinViewport, showFooter, showLiveButton, onReturnLive, interactive, showZoomHint, failed }: Readonly<{
  host: Ref<HTMLDivElement>;
  className?: string;
  compact: boolean;
  label?: string;
  preview?: ReactNode;
  coinViewport: boolean;
  showFooter: boolean;
  showLiveButton: boolean;
  onReturnLive: () => void;
  interactive: boolean;
  showZoomHint: boolean;
  failed: boolean;
}>) {
  const zoomKey = useSyncExternalStore(noSubscribe, platformZoomKey, () => "Ctrl");
  const accessibility = chartSurfaceAccessibility(label, coinViewport, Boolean(preview));
  const credit = !compact && (
    <a
      className={styles.credit}
      title="TradingView Lightweight Charts™ · Copyright (с) 2025 TradingView, Inc."
      href="https://www.tradingview.com/"
      target="_blank"
      rel="noreferrer"
    >
      TradingView
    </a>
  );
  return (
    <div className={clsx(styles.host, showFooter && styles.hasFooter, className)}>
      <div
        className={clsx(styles.canvas, compact && styles.compact)}
        data-tradingview-plot=""
        ref={host}
        {...accessibility}
      />
      {preview && <div className={styles.preview} aria-hidden="true">{preview}</div>}
      {showFooter ? <div className={styles.footer}>
        {showLiveButton && <Button variant="secondary" size="sm" className={styles.backToLive} onClick={onReturnLive}>Back to live</Button>}
        {credit}
      </div> : credit}
      {interactive ? (
        <span className={styles.zoomHint} data-visible={showZoomHint || undefined} aria-hidden="true">
          {zoomKey} + scroll to zoom
        </span>
      ) : null}
      {failed ? (
        <span className={styles.failure} role="status">
          Chart unavailable. Refresh to retry.
        </span>
      ) : null}
    </div>
  );
}

function chartSurfaceAccessibility(label: string | undefined, coinViewport: boolean, hasPreview: boolean) {
  const accessibleLabel = label ?? (coinViewport ? "Price chart" : undefined);
  const keyboard = coinViewport && !hasPreview;
  return {
    role: accessibleLabel ? "img" as const : undefined,
    "aria-label": accessibleLabel,
    tabIndex: keyboard ? 0 : undefined,
    "aria-description": keyboard ? "Arrow keys pan. Plus/minus zoom." : undefined,
  };
}

/** Keep the latest close label on the scale. In Live, the guide would paint over the held close. */
function coinPriceMarker(css: CSSStyleDeclaration, lineStyle: LineStyle, enabled: boolean, lineVisible: boolean) {
  if (!enabled) return;
  const color = readChartColor(css, "--muted");
  const axisLabelColor = readChartColor(css, "--ink-2");
  const axisLabelTextColor = readChartColor(css, "--card");
  let marker: { owner: ISeriesApi<Kind>; line: IPriceLine } | undefined;

  return (series: readonly ISeriesApi<Kind>[], latest: Props["latestPrice"]) => {
    const owner = latest && series[latest.seriesIndex];
    if (marker && marker.owner !== owner) {
      marker.owner.removePriceLine(marker.line);
      marker = undefined;
    }
    if (!owner || !latest) return;
    if (!marker) {
      const line = owner.createPriceLine({ price: latest.price, lineStyle, color, axisLabelColor, axisLabelTextColor, lineWidth: 1, lineVisible });
      marker = { owner, line };
    } else if (marker.line.options().price !== latest.price) {
      marker.line.applyOptions({ price: latest.price });
    }
  };
}

function chartTimes({ series, timeline }: Pick<Props, "series" | "timeline">) {
  return [...new Set([...(timeline ?? []), ...series.flatMap((item) => item.data.map((point) => Number(point.time) * 1000))])].sort((a, b) => a - b);
}

function sameTimes(left: readonly number[], right: readonly number[]) {
  return left.length === right.length && left.every((time, index) => time === right[index]);
}

function restoreView(chart: IChartApi, previous: SavedChartView | CoinChartView | null, times: number[]) {
  const scale = chart.timeScale();
  if (!previous || !times.length) return scale.fitContent();
  if ("logical" in previous) {
    const range = rebaseCoinChartRange(previous.logical, previous.times, times, previous.width);
    return scale.setVisibleLogicalRange(resizedLiveChartRange(range, times.length, previous.width, scale.width()) ?? range);
  }
  const range = restoredChartRange(previous, times.at(-1)! / 1000);
  if (range) scale.setVisibleRange({ from: chartTimestamp(range.from * 1000), to: chartTimestamp(range.to * 1000) });
  else scale.fitContent();
}

/** Keep fractional bar positions so an incoming bucket cannot round away the reader's zoom. */
function preserveLiveView(chart: IChartApi, range: { from: Time; to: Time }, logical: IRange<number> | null, before: number[], after: number[]) {
  const view = { range: { from: Number(range.from), to: Number(range.to) }, first: before[0]! / 1000, last: before.at(-1)! / 1000 };
  if (!logical || (view.range.from <= view.first && view.range.to >= view.last)) {
    restoreView(chart, view, after);
    return;
  }
  const atLiveEdge = view.range.to >= view.last;
  const anchor = Math.max(0, Math.min(before.length - 1, Math.floor(logical.from)));
  const nextAnchor = atLiveEdge ? after.length - 1 : after.indexOf(before[anchor]!);
  if (nextAnchor < 0) {
    restoreView(chart, view, after);
    return;
  }
  const shift = nextAnchor - (atLiveEdge ? before.length - 1 : anchor);
  chart.timeScale().setVisibleLogicalRange({ from: logical.from + shift, to: logical.to + shift });
}

/** A line or area with no colour of its own follows the price move. */
function followsMove(spec: ChartSeries): boolean {
  if (spec.type === "Line") return !spec.options?.color;
  if (spec.type === "Area") return !spec.options?.lineColor;
  return false;
}

/** A line's colour, or an area's line and its soft fade (about 20% to nothing). */
function moveColors(spec: ChartSeries, color: string) {
  return spec.type === "Area"
    ? {
        lineColor: color,
        topColor: spec.options?.topColor ?? withAlpha(color, 0.2),
        bottomColor: spec.options?.bottomColor ?? withAlpha(color, 0),
      }
    : { color };
}

const chartColorTokens = new Set(["--up", "--down", "--pink", "--pink-ink", "--muted", "--faint", "--hair"]);

function readChartColor(css: CSSStyleDeclaration, token: string): string {
  const property = chartColorTokens.has(token) ? token.replace("--", "--chart-") : token;
  return css.getPropertyValue(property).trim() || css.color;
}

function configureSeries(
  chart: IChartApi,
  spec: ChartSeries,
  library: Awaited<ReturnType<typeof loadTradingView>>,
  css: CSSStyleDeclaration,
  format: (value: number, significant?: number) => string,
  compact: boolean,
  hidden: boolean,
  tone: string | null,
  clear: (price: number) => boolean,
  labelFormat: (price: number) => string,
  existing?: ISeriesApi<Kind>,
  previous?: ChartSeries,
): ISeriesApi<Kind> {
  const color = css.color;
  const up = readChartColor(css, "--up");
  const down = readChartColor(css, "--down");
  const resolve = <T extends object>(value: T): T =>
    Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (item === "currentColor") return [key, color];
        const token = typeof item === "string" ? /^var\((--[^,)]+)\)$/.exec(item)?.[1] : undefined;
        return [key, token ? readChartColor(css, token) : item];
      }),
    ) as T;

  const priceFormat = {
    type: "custom" as const,
    minMove: 0.000001,
    formatter: labelFormat,
    // Distinct labels first; then a tick the last-price tag would half cover is left blank so neither reads clipped.
    tickmarksFormatter: (prices: number[]) => distinctTicks(prices, format).map((label, index) => (clear(prices[index]) ? label : "")),
  };
  const common = {
    lastValueVisible: !compact && !hidden,
    priceLineVisible: !compact,
    priceFormat,
  };
  // Hidden amounts replace any series' own label formatter.
  const masked = hidden ? { priceFormat } : {};
  function configure<K extends Kind>(definition: SeriesDefinition<K>, options: SeriesPartialOptionsMap[K]) {
    if (existing) existing.applyOptions(options);
    return existing ?? chart.addSeries(definition, options, spec.pane);
  }
  let target: ISeriesApi<Kind>;
  switch (spec.type) {
    case "Line": {
      target = configure(
        library.LineSeries,
        {
          ...common,
          color: tone ?? color,
          lineWidth: 2,
          pointMarkersVisible: spec.data.length === 1,
          lineVisible: spec.data.length > 1,
          ...resolve(spec.options ?? {}),
          ...masked,
        },
      );
      break;
    }
    case "Area": {
      const options = resolve(spec.options ?? {});
      const lineColor = tone ?? options.lineColor ?? color;
      target = configure(
        library.AreaSeries,
        {
          ...common,
          lineColor,
          lineWidth: 2,
          // A lone point is a marker: no line, and no fill under it.
          topColor: spec.data.length > 1 ? withAlpha(lineColor, 0.2) : "transparent",
          bottomColor: spec.data.length > 1 ? withAlpha(lineColor, 0) : "transparent",
          pointMarkersVisible: spec.data.length === 1,
          lineVisible: spec.data.length > 1,
          ...options,
          ...masked,
        },
      );
      break;
    }
    case "Candlestick": {
      target = configure(
        library.CandlestickSeries,
        {
          ...common,
          upColor: up,
          downColor: down,
          borderUpColor: up,
          borderDownColor: down,
          wickUpColor: up,
          wickDownColor: down,
          ...resolve(spec.options ?? {}),
          ...masked,
        },
      );
      break;
    }
    case "Histogram": {
      target = configure(
        library.HistogramSeries,
        {
          ...common,
          color,
          ...resolve(spec.options ?? {}),
          ...masked,
        },
      );
      break;
    }
  }
  const change = seriesChange(previous?.data, spec.data);
  if (change === "tail") target.update(resolve(spec.data.at(-1)!));
  if (change === "replace") target.setData(spec.data.map((point) => resolve(point)));
  return target;
}

/** Safari's GestureEvent, which TypeScript's DOM library does not declare. */
type GestureLike = Event & { scale: number; clientX: number };

/** Zooms the time scale around the pointer; `delta` is wheel pixels, positive to zoom out. */
function zoomAt(chart: IChartApi, delta: number, clientX: number, node: HTMLElement, viewport?: ReturnType<typeof queuedChartRange>) {
  const scale = chart.timeScale();
  const range = viewport?.read() ?? scale.getVisibleLogicalRange();
  if (!range) return;
  const x = pointerX(clientX, node.getBoundingClientRect().left);
  if (viewport) return viewport.write(zoomChartRangeAtPixel(range, x, scale.width(), delta));
  const anchor = (x === null ? null : scale.coordinateToLogical(x)) ?? (range.from + range.to) / 2;
  scale.setVisibleLogicalRange(zoomChartRange(range, anchor, delta));
}

const noSubscribe = () => () => {};
const platformZoomKey = () => (/Mac|iPhone|iPad/.test(navigator.userAgent) ? "⌘" : "Ctrl");

/** The price axis keeps 4.75rem, the width of the TradingView credit beneath it, at the reader's font size. */
function priceAxisWidth(): number {
  return Math.round(4.75 * (parseFloat(getComputedStyle(document.documentElement).fontSize) || 16));
}

/** Half the last-price tag's height plus half a tick label's, at the 11px scale font. */
const TAG_CLEARANCE_PX = 16;

/** Whether a scale tick at `price` sits clear of the series' last-price tag (or the series shows none). */
function clearOfTag(series: ISeriesApi<Kind>, price: number, latestPrice?: number): boolean {
  if (latestPrice === undefined) {
    if (!series.options().lastValueVisible) return true;
    const last = series.lastValueData(false);
    if (last.noData) return true;
    latestPrice = last.price;
  }
  const tag = series.priceToCoordinate(latestPrice);
  const tick = series.priceToCoordinate(price);
  return tag === null || tick === null || Math.abs(tick - tag) >= TAG_CLEARANCE_PX;
}
