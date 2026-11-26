"use client";

import { dispose, init, type Chart, type Crosshair, type DeepPartial, type IndicatorCreate, type KLineData, type Period, type Styles, type VisibleRange } from "klinecharts";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { candleBucketStart, candleIntervalMs, type CandleInterval } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { Checkbox, Switch } from "#web/components/blast-ui/Checkbox.tsx";
import { NextIcon } from "#web/components/blast-ui/Icons.tsx";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import { dyn } from "#web/components/blast-ui/csp-style.ts";
import type { DrawnSeries } from "#web/components/launchpad/chart/chart-geometry.ts";
import { saveChartPreference, useChartPreference } from "#web/components/launchpad/chart/chart-preferences.ts";
import { shiftDecimal } from "#web/components/launchpad/coin/coin-format.ts";
import { useMobileChartLayout } from "../use-mobile-chart-layout.ts";
import { poolPrices } from "../candle-data.ts";
import type { CandleTrade } from "../candle-trade.ts";
import {
  barChanges, chartDate, fillGaps, foldTrades, isPaneStudy, klineBars, MAIN_INDICATORS, PANE_INDICATORS, PANE_LAYOUT, plotHeightFor, priceParts, pricePrecision, readChartSettings, ticksInside, toggleIndicator, forcesLine, volumeText,
  type Bar, type ChartSettings, type IndicatorName,
} from "./kline-model.ts";
import { BLAST_FIB, BLAST_GRADUATION, BLAST_RSI, registerStudies } from "./kline-studies.ts";
import { subscriptZeros } from "#web/lib/market-format.ts";
import { BubbleStage, PeopleBubbles } from "./PeopleBubbles.tsx";
import styles from "./KLineCoinChart.module.css";

const PERIODS: Readonly<Record<CandleInterval, Period>> = {
  "1s": { type: "second", span: 1 }, "1m": { type: "minute", span: 1 }, "5m": { type: "minute", span: 5 }, "15m": { type: "minute", span: 15 },
  "1h": { type: "hour", span: 1 }, "4h": { type: "hour", span: 4 }, "1d": { type: "day", span: 1 }, "1w": { type: "week", span: 1 },
};

/** Each drawing tool, its name and how many points it takes. */
const DRAWINGS = [
  ["segment", "Trend line", 2], ["rayLine", "Ray", 2], ["horizontalStraightLine", "Horizontal line", 1], ["priceLine", "Price line", 1], [BLAST_FIB, "Fibonacci", 2],
] as const;
type DrawingName = (typeof DRAWINGS)[number][0];
const INDICATOR_NAMES: Readonly<Record<IndicatorName, string>> = { MA: "Moving average", EMA: "Exponential MA", BOLL: "Bollinger bands", VOL: "Volume", MACD: "MACD", RSI: "RSI" };
const DRAWING_GROUP = "drawings";
const GRADUATION_GROUP = "graduation";
/** Trades the history has not caught up with yet; older ones are dropped. */
const MAX_PENDING_TRADES = 500;

/** A main-pane study legend row, which the price headroom and trader bubbles stay under. */
const LEGEND_ROW = 18;

export type KLineCoinChartProps = Readonly<{
  sources: readonly DrawnSeries[];
  interval: CandleInterval;
  memeDecimals: number | null;
  quoteDecimals: number | null;
  /** USD per quote coin; with it the chart is in USD. */
  quoteUsd: string | null;
  /** The quote coin's symbol, the unit of volume. */
  quoteSymbol: string;
  latestAvailable: boolean;
  label: string;
  /** Candles or a line; the page owns the picker (Live and a few trades always draw a line). */
  style: "candles" | "line";
  trade?: CandleTrade | null;
  /** When the coin left its curve for a pool, marked with a line. */
  migrationAt?: number;
}>;

/** The coin page's chart (KLineCharts): candles or line, studies, drawings and trader bubbles, live to the last trade. */
export default function KLineCoinChart({ sources, interval, memeDecimals, quoteDecimals, quoteUsd, quoteSymbol, latestAvailable, label, style, trade, migrationAt }: KLineCoinChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<Chart | null>(null);
  const shown = useRef<readonly Bar[]>([]);
  const push = useRef<((bar: KLineData) => void) | null>(null);
  const [view] = useState(() => ({ hovered: signal<number | null>(null), away: signal<number | null>(null) }));
  const [theme, setTheme] = useState(0);
  const savedIndicators = useChartPreference("indicators");
  const [chosen, setChosen] = useState<ChartSettings>();
  const settings = chosen ?? readChartSettings(savedIndicators || null);
  const mobile = useMobileChartLayout();
  const walletPreference = useChartPreference("wallet-tags");
  const [walletChoice, setWalletChoice] = useState<boolean>();
  const showWalletTags = walletChoice ?? walletPreference !== "hidden";
  const bars = useLiveBars(sources, interval, memeDecimals, quoteDecimals, quoteUsd, trade);
  const precision = pricePrecision(bars);
  const drawn = style === "line" || forcesLine(bars) ? "line" : "candles";
  const layout = mobile ? PANE_LAYOUT.phone : PANE_LAYOUT.desktop;
  const panes = settings.indicators.filter(isPaneStudy);
  const legendRows = mobile ? 0 : settings.indicators.length - panes.length;
  const plotHeight = plotHeightFor(settings.indicators, mobile);
  const drawing = useDrawings(chart);
  const [stepping, setStepping] = useState(false);
  // Arrow keys step the readout through the bars, Home and End jump to either end; a screen reader hears each one.
  const step = (event: React.KeyboardEvent) => {
    // Modified arrows stay the browser's (Back) and the library's (Shift scrolls).
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const move = ({ ArrowLeft: -1, ArrowRight: 1, Home: -Infinity, End: Infinity } as Record<string, number>)[event.key];
    if (move === undefined || bars.length === 0) return;
    event.preventDefault();
    setStepping(true);
    const at = view.hovered.get();
    const found = at === null ? -1 : bars.findIndex((bar) => bar.timestamp === at);
    const from = found < 0 ? bars.length - 1 : found;
    view.hovered.set(bars[Math.min(bars.length - 1, Math.max(0, from + move))]!.timestamp);
  };

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    registerStudies();
    const created = init(element, { decimalFold: { threshold: 4, format: foldZeros }, styles: themeStyles(palette(element)) });
    if (!created) return;
    // The plot itself is the one tab stop; the library's own container (tabIndex 1) stays out of the order.
    if (element.firstElementChild instanceof HTMLElement) element.firstElementChild.tabIndex = -1;
    created.setFormatter({ formatDate: ({ timestamp, template }) => chartDate(timestamp, template, created.getTimezone()) });
    created.overrideXAxis({ createTicks: ({ bounding, defaultTicks }) => ticksInside(defaultTicks, bounding.width) });
    chart.current = created;
    created.setDataLoader({
      getBars: ({ callback }) => callback([...shown.current], false),
      subscribeBar: ({ callback }) => { push.current = callback; },
      unsubscribeBar: () => { push.current = null; },
    });
    // The action carries only the pointer's x; the bar under it (none past the newest) is the readout's.
    created.subscribeAction("onCrosshairChange", (data) => {
      const x = (data as Crosshair | undefined)?.x;
      const [point] = x === undefined ? [] : [created.convertFromPixel([{ x }], { paneId: "candle_pane" })].flat();
      view.hovered.set(point?.dataIndex === undefined ? null : created.getDataList()[point.dataIndex]?.timestamp ?? null);
    });
    // KLineCharts reports no action when the mouse leaves; a finger's bar stays until the next tap.
    const leave = (event: PointerEvent) => { if (event.pointerType === "mouse") view.hovered.set(null); };
    element.addEventListener("pointerleave", leave);
    // Scrolled back by more than a bar: offer the way back to the newest one.
    // Away from the newest bar, the price axis's width places Latest just inside the plot.
    created.subscribeAction("onVisibleRangeChange", (data) => view.away.set((data as VisibleRange).realTo < created.getDataList().length - 1
      ? created.getSize("candle_pane", "yAxis")?.width ?? 0
      : null));
    const retheme = () => setTheme((count) => count + 1);
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", retheme);
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    motion.addEventListener("change", retheme);
    const themeObserver = new MutationObserver(retheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    const resize = new ResizeObserver(() => created.resize());
    resize.observe(element);
    return () => {
      scheme.removeEventListener("change", retheme);
      motion.removeEventListener("change", retheme);
      element.removeEventListener("pointerleave", leave);
      themeObserver.disconnect();
      resize.disconnect();
      chart.current = null;
      push.current = null;
      dispose(element);
    };
  }, [view]);

  // A new precision or interval reloads; otherwise new bars arrive as updates so zoom and scroll hold.
  useEffect(() => {
    const current = chart.current;
    if (!current) return;
    const period = PERIODS[interval];
    const symbolChanged = current.getSymbol()?.pricePrecision !== precision;
    const periodChanged = current.getPeriod()?.type !== period.type || current.getPeriod()?.span !== period.span;
    const changes = symbolChanged || periodChanged ? null : barChanges(shown.current, bars);
    if (changes?.kind === "update" && push.current) {
      shown.current = changes.kept;
      for (const bar of changes.bars) push.current({ ...bar });
      return;
    }
    shown.current = bars;
    if (symbolChanged) current.setSymbol({ ticker: "coin", pricePrecision: precision, volumePrecision: 2 });
    if (periodChanged) {
      // The zone goes with the period (set here on the first load too): see `chartZone`.
      current.setTimezone(chartZone(interval));
      current.setPeriod(period);
    }
    if (!symbolChanged && !periodChanged) current.resetData();
    fitBars(current, host.current, bars.length);
    view.away.set(null);
  }, [bars, precision, interval, view]);

  useEffect(() => {
    chart.current?.setStyles({ candle: { type: drawn === "line" ? "area" : "candle_solid", priceMark: { last: { show: latestAvailable } } } });
  }, [drawn, latestAvailable, theme]);

  // Studies, rebuilt with the theme: each has its own colours, and a pane study its own fixed height.
  useEffect(() => {
    const current = chart.current;
    const element = host.current;
    if (!current || !element) return;
    const colors = palette(element);
    current.setStyles(themeStyles(colors, mobile));
    for (const name of [...MAIN_INDICATORS, ...PANE_INDICATORS]) current.removeIndicator({ id: name });
    for (const name of settings.indicators) current.createIndicator(studyCreate(name, colors, precision), true);
    current.setPaneOptions({ id: "candle_pane", minHeight: layout.price });
    for (const name of settings.indicators) if (isPaneStudy(name)) {
      current.setPaneOptions({ id: `pane_${name}`, height: layout.pane, minHeight: Math.round(layout.pane * .6) });
      // Room for the pane's one legend row above its values.
      current.overrideYAxis({ paneId: `pane_${name}`, gap: { top: (LEGEND_ROW + 4) / layout.pane, bottom: .05 } });
    }
    // Headroom above the highest price for the study legends, so they never sit on a candle.
    current.overrideYAxis({ paneId: "candle_pane", gap: { top: (12 + LEGEND_ROW * legendRows) / layout.price, bottom: .06 } });
    current.resize();
  }, [settings.indicators, precision, theme, layout, legendRows, mobile]);

  const graduationAt = migrationAt === undefined ? undefined : bars.findLast((bar) => bar.timestamp <= migrationAt)?.timestamp;
  useEffect(() => {
    const current = chart.current;
    if (!current) return;
    current.removeOverlay({ groupId: GRADUATION_GROUP });
    if (graduationAt !== undefined) current.createOverlay({ name: BLAST_GRADUATION, groupId: GRADUATION_GROUP, lock: true, points: [{ timestamp: graduationAt }] });
  }, [graduationAt, theme]);

  const update = (next: ChartSettings) => {
    setChosen(next);
    saveChartPreference("indicators", JSON.stringify(next));
  };

  return (
    <div className={styles.chart} data-kline-chart="">
      <div className={styles.toolbar} role="group" aria-label="Chart tools">
        <IndicatorMenu settings={settings} onToggle={(name) => update(toggleIndicator(settings, name))} />
        <DrawMenu drawing={drawing} />
        <label className={styles.walletToggle}>
          Traders
          <Switch checked={showWalletTags} onCheckedChange={(visible) => { setWalletChoice(visible); saveChartPreference("wallet-tags", visible ? "shown" : "hidden"); }} />
        </label>
      </div>
      {drawing.active
        ? <DrawingHint name={drawing.active.name} touch={mobile} onCancel={drawing.cancel} />
        : <Readout bars={bars} hovered={view.hovered} interval={interval} precision={precision} unit={quoteUsd ? "USD" : quoteSymbol} quoteSymbol={quoteSymbol} spoken={stepping}
          remove={drawing.selected && { name: drawingName(drawing.selected.name), onRemove: drawing.removeSelected }} />}
      <BubbleStage>
        <div ref={host} className={styles.plot} role="group" aria-label={`${label}. Arrow keys step through the bars.`} tabIndex={0} data-kline-plot=""
          onKeyDown={step} onBlur={() => { setStepping(false); view.hovered.set(null); }} {...dyn({ blockSize: plotHeight })} />
        {showWalletTags && <PeopleBubbles chart={chart} bars={bars} quoteDecimals={quoteDecimals} quoteUsd={quoteUsd} topInset={8 + LEGEND_ROW * legendRows} />}
        <LatestButton away={view.away} onLatest={() => {
          const current = chart.current;
          if (!current) return;
          current.scrollToRealTime(matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200);
        }} />
      </BubbleStage>
    </div>
  );
}


/** A value the chart's canvas callbacks set and a small part of the page reads, without re-rendering the whole chart. */
type Signal<T> = Readonly<{ get: () => T; set: (next: T) => void; subscribe: (listener: () => void) => () => void }>;
function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set: (next) => { if (next === value) return; value = next; for (const listener of listeners) listener(); },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
const useSignal = <T,>(value: Signal<T>) => useSyncExternalStore(value.subscribe, value.get, value.get);

/**
 * The bar under the pointer (or the finger), else the newest: its time in the viewer's
 * zone, open, high, low, close, the change from the bar before, and its volume. One row
 * that keeps its height, so moving across the chart never moves the page.
 */
function Readout({ bars, hovered, interval, precision, unit, quoteSymbol, spoken, remove }: Readonly<{
  bars: readonly Bar[]; hovered: Signal<number | null>; interval: CandleInterval; precision: number; unit: string; quoteSymbol: string;
  /** Read out each change, while the keyboard steps through the bars. */
  spoken: boolean;
  /** The selected drawing, removed from the row's end (Delete does the same); the bar's values stay. */
  remove: Readonly<{ name: string; onRemove: () => void }> | null;
}>) {
  const at = useSignal(hovered);
  const found = at === null ? -1 : bars.findIndex((bar) => bar.timestamp === at);
  const index = found < 0 ? bars.length - 1 : found;
  const bar = bars[index];
  const dateTime = useMemo(() => readoutDate(interval), [interval]);
  if (!bar) return <p className={styles.readout} aria-hidden="true" />;
  return <p className={`${styles.readout} ${remove ? styles.hintRow : ""}`} aria-live={spoken ? "polite" : "off"} data-latest={index === bars.length - 1 || undefined} data-removing={remove ? "" : undefined} data-no-trades={bar.volume === 0 || undefined}>
    <span className={styles.readoutLine}>
      <span className={styles.readoutTime}>
        <time dateTime={new Date(bar.timestamp).toISOString()}>{dateTime.format(bar.timestamp)}</time>
        {found < 0 && <span className={styles.readoutTag} data-tag="latest">Latest</span>}
        {bar.volume === 0 && <span className={styles.readoutTag}>No trades</span>}
      </span>
      <span className={styles.readoutVolume}><abbr title="Volume">Vol</abbr> {volumeText(bar.volume)} {quoteSymbol}</span>
    </span>
    <ReadoutPrices bar={bar} previous={bars[index - 1]?.close ?? bar.open} precision={precision} />
    <span className="sr-only"> Prices in {unit}.</span>
    {remove && <span className={styles.readoutRemove}><Button variant="ghost" size="sm" onClick={remove.onRemove} aria-label={`Remove ${remove.name.toLowerCase()}`}>Remove</Button></span>}
  </p>;
}

const direction = (delta: number) => delta > 0 ? "up" : delta < 0 ? "down" : undefined;

/** Open, high, low and close, coloured by the bar's direction, then the change from the close before. */
function ReadoutPrices({ bar, previous, precision }: Readonly<{ bar: Bar; previous: number; precision: number }>) {
  const change = previous > 0 ? (bar.close - previous) / previous : 0;
  return <span className={styles.readoutPrices} data-side={direction(bar.close - bar.open)}>
    {(["O", "H", "L", "C"] as const).map((key) => <span key={key}>
      <abbr title={{ O: "Open", H: "High", L: "Low", C: "Close" }[key]}>{key}</abbr>{" "}
      <PriceText value={bar[({ O: "open", H: "high", L: "low", C: "close" } as const)[key]]} precision={precision} />
    </span>)}
    <span data-side={direction(change)}>{change > 0 ? "+" : ""}{(change * 100).toFixed(2)}%</span>
  </span>;
}

/** Daily and weekly candles start at 00:00 UTC, so their dates read in UTC; shorter ones in the viewer's own zone. */
function chartZone(interval: CandleInterval) {
  return dailyCandles(interval) ? "UTC" : Intl.DateTimeFormat().resolvedOptions().timeZone;
}

const dailyCandles = (interval: CandleInterval) => interval === "1d" || interval === "1w";

/** Day and time in the viewer's own zone, with its name; seconds on the 1s chart, the date alone for days and weeks (UTC days, as their candles are cut). */
function readoutDate(interval: CandleInterval) {
  return new Intl.DateTimeFormat(undefined, dailyCandles(interval)
    ? { year: "numeric", month: "short", day: "numeric", timeZone: "UTC", timeZoneName: "short" }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: interval === "1s" ? "2-digit" : undefined, hourCycle: "h23", timeZoneName: "short" });
}

/** The axis and legend fold: 0.0₄812 for 0.0000812, on either side of zero (MACD runs negative). */
function foldZeros(value: string | number) {
  const text = String(value);
  if (Number(text) === 0) return "0";
  return text.startsWith("-") ? `-${subscriptZeros(text.slice(1))}` : subscriptZeros(text);
}

/** A price with its leading zeros counted in a subscript: 0.0₄812 reads as 0.0000812. */
function PriceText({ value, precision }: Readonly<{ value: number; precision: number }>) {
  const { text, zeros, rest } = priceParts(value, precision);
  if (zeros === undefined) return <span className={styles.price}>{text}</span>;
  return <span className={styles.price} aria-label={text}>0.0<sub>{zeros}</sub>{rest}</span>;
}

/**
 * Shown in the readout's place while a drawing waits for its points (with Cancel), or while
 * one is selected (with Remove), so the toolbar never grows a row.
 */
function DrawingHint({ name, touch, onCancel }: Readonly<{ name: string; touch: boolean; onCancel: () => void }>) {
  const points = DRAWINGS.find(([tool]) => tool === name)?.[2] ?? 2;
  const help = `${touch ? "Tap" : "Click"} ${points === 1 ? "one point" : "two points"} on the chart.${touch ? "" : " Esc cancels."}`;
  return <p className={`${styles.readout} ${styles.hintRow}`} role="status">
    <span className={styles.hint}><strong>{drawingName(name)}</strong> {help}</span>
    <Button variant="ghost" size="sm" className={styles.hintCancel} onClick={onCancel}>Cancel</Button>
  </p>;
}

/** A drawing tool's name as the Draw menu shows it. */
const drawingName = (name: string) => DRAWINGS.find(([tool]) => tool === name)?.[1] ?? "Drawing";

/** Floats over the newest corner once the viewer has scrolled back; one press returns to the newest bar. */
function LatestButton({ away, onLatest }: Readonly<{ away: Signal<number | null>; onLatest: () => void }>) {
  const axis = useSignal(away);
  if (axis === null) return null;
  return <div className={styles.latest} {...dyn({ insetInlineEnd: axis + 8 })}>
    <Button variant="ink" size="sm" onClick={onLatest} aria-label="Back to the newest bar">Latest <NextIcon /></Button>
  </div>;
}

/**
 * The drawings on the chart: the tool waiting for its points, the one selected, and the
 * order they were made in, for Undo. Esc cancels a drawing; Delete removes the selected one.
 */
function useDrawings(chart: React.RefObject<Chart | null>) {
  const [active, setActive] = useState<Readonly<{ id: string; name: DrawingName }> | null>(null);
  const [selected, setSelected] = useState<Readonly<{ id: string; name: string }> | null>(null);
  const [made, setMade] = useState<readonly string[]>([]);
  const forget = (id: string) => {
    setMade((ids) => ids.filter((item) => item !== id));
    setSelected((current) => current?.id === id ? null : current);
  };
  const cancel = () => {
    if (active) chart.current?.removeOverlay({ id: active.id });
    setActive(null);
  };
  const removeSelected = () => {
    if (!selected) return;
    chart.current?.removeOverlay({ id: selected.id });
    forget(selected.id);
  };
  useEffect(() => {
    if (!active && !selected) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable]")) return;
      if (event.key === "Escape" && active) { chart.current?.removeOverlay({ id: active.id }); setActive(null); }
      else if ((event.key === "Delete" || event.key === "Backspace") && selected && !active) {
        chart.current?.removeOverlay({ id: selected.id });
        setMade((ids) => ids.filter((item) => item !== selected.id));
        setSelected(null);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [active, selected, chart]);
  return {
    active, selected, count: made.length, cancel, removeSelected,
    start: (name: DrawingName) => {
      const current = chart.current;
      if (!current) return;
      if (active) current.removeOverlay({ id: active.id });
      const id = current.createOverlay({
        name, groupId: DRAWING_GROUP,
        onDrawEnd: ({ overlay }) => { setActive(null); setMade((ids) => [...ids, overlay.id]); },
        onSelected: ({ overlay }) => setSelected({ id: overlay.id, name: overlay.name }),
        onDeselected: ({ overlay }) => setSelected((current) => current?.id === overlay.id ? null : current),
        onRemoved: ({ overlay }) => forget(overlay.id),
      });
      setActive(typeof id === "string" ? { id, name } : null);
    },
    undo: () => {
      const last = made.at(-1);
      if (!last) return;
      chart.current?.removeOverlay({ id: last });
      forget(last);
    },
    clear: () => {
      chart.current?.removeOverlay({ groupId: DRAWING_GROUP });
      setActive(null);
      setSelected(null);
      setMade([]);
    },
  };
}

/** History bars with every live trade it has not seen yet folded into the open bars. */
function useLiveBars(sources: readonly DrawnSeries[], interval: CandleInterval, memeDecimals: number | null, quoteDecimals: number | null, quoteUsd: string | null, trade?: CandleTrade | null) {
  const history = useMemo(() => klineBars(sources, memeDecimals, quoteDecimals, quoteUsd), [sources, memeDecimals, quoteDecimals, quoteUsd]);
  const now = useBucketStart(interval);
  const [pending, setPending] = useState<readonly CandleTrade[]>([]);
  const [seen, setSeen] = useState(trade);
  if (trade !== seen) {
    setSeen(trade);
    if (trade?.trade.price) setPending((held) => [...held.filter((item) => item.trade.cursor !== trade.trade.cursor), trade].slice(-MAX_PENDING_TRADES));
  }
  return useMemo(() => {
    if (memeDecimals === null) return fillGaps(history, interval, now);
    const shown = poolPrices(memeDecimals, quoteDecimals, quoteUsd);
    const quote = poolPrices(memeDecimals, quoteDecimals);
    const unseen = pending.flatMap(({ poolKey, trade: { timestampMs, price, memeAmount } }) => {
      if (!price) return [];
      const pool = sources.find(({ page }) => page.poolKey === poolKey);
      if (!pool || (pool.observedAt != null && timestampMs <= pool.observedAt)) return [];
      const volume = Number(shiftDecimal(memeAmount.toString(), -memeDecimals)) * Number(quote.price(price));
      return [{ timestampMs, price: Number(shown.price(price)), volume }];
    });
    return fillGaps(foldTrades(history, interval, unseen), interval, now);
  }, [history, interval, now, memeDecimals, quoteDecimals, quoteUsd, sources, pending]);
}

/** The start of the bucket now in, moving on at each bucket boundary so a quiet chart keeps time. */
function useBucketStart(interval: CandleInterval): number {
  const step = candleIntervalMs(interval);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setTimeout(() => setNow(Date.now()), step - (Date.now() % step) + 50);
    return () => window.clearTimeout(timer);
  }, [now, step]);
  return candleBucketStart(interval, now);
}

/** The chosen range fills the plot; a range too long for 2 px a bar scrolls from its newest bar. */
function fitBars(chart: Chart, element: HTMLElement | null, count: number) {
  if (!element || count === 0) return;
  const plot = element.clientWidth - 72;
  chart.setOffsetRightDistance(12);
  chart.setBarSpace(Math.min(12, Math.max(2, (plot - 12) / count)));
}

type Palette = Readonly<Record<"up" | "down" | "ink" | "muted" | "hair" | "card" | "ink2" | "tint1" | "tint2" | "tint3" | "family", string>>;

/** The page's tokens resolved to colours the canvas can use. */
function palette(element: HTMLElement): Palette {
  const probe = document.createElement("span");
  element.append(probe);
  const resolve = (token: string) => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  const tokens = { up: "--coin-chart-up", down: "--coin-chart-down", ink: "--ink", muted: "--muted", hair: "--hair", card: "--card", ink2: "--ink-2", tint1: "--ink-tint-1", tint2: "--ink-tint-2", tint3: "--ink-tint-3" };
  const colors = Object.fromEntries(Object.entries(tokens).map(([key, token]) => [key, resolve(token)]));
  probe.remove();
  return { ...colors, family: getComputedStyle(element).fontFamily } as Palette;
}

/** `color` (as the browser resolves it, `rgb(…)`) at `opacity`. */
function faded(color: string, opacity: number): string {
  const [r = 0, g = 0, b = 0] = color.match(/[\d.]+/g)?.map(Number) ?? [];
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * Each study as traders know it: MA 7/25/99, EMA 9/21, Bollinger bands, MACD and RSI 14 with
 * 30/70 guides. Data series stay in ink and grey (design system), so lines on one pane differ
 * by shade and stroke: solid, dashed, dotted, dash-dot, long dash. Volume bars take the candle colours
 * and the readout carries their value.
 */
/** Dash patterns (on, off, …) in px that tell study lines apart without a hue. */
const STROKES = { solid: [], dashed: [5, 3], dotted: [1.5, 2.5], dashDot: [6, 3, 1.5, 3], longDash: [10, 4] } as const;

function studyCreate(name: IndicatorName, colors: Palette, precision: number): IndicatorCreate {
  const line = (color: string, stroke: keyof typeof STROKES = "solid") => ({ color, size: stroke === "solid" ? 1 : 1.25, style: stroke === "solid" ? "solid" as const : "dashed" as const, smooth: false, dashedValue: [...STROKES[stroke]] });
  const pane = `pane_${name}`;
  const main = { paneId: "candle_pane" };
  switch (name) {
    case "MA": return { name, id: name, ...main, calcParams: [7, 25, 99], styles: { lines: [line(colors.ink2), line(colors.tint1, "dashed"), line(colors.tint2, "dotted")] } };
    case "EMA": return { name, id: name, ...main, calcParams: [9, 21], styles: { lines: [line(colors.ink2, "dashDot"), line(colors.tint1, "longDash")] } };
    case "BOLL": return { name, id: name, ...main, styles: { lines: [line(colors.tint2), line(colors.tint1, "dashed"), line(colors.tint2)] } };
    // The readout gives the bar's volume with its unit, so the pane keeps no legend of its own.
    case "VOL": return { name, id: name, paneId: pane, calcParams: [], precision: 2, createTooltipDataSource: () => ({ name: "", calcParamsText: "", features: [], legends: [] }), styles: { bars: [{ upColor: faded(colors.up, .5), downColor: faded(colors.down, .5), noChangeColor: faded(colors.muted, .5) }] } };
    case "MACD": return { name, id: name, paneId: pane, precision: Math.min(16, precision + 1), styles: { lines: [line(colors.ink2), line(colors.tint1, "dashed")] } };
    case "RSI": return { name: BLAST_RSI, id: name, paneId: pane, styles: { lines: [line(colors.ink2)] } };
  }
}

function themeStyles(colors: Palette, phone = false): DeepPartial<Styles> {
  const { up, down, ink, muted, hair, card, family } = colors;
  const text = { color: muted, size: 11, family };
  const legend = { color: muted, family, size: 11 };
  const label = { color: card, family };
  const overlayText = { color: card, family, size: 11, backgroundColor: ink, borderColor: ink, borderRadius: 3 };
  return {
    grid: { horizontal: { color: hair }, vertical: { show: false } },
    candle: {
      bar: { upColor: up, downColor: down, noChangeColor: muted, upBorderColor: up, downBorderColor: down, noChangeBorderColor: muted, upWickColor: up, downWickColor: down, noChangeWickColor: muted },
      // The newest price pulses in ink, and holds still for anyone who asked for less motion.
      area: { lineColor: ink, backgroundColor: [{ offset: 0, color: "rgba(0,0,0,0)" }, { offset: 1, color: "rgba(0,0,0,0)" }],
        point: { color: ink, rippleColor: faded(ink, .2), animation: !matchMedia("(prefers-reduced-motion: reduce)").matches } },
      priceMark: { high: { color: muted, textFamily: family }, low: { color: muted, textFamily: family }, last: { upColor: up, downColor: down, noChangeColor: muted, text: label } },
      // The readout row above the plot carries the bar's time, prices and volume.
      tooltip: { showRule: "none" },
    },
    indicator: { ohlc: { upColor: up, downColor: down, noChangeColor: muted }, bars: [{ upColor: up, downColor: down, noChangeColor: muted }],
      // A phone has no room for legend rows over the price: they show while a finger is on the chart.
      tooltip: { showRule: phone ? "follow_cross" : "always", title: { ...legend, show: false }, legend } },
    xAxis: { axisLine: { color: hair }, tickLine: { color: hair }, tickText: text },
    yAxis: { axisLine: { color: hair }, tickLine: { color: hair }, tickText: text },
    separator: { color: hair },
    crosshair: { horizontal: { line: { color: muted }, text: { ...label, backgroundColor: ink, borderColor: ink } }, vertical: { line: { color: muted }, text: { ...label, backgroundColor: ink, borderColor: ink } } },
    // Drawings in ink, like the price line, with ink labels on the axes.
    overlay: {
      point: { color: ink, borderColor: faded(ink, .3), activeColor: ink, activeBorderColor: faded(ink, .3) },
      line: { color: ink },
      // The library's blue is gone everywhere: the axis band a drawing spans is a faint ink wash.
      rect: { color: faded(ink, .08), borderColor: faded(ink, .3) },
      polygon: { color: faded(ink, .08), borderColor: faded(ink, .3) },
      circle: { color: faded(ink, .08), borderColor: faded(ink, .3) },
      arc: { color: ink },
      text: overlayText,
      rectText: overlayText,
    },
  };
}

function IndicatorMenu({ settings, onToggle }: Readonly<{ settings: ChartSettings; onToggle: (name: IndicatorName) => void }>) {
  const on = new Set(settings.indicators);
  return <Popover.Root>
    <Popover.Trigger render={<Button variant="ghost" size="sm" />}>Indicators</Popover.Trigger>
    <PopoverSurface positioner={{ side: "bottom", align: "start", sideOffset: 4, className: styles.layer }} popup={{ className: styles.menu, "aria-label": "Indicators" }}>
      {[...MAIN_INDICATORS, ...PANE_INDICATORS].map((name) => <label key={name} className={styles.menuItem}>
        <Checkbox checked={on.has(name)} onChange={() => onToggle(name)} />
        {INDICATOR_NAMES[name]}
      </label>)}
    </PopoverSurface>
  </Popover.Root>;
}

function DrawMenu({ drawing }: Readonly<{ drawing: ReturnType<typeof useDrawings> }>) {
  return <Popover.Root>
    <Popover.Trigger render={<Button variant="ghost" size="sm" data-active={drawing.active ? "" : undefined} />}>Draw</Popover.Trigger>
    <PopoverSurface positioner={{ side: "bottom", align: "start", sideOffset: 4, className: styles.layer }} popup={{ className: styles.menu, "aria-label": "Drawing tools" }}>
      {DRAWINGS.map(([name, text]) => <Popover.Close key={name} render={<Button variant="ghost" size="sm" className={styles.menuButton} />} onClick={() => drawing.start(name)}>{text}</Popover.Close>)}
      <hr className={styles.menuRule} />
      <Popover.Close render={<Button variant="ghost" size="sm" className={styles.menuButton} />} disabled={!drawing.count} onClick={drawing.undo}>Undo last drawing</Popover.Close>
      <Popover.Close render={<Button variant="ghost" size="sm" className={styles.menuButton} />} disabled={!drawing.count} onClick={drawing.clear}>Clear drawings</Popover.Close>
    </PopoverSurface>
  </Popover.Root>;
}
