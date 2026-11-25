"use client";

import { dispose, init, type Chart, type DeepPartial, type KLineData, type Period, type Styles } from "klinecharts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CandleInterval } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { Checkbox, Switch } from "#web/components/blast-ui/Checkbox.tsx";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import type { DrawnSeries } from "#web/components/launchpad/chart/chart-geometry.ts";
import { saveChartPreference, useChartPreference } from "#web/components/launchpad/chart/chart-preferences.ts";
import { shiftDecimal } from "#web/components/launchpad/coin/coin-format.ts";
import { useMobileChartLayout } from "../use-mobile-chart-layout.ts";
import { poolPrices } from "../candle-data.ts";
import type { CandleTrade } from "../candle-trade.ts";
import {
  barChanges, foldTrades, klineBars, MAIN_INDICATORS, PANE_INDICATORS, pricePrecision, readChartSettings, toggleIndicator,
  type Bar, type ChartSettings, type IndicatorName,
} from "./kline-model.ts";
import { subscriptZeros } from "#web/lib/market-format.ts";
import { BubbleStage, PeopleBubbles } from "./PeopleBubbles.tsx";
import styles from "./KLineCoinChart.module.css";

const PERIODS: Readonly<Record<CandleInterval, Period>> = {
  "1s": { type: "second", span: 1 }, "1m": { type: "minute", span: 1 }, "5m": { type: "minute", span: 5 }, "15m": { type: "minute", span: 15 },
  "1h": { type: "hour", span: 1 }, "4h": { type: "hour", span: 4 }, "1d": { type: "day", span: 1 }, "1w": { type: "week", span: 1 },
};

const DRAWINGS = [["segment", "Trend line"], ["rayLine", "Ray"], ["horizontalStraightLine", "Horizontal line"], ["priceLine", "Price line"], ["fibonacciLine", "Fibonacci"]] as const;
const INDICATOR_NAMES: Readonly<Record<IndicatorName, string>> = { MA: "Moving average", EMA: "Exponential MA", BOLL: "Bollinger bands", VOL: "Volume", MACD: "MACD", RSI: "RSI" };
const DRAWING_GROUP = "drawings";
const GRADUATION_GROUP = "graduation";
/** Trades the history has not caught up with yet; older ones are dropped. */
const MAX_PENDING_TRADES = 500;

export type KLineCoinChartProps = Readonly<{
  sources: readonly DrawnSeries[];
  interval: CandleInterval;
  memeDecimals: number | null;
  quoteDecimals: number | null;
  /** USD per quote coin; with it the chart is in USD. */
  quoteUsd: string | null;
  latestAvailable: boolean;
  label: string;
  /** Candles or a line; the page owns the picker (line on phones and in Live). */
  style: "candles" | "line";
  trade?: CandleTrade | null;
  /** When the coin left its curve for a pool, marked with a line. */
  migrationAt?: number;
}>;

/** The coin page's chart (KLineCharts): candles or line, indicators, drawings and trader bubbles, live to the last trade. */
export default function KLineCoinChart({ sources, interval, memeDecimals, quoteDecimals, quoteUsd, latestAvailable, label, style, trade, migrationAt }: KLineCoinChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<Chart | null>(null);
  const shown = useRef<readonly Bar[]>([]);
  const push = useRef<((bar: KLineData) => void) | null>(null);
  const savedIndicators = useChartPreference("indicators");
  const [chosen, setChosen] = useState<ChartSettings>();
  const settings = chosen ?? readChartSettings(savedIndicators || null);
  const mobile = useMobileChartLayout();
  const walletPreference = useChartPreference("wallet-tags");
  const [walletChoice, setWalletChoice] = useState<boolean>();
  const showWalletTags = walletChoice ?? walletPreference !== "hidden";
  const bars = useLiveBars(sources, interval, memeDecimals, quoteDecimals, quoteUsd, trade);
  const precision = pricePrecision(bars);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const created = init(element, { timezone: "UTC", decimalFold: { threshold: 4, format: (value) => subscriptZeros(String(value)) }, styles: themeStyles(element) });
    if (!created) return;
    chart.current = created;
    created.setDataLoader({
      getBars: ({ callback }) => callback([...shown.current], false),
      subscribeBar: ({ callback }) => { push.current = callback; },
      unsubscribeBar: () => { push.current = null; },
    });
    const retheme = () => created.setStyles(themeStyles(element));
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    const phone = matchMedia("(max-width: 760px)");
    scheme.addEventListener("change", retheme);
    phone.addEventListener("change", retheme);
    const themeObserver = new MutationObserver(retheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    const resize = new ResizeObserver(() => created.resize());
    resize.observe(element);
    return () => {
      scheme.removeEventListener("change", retheme);
      phone.removeEventListener("change", retheme);
      themeObserver.disconnect();
      resize.disconnect();
      chart.current = null;
      push.current = null;
      dispose(element);
    };
  }, []);

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
    if (periodChanged) current.setPeriod(period);
    if (!symbolChanged && !periodChanged) current.resetData();
    fitBars(current, host.current, bars.length);
  }, [bars, precision, interval]);

  useEffect(() => {
    chart.current?.setStyles({ candle: { type: style === "line" ? "area" : "candle_solid", priceMark: { last: { show: latestAvailable } } } });
  }, [style, latestAvailable]);

  useEffect(() => {
    const current = chart.current;
    if (!current) return;
    for (const name of [...MAIN_INDICATORS, ...PANE_INDICATORS]) current.removeIndicator({ id: name });
    for (const name of settings.indicators)
      current.createIndicator((MAIN_INDICATORS as readonly string[]).includes(name) ? { name, id: name, paneId: "candle_pane" } : { name, id: name, paneId: `pane_${name}` }, true);
    // Headroom above the highest value keeps the readouts off the bars.
    current.overrideYAxis({ paneId: "candle_pane", gap: { top: 0.3 } });
    for (const name of settings.indicators) if ((PANE_INDICATORS as readonly string[]).includes(name)) current.overrideYAxis({ paneId: `pane_${name}`, gap: { top: 0.4 } });
  }, [settings.indicators]);

  const graduationAt = migrationAt === undefined ? undefined : bars.findLast((bar) => bar.timestamp <= migrationAt)?.timestamp;
  useEffect(() => {
    const current = chart.current;
    if (!current) return;
    current.removeOverlay({ groupId: GRADUATION_GROUP });
    if (graduationAt !== undefined) current.createOverlay({ name: "verticalStraightLine", groupId: GRADUATION_GROUP, lock: true, points: [{ timestamp: graduationAt }] });
  }, [graduationAt]);

  const update = (next: ChartSettings) => {
    setChosen(next);
    saveChartPreference("indicators", JSON.stringify(next));
  };

  return (
    <div className={styles.chart} data-kline-chart="">
      <div className={styles.toolbar} role="group" aria-label="Chart tools">
        <IndicatorMenu settings={settings} onToggle={(name) => update(toggleIndicator(settings, name))} />
        {!mobile && <DrawMenu onDraw={(name) => chart.current?.createOverlay({ name, groupId: DRAWING_GROUP })} onClear={() => chart.current?.removeOverlay({ groupId: DRAWING_GROUP })} />}
        <label className={styles.walletToggle}>
          Traders
          <Switch checked={showWalletTags} onCheckedChange={(visible) => { setWalletChoice(visible); saveChartPreference("wallet-tags", visible ? "shown" : "hidden"); }} />
        </label>
      </div>
      <BubbleStage>
        <div ref={host} className={styles.plot} role="img" aria-label={label} data-kline-plot="" />
        {showWalletTags && <PeopleBubbles chart={chart} bars={bars} quoteDecimals={quoteDecimals} quoteUsd={quoteUsd} />}
      </BubbleStage>
    </div>
  );
}

/** History bars with every live trade it has not seen yet folded into the open bars. */
function useLiveBars(sources: readonly DrawnSeries[], interval: CandleInterval, memeDecimals: number | null, quoteDecimals: number | null, quoteUsd: string | null, trade?: CandleTrade | null) {
  const history = useMemo(() => klineBars(sources, memeDecimals, quoteDecimals, quoteUsd), [sources, memeDecimals, quoteDecimals, quoteUsd]);
  const [pending, setPending] = useState<readonly CandleTrade[]>([]);
  const [seen, setSeen] = useState(trade);
  if (trade !== seen) {
    setSeen(trade);
    if (trade?.trade.price) setPending((held) => [...held.filter((item) => item.trade.cursor !== trade.trade.cursor), trade].slice(-MAX_PENDING_TRADES));
  }
  return useMemo(() => {
    if (memeDecimals === null) return history;
    const shown = poolPrices(memeDecimals, quoteDecimals, quoteUsd);
    const quote = poolPrices(memeDecimals, quoteDecimals);
    const unseen = pending.flatMap(({ poolKey, trade: { timestampMs, price, memeAmount } }) => {
      if (!price) return [];
      const pool = sources.find(({ page }) => page.poolKey === poolKey);
      if (!pool || (pool.observedAt != null && timestampMs <= pool.observedAt)) return [];
      const volume = Number(shiftDecimal(memeAmount.toString(), -memeDecimals)) * Number(quote.price(price));
      return [{ timestampMs, price: Number(shown.price(price)), volume }];
    });
    return foldTrades(history, interval, unseen);
  }, [history, interval, memeDecimals, quoteDecimals, quoteUsd, sources, pending]);
}

/** The chosen range fills the plot; a range too long for 3 px a bar scrolls from its newest bar. */
function fitBars(chart: Chart, element: HTMLElement | null, count: number) {
  if (!element || count === 0) return;
  const plot = element.clientWidth - 72;
  chart.setOffsetRightDistance(12);
  chart.setBarSpace(Math.min(12, Math.max(3, (plot - 12) / count)));
}

/** The page's tokens resolved to colours the canvas can use. */
function themeStyles(element: HTMLElement): DeepPartial<Styles> {
  const probe = document.createElement("span");
  element.append(probe);
  const resolve = (token: string) => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  const [up, down, ink, muted, hair, card, ink2, tint1, tint2, tint3] = ["--coin-chart-up", "--coin-chart-down", "--ink", "--muted", "--hair", "--card", "--ink-2", "--ink-tint-1", "--ink-tint-2", "--ink-tint-3"].map(resolve) as [string, string, string, string, string, string, string, string, string, string];
  probe.remove();
  const family = getComputedStyle(element).fontFamily;
  const text = { color: muted, size: 11, family };
  const legend = { color: muted, family };
  const label = { color: card, family };
  // A phone's plot is too short for the readouts: they show while a finger is on the chart.
  const showRule = matchMedia("(max-width: 760px)").matches ? "follow_cross" as const : "always" as const;
  return {
    grid: { horizontal: { color: hair }, vertical: { show: false } },
    candle: {
      bar: { upColor: up, downColor: down, noChangeColor: muted, upBorderColor: up, downBorderColor: down, noChangeBorderColor: muted, upWickColor: up, downWickColor: down, noChangeWickColor: muted },
      area: { lineColor: ink, backgroundColor: [{ offset: 0, color: "rgba(0,0,0,0)" }, { offset: 1, color: "rgba(0,0,0,0)" }] },
      priceMark: { high: { color: muted, textFamily: family }, low: { color: muted, textFamily: family }, last: { upColor: up, downColor: down, noChangeColor: muted, text: label } },
      // Volume has its own pane, so the price readout leaves it out.
      tooltip: { showRule, title: { show: false }, legend: { ...legend, template: ["time", "open", "high", "low", "close"].map((key) => ({ title: key, value: `{${key}}` })) } },
    },
    indicator: { ohlc: { upColor: up, downColor: down, noChangeColor: muted }, bars: [{ upColor: up, downColor: down, noChangeColor: muted }],
      // Indicator lines are greys under the ink price line; the menu names them, so the pane titles stay off.
      lines: [tint1, tint2, tint3, ink2, tint2].map((color) => ({ color, size: 1 })),
      tooltip: { showRule, title: { ...legend, show: false }, legend } },
    xAxis: { axisLine: { color: hair }, tickLine: { color: hair }, tickText: text },
    yAxis: { axisLine: { color: hair }, tickLine: { color: hair }, tickText: text },
    separator: { color: hair },
    crosshair: { horizontal: { line: { color: muted }, text: { ...label, backgroundColor: ink, borderColor: ink } }, vertical: { line: { color: muted }, text: { ...label, backgroundColor: ink, borderColor: ink } } },
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

function DrawMenu({ onDraw, onClear }: Readonly<{ onDraw: (name: (typeof DRAWINGS)[number][0]) => void; onClear: () => void }>) {
  return <Popover.Root>
    <Popover.Trigger render={<Button variant="ghost" size="sm" />}>Draw</Popover.Trigger>
    <PopoverSurface positioner={{ side: "bottom", align: "start", sideOffset: 4, className: styles.layer }} popup={{ className: styles.menu, "aria-label": "Drawing tools" }}>
      {DRAWINGS.map(([name, text]) => <Popover.Close key={name} render={<Button variant="ghost" size="sm" className={styles.menuButton} />} onClick={() => onDraw(name)}>{text}</Popover.Close>)}
      <Popover.Close render={<Button variant="ghost" size="sm" className={styles.menuButton} />} onClick={onClear}>Clear drawings</Popover.Close>
    </PopoverSurface>
  </Popover.Root>;
}
