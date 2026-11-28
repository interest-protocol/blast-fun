"use client";

import { dispose, init, type Chart, type Crosshair, type DeepPartial, type IndicatorCreate, type KLineData, type Period, type Styles, type VisibleRange } from "klinecharts";
import { useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { candleBucketStart, candleIntervalMs, type CandleInterval } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { NextIcon } from "#web/components/blast-ui/Icons.tsx";
import { dyn } from "#web/components/blast-ui/csp-style.ts";
import type { DrawnSeries } from "#web/components/launchpad/chart/chart-geometry.ts";
import { shiftDecimal } from "#web/components/launchpad/coin/coin-format.ts";
import { useMobileChartLayout } from "../use-mobile-chart-layout.ts";
import { poolPrices } from "../candle-data.ts";
import type { CandleTrade } from "../candle-trade.ts";
import {
  barChanges, chartDate, fillGaps, foldTrades, klineBars, PANE_LAYOUT, plotHeightFor, priceParts, pricePrecision, ticksInside, topGap, volumeText,
  type Bar,
} from "./kline-model.ts";
import { BLAST_GRADUATION, registerGraduation } from "./kline-studies.ts";
import { subscriptZeros } from "#web/lib/market-format.ts";
import { BUBBLE_SIZE, BubbleStage, PeopleBubbles } from "./PeopleBubbles.tsx";
import { ChartPeopleTrades } from "./chart-people-trades.ts";
import { bubbleHeadroom } from "./people-bubbles.ts";
import styles from "./KLineCoinChart.module.css";

const PERIODS: Readonly<Record<CandleInterval, Period>> = {
  "1s": { type: "second", span: 1 }, "1m": { type: "minute", span: 1 }, "5m": { type: "minute", span: 5 }, "15m": { type: "minute", span: 15 },
  "1h": { type: "hour", span: 1 }, "4h": { type: "hour", span: 4 }, "1d": { type: "day", span: 1 }, "1w": { type: "week", span: 1 },
};

const GRADUATION_GROUP = "graduation";
/** Trades the history has not caught up with yet; older ones are dropped. */
const MAX_PENDING_TRADES = 500;

/** The volume pane's id, as KLineCharts names an indicator's own pane. */
const VOLUME_PANE = "pane_VOL";

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
  /** Show the traders' bubbles on their bars; the page owns the switch. */
  traders: boolean;
  trade?: CandleTrade | null;
  /** When the coin left its curve for a pool, marked with a line. */
  migrationAt?: number;
}>;

/** The coin page's chart (KLineCharts): candles, volume and trader bubbles, live to the last trade. */
export default function KLineCoinChart({ sources, interval, memeDecimals, quoteDecimals, quoteUsd, quoteSymbol, latestAvailable, label, traders, trade, migrationAt }: KLineCoinChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<Chart | null>(null);
  const shown = useRef<readonly Bar[]>([]);
  const push = useRef<((bar: KLineData) => void) | null>(null);
  const [view] = useState(() => ({ hovered: signal<number | null>(null), away: signal<number | null>(null) }));
  const [theme, setTheme] = useState(0);
  const mobile = useMobileChartLayout();
  const coinTrades = useContext(ChartPeopleTrades);
  const bars = useLiveBars(sources, interval, memeDecimals, quoteDecimals, quoteUsd, trade);
  const precision = pricePrecision(bars);
  const layout = mobile ? PANE_LAYOUT.phone : PANE_LAYOUT.desktop;
  const plotHeight = plotHeightFor(mobile);
  const [stepping, setStepping] = useState(false);
  // The price pane as drawn: a short phone or a tall window resizes the plot (`--kline-grow`), and the pane takes the change.
  const [pricePane, setPricePane] = useState<number | null>(null);
  const priceHeight = pricePane ?? layout.price;
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
    registerGraduation();
    const created = init(element, { decimalFold: { threshold: 4, format: foldZeros }, styles: themeStyles(palette(element)) });
    if (!created) return;
    const container = element.firstElementChild instanceof HTMLElement ? element.firstElementChild : null;
    if (container) {
      // The plot itself is the one tab stop; the library's own container (tabIndex 1) stays out of the order.
      container.tabIndex = -1;
      // The library takes every touch; a vertical swipe on the chart scrolls the page instead.
      container.style.touchAction = "pan-y";
    }
    created.setFormatter({ formatDate: ({ timestamp, template }) => chartDate(timestamp, template, created.getTimezone()) });
    created.overrideXAxis({ createTicks: ({ bounding, defaultTicks }) => ticksInside(defaultTicks, bounding.width) });
    chart.current = created;
    created.setDataLoader({
      getBars: ({ callback }) => callback([...shown.current], false),
      subscribeBar: ({ callback }) => { push.current = callback; },
      unsubscribeBar: () => { push.current = null; },
    });
    // The action carries only the pointer's x; the bar under it (none past the newest) is the readout's.
    let touching = false;
    created.subscribeAction("onCrosshairChange", (data) => {
      const x = (data as Crosshair | undefined)?.x;
      // A finger's drag reads to the library as a pan, which clears its crosshair: the finger's readout stays.
      if (x === undefined && touching) return;
      view.hovered.set(x === undefined ? null : barAt(created, x));
    });
    // KLineCharts reports no action when the mouse leaves.
    const leave = (event: PointerEvent) => { if (event.pointerType === "mouse") view.hovered.set(null); };
    element.addEventListener("pointerleave", leave);
    // A finger scrubs: the readout and crosshair follow it from the first touch, and go when it lifts.
    // The library would pan on a sideways drag instead, so a touch turns its scrolling off (a mouse still drags to scroll).
    let lifted = 0;
    const press = (event: PointerEvent) => created.setScrollEnabled(event.pointerType !== "touch");
    // Touch events reach this element after the library's own handlers on its inner container, so the finger's crosshair is the last word.
    const scrub = (event: TouchEvent) => {
      const finger = event.touches[0];
      if (!finger) return;
      touching = true;
      window.clearTimeout(lifted);
      const box = element.getBoundingClientRect();
      const x = finger.clientX - box.left;
      const y = Math.min(finger.clientY - box.top, created.getSize("candle_pane")?.height ?? Infinity);
      created.executeAction("onCrosshairChange", { x, y, paneId: "candle_pane" });
      view.hovered.set(barAt(created, x));
    };
    const lift = (event: TouchEvent) => {
      if (event.touches.length) return;
      touching = false;
      // After the library's own tap handling, which would show the crosshair again; null clears it (its type has no null).
      lifted = window.setTimeout(() => {
        created.executeAction("onCrosshairChange", null as unknown as Crosshair);
        view.hovered.set(null);
      });
    };
    element.addEventListener("pointerdown", press);
    element.addEventListener("touchstart", scrub, { passive: true });
    element.addEventListener("touchmove", scrub, { passive: true });
    element.addEventListener("touchend", lift);
    element.addEventListener("touchcancel", lift);
    // Scrolled back by more than a bar: offer the way back to the newest one.
    // Away from the newest bar, the price axis's width places Latest just inside the plot.
    created.subscribeAction("onVisibleRangeChange", (data) => view.away.set((data as VisibleRange).realTo < created.getDataList().length - 1
      ? created.getSize("candle_pane", "yAxis")?.width ?? 0
      : null));
    const retheme = () => setTheme((count) => count + 1);
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", retheme);
    const themeObserver = new MutationObserver(retheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    const resize = new ResizeObserver(() => {
      created.resize();
      setPricePane(created.getSize("candle_pane")?.height ?? null);
    });
    resize.observe(element);
    return () => {
      scheme.removeEventListener("change", retheme);
      element.removeEventListener("pointerleave", leave);
      element.removeEventListener("pointerdown", press);
      element.removeEventListener("touchstart", scrub);
      element.removeEventListener("touchmove", scrub);
      element.removeEventListener("touchend", lift);
      element.removeEventListener("touchcancel", lift);
      window.clearTimeout(lifted);
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
    chart.current?.setStyles({ candle: { priceMark: { last: { show: latestAvailable } } } });
  }, [latestAvailable, theme]);

  // Volume in its own pane under the price, rebuilt with the theme for its colours.
  useEffect(() => {
    const current = chart.current;
    const element = host.current;
    if (!current || !element) return;
    const colors = palette(element);
    current.setStyles(themeStyles(colors));
    current.removeIndicator({ id: "VOL" });
    current.createIndicator(volumeCreate(colors), true);
    current.setPaneOptions({ id: "candle_pane", minHeight: layout.price });
    current.setPaneOptions({ id: VOLUME_PANE, height: layout.pane, minHeight: Math.round(layout.pane * .6) });
    current.overrideYAxis({ paneId: VOLUME_PANE, gap: { top: .1, bottom: .05 } });
    current.resize();
  }, [theme, layout]);

  // Headroom above the highest price for a trader's bubble and its gap over the top bar, so it never sits on the price.
  useEffect(() => {
    const room = traders ? bubbleHeadroom(BUBBLE_SIZE) : 0;
    chart.current?.overrideYAxis({ paneId: "candle_pane", gap: { top: topGap(12 + room, priceHeight, .06), bottom: .06 } });
  }, [priceHeight, traders]);

  const graduationAt = migrationAt === undefined ? undefined : bars.findLast((bar) => bar.timestamp <= migrationAt)?.timestamp;
  useEffect(() => {
    const current = chart.current;
    if (!current) return;
    current.removeOverlay({ groupId: GRADUATION_GROUP });
    if (graduationAt !== undefined) current.createOverlay({ name: BLAST_GRADUATION, groupId: GRADUATION_GROUP, lock: true, points: [{ timestamp: graduationAt }] });
  }, [graduationAt, theme]);

  return (
    <div className={styles.chart} data-kline-chart="">
      <BubbleStage>
        <Readout bars={bars} hovered={view.hovered} interval={interval} precision={precision} unit={quoteUsd ? "USD" : quoteSymbol} quoteSymbol={quoteSymbol} spoken={stepping} />
        <div ref={host} className={styles.plot} role="group" aria-label={`${label}. Arrow keys step through the bars.`} tabIndex={0} data-kline-plot=""
          onKeyDown={step} onBlur={() => { setStepping(false); view.hovered.set(null); }} {...dyn({ "--kline-base": `${plotHeight}px` } as CSSProperties)} />
        {traders && <PeopleBubbles chart={chart} bars={bars} interval={interval} coinTrades={coinTrades} quoteDecimals={quoteDecimals} quoteUsd={quoteUsd} topInset={8} />}
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

/** The bar's timestamp under `x` px on the price pane; null past the newest bar. */
function barAt(chart: Chart, x: number): number | null {
  const [point] = [chart.convertFromPixel([{ x }], { paneId: "candle_pane" })].flat();
  return point?.dataIndex === undefined ? null : chart.getDataList()[point.dataIndex]?.timestamp ?? null;
}

/**
 * The bar under the pointer or finger, over the top of the plot while one is on it: its time in
 * the viewer's zone, open, high, low, close, the change from the bar before, and its volume.
 * It floats, so showing it never moves the page; the region stays so keyboard steps are heard.
 */
function Readout({ bars, hovered, interval, precision, unit, quoteSymbol, spoken }: Readonly<{
  bars: readonly Bar[]; hovered: Signal<number | null>; interval: CandleInterval; precision: number; unit: string; quoteSymbol: string;
  /** Read out each change, while the keyboard steps through the bars. */
  spoken: boolean;
}>) {
  const at = useSignal(hovered);
  const index = at === null ? -1 : bars.findIndex((bar) => bar.timestamp === at);
  const bar = bars[index];
  const dateTime = useMemo(() => readoutDate(interval), [interval]);
  // The live region stays while the card comes and goes, so a screen reader hears each step.
  return <div className={styles.readoutRegion} aria-live={spoken ? "polite" : "off"}>
    {bar && <p className={styles.readout} data-kline-readout="" data-no-trades={bar.volume === 0 || undefined}>
      <span className={styles.readoutLine}>
        <span className={styles.readoutTime}>
          <time dateTime={new Date(bar.timestamp).toISOString()}>{dateTime.format(bar.timestamp)}</time>
          {bar.volume === 0 && <span className={styles.readoutTag}>No trades</span>}
        </span>
        <span className={styles.readoutVolume}><abbr title="Volume">Vol</abbr> {volumeText(bar.volume)} {quoteSymbol}</span>
      </span>
      <ReadoutPrices bar={bar} previous={bars[index - 1]?.close ?? bar.open} precision={precision} />
      <span className="sr-only"> Prices in {unit}.</span>
    </p>}
  </div>;
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

/** The axis fold: 0.0₄812 for 0.0000812. */
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

/** Floats over the newest corner once the viewer has scrolled back; one press returns to the newest bar. */
function LatestButton({ away, onLatest }: Readonly<{ away: Signal<number | null>; onLatest: () => void }>) {
  const axis = useSignal(away);
  if (axis === null) return null;
  return <div className={styles.latest} {...dyn({ insetInlineEnd: axis + 8 })}>
    <Button variant="ink" size="sm" onClick={onLatest} aria-label="Back to the newest bar">Latest <NextIcon /></Button>
  </div>;
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

/** Volume bars under the price, in the candle colours, faded; the readout carries their value, so the pane has no legend. */
function volumeCreate(colors: Palette): IndicatorCreate {
  return { name: "VOL", id: "VOL", paneId: VOLUME_PANE, calcParams: [], precision: 2, createTooltipDataSource: () => ({ name: "", calcParamsText: "", features: [], legends: [] }), styles: { bars: [{ upColor: faded(colors.up, .5), downColor: faded(colors.down, .5), noChangeColor: faded(colors.muted, .5) }] } };
}

function themeStyles(colors: Palette): DeepPartial<Styles> {
  const { up, down, ink, muted, hair, card, family } = colors;
  const text = { color: muted, size: 11, family };
  const label = { color: card, family };
  return {
    grid: { horizontal: { color: hair }, vertical: { show: false } },
    candle: {
      type: "candle_solid",
      bar: { upColor: up, downColor: down, noChangeColor: muted, upBorderColor: up, downBorderColor: down, noChangeBorderColor: muted, upWickColor: up, downWickColor: down, noChangeWickColor: muted },
      priceMark: { high: { color: muted, textFamily: family }, low: { color: muted, textFamily: family }, last: { upColor: up, downColor: down, noChangeColor: muted, text: label } },
      // The readout over the plot carries the bar's time, prices and volume.
      tooltip: { showRule: "none" },
    },
    indicator: { bars: [{ upColor: up, downColor: down, noChangeColor: muted }], tooltip: { showRule: "none" } },
    xAxis: { axisLine: { color: hair }, tickLine: { color: hair }, tickText: text },
    yAxis: { axisLine: { color: hair }, tickLine: { color: hair }, tickText: text },
    separator: { color: hair },
    crosshair: { horizontal: { line: { color: muted }, text: { ...label, backgroundColor: ink, borderColor: ink } }, vertical: { line: { color: muted }, text: { ...label, backgroundColor: ink, borderColor: ink } } },
    // The graduation chip's text, on the axis colour.
    overlay: { text: { color: card, family } },
  };
}
