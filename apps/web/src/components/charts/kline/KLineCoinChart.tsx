"use client";

import { dispose, init, type Chart, type DeepPartial, type KLineData, type Period, type Styles } from "klinecharts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CandleInterval } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { Checkbox, Switch } from "#web/components/blast-ui/Checkbox.tsx";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import type { DrawnSeries } from "#web/components/launchpad/chart/chart-geometry.ts";
import { saveChartPreference, useChartPreference } from "#web/components/launchpad/chart/chart-preferences.ts";
import { WALLET_LABELS } from "#web/components/launchpad/activity/wallet-labels.ts";
import { shiftDecimal } from "#web/components/launchpad/coin/coin-format.ts";
import { useMobileChartLayout } from "../use-mobile-chart-layout.ts";
import { poolPrices } from "../candle-data.ts";
import type { CandleTrade } from "../candle-trade.ts";
import type { WalletChartTrade } from "../wallet-markers.ts";
import {
  barChanges, CHART_SETTINGS_KEY, foldTrade, klineBars, MAIN_INDICATORS, PANE_INDICATORS, pricePrecision, readChartSettings, toggleIndicator,
  type Bar, type ChartSettings, type IndicatorName,
} from "./kline-model.ts";
import styles from "./KLineCoinChart.module.css";

const PERIODS: Readonly<Record<CandleInterval, Period>> = {
  "1s": { type: "second", span: 1 }, "1m": { type: "minute", span: 1 }, "5m": { type: "minute", span: 5 }, "15m": { type: "minute", span: 15 },
  "1h": { type: "hour", span: 1 }, "4h": { type: "hour", span: 4 }, "1d": { type: "day", span: 1 }, "1w": { type: "week", span: 1 },
};

const DRAWINGS = [["segment", "Trend line"], ["rayLine", "Ray"], ["horizontalStraightLine", "Horizontal line"], ["priceLine", "Price line"], ["fibonacciLine", "Fibonacci"]] as const;
const INDICATOR_NAMES: Readonly<Record<IndicatorName, string>> = { MA: "Moving average", EMA: "Exponential MA", BOLL: "Bollinger bands", VOL: "Volume", MACD: "MACD", RSI: "RSI" };
const MAX_WALLET_TAGS = 60;
const DRAWING_GROUP = "drawings";
const WALLET_GROUP = "wallet-tags";

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
  walletTrades?: readonly WalletChartTrade[];
}>;

/** The coin page's chart (KLineCharts): candles or line, indicators, drawings and wallet tags, live to the last trade. */
export default function KLineCoinChart({ sources, interval, memeDecimals, quoteDecimals, quoteUsd, latestAvailable, label, style, trade, walletTrades }: KLineCoinChartProps) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<Chart | null>(null);
  const shown = useRef<readonly Bar[]>([]);
  const push = useRef<((bar: KLineData) => void) | null>(null);
  const [settings, setSettings] = useState(loadSettings);
  const mobile = useMobileChartLayout();
  const walletPreference = useChartPreference("wallet-tags");
  const [walletChoice, setWalletChoice] = useState<boolean>();
  const showWalletTags = walletChoice ?? walletPreference !== "hidden";
  const bars = useLiveBars(sources, interval, memeDecimals, quoteDecimals, quoteUsd, trade);
  const precision = pricePrecision(bars);

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    const created = init(element, { timezone: "UTC", decimalFold: { threshold: 4 }, styles: themeStyles(element) });
    if (!created) return;
    chart.current = created;
    created.setDataLoader({
      getBars: ({ callback }) => callback([...shown.current], false),
      subscribeBar: ({ callback }) => { push.current = callback; },
      unsubscribeBar: () => { push.current = null; },
    });
    const retheme = () => created.setStyles(themeStyles(element));
    const scheme = matchMedia("(prefers-color-scheme: dark)");
    scheme.addEventListener("change", retheme);
    const themeObserver = new MutationObserver(retheme);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    const resize = new ResizeObserver(() => created.resize());
    resize.observe(element);
    return () => {
      scheme.removeEventListener("change", retheme);
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
  }, [settings.indicators]);

  useEffect(() => {
    const current = chart.current;
    if (!current) return;
    current.removeOverlay({ groupId: WALLET_GROUP });
    if (!showWalletTags || !walletTrades?.length) return;
    for (const tag of walletTags(walletTrades, bars))
      current.createOverlay({ name: "simpleAnnotation", groupId: WALLET_GROUP, lock: true, points: [{ timestamp: tag.timestamp, value: tag.value }], extendData: tag.text });
  }, [showWalletTags, walletTrades, bars]);

  const update = (next: ChartSettings) => {
    setSettings(next);
    try { localStorage.setItem(CHART_SETTINGS_KEY, JSON.stringify(next)); } catch { /* private mode keeps it for this visit */ }
  };

  return (
    <div className={styles.chart} data-kline-chart="">
      <div className={styles.toolbar} role="group" aria-label="Chart tools">
        <IndicatorMenu settings={settings} onToggle={(name) => update(toggleIndicator(settings, name))} />
        {!mobile && <DrawMenu onDraw={(name) => chart.current?.createOverlay({ name, groupId: DRAWING_GROUP })} onClear={() => chart.current?.removeOverlay({ groupId: DRAWING_GROUP })} />}
        {walletTrades && <label className={styles.walletToggle}>
          Wallet tags
          <Switch checked={showWalletTags} onCheckedChange={(visible) => { setWalletChoice(visible); saveChartPreference("wallet-tags", visible ? "shown" : "hidden"); }} />
        </label>}
      </div>
      <div ref={host} className={styles.plot} role="img" aria-label={label} data-kline-plot="" />
    </div>
  );
}

function loadSettings(): ChartSettings {
  try { return readChartSettings(localStorage.getItem(CHART_SETTINGS_KEY)); } catch { return readChartSettings(null); }
}

/** History bars plus the newest trade the history has not seen yet, folded into its open bar. */
function useLiveBars(sources: readonly DrawnSeries[], interval: CandleInterval, memeDecimals: number | null, quoteDecimals: number | null, quoteUsd: string | null, trade?: CandleTrade | null) {
  const history = useMemo(() => klineBars(sources, memeDecimals, quoteDecimals, quoteUsd), [sources, memeDecimals, quoteDecimals, quoteUsd]);
  return useMemo(() => {
    if (!trade?.trade.price || memeDecimals === null) return history;
    const pool = sources.find(({ page }) => page.poolKey === trade.poolKey);
    if (!pool || (pool.observedAt != null && trade.trade.timestampMs <= pool.observedAt)) return history;
    const shownPrice = Number(poolPrices(memeDecimals, quoteDecimals, quoteUsd).price(trade.trade.price));
    const quotePrice = Number(poolPrices(memeDecimals, quoteDecimals).price(trade.trade.price));
    const volume = Number(shiftDecimal(trade.trade.memeAmount.toString(), -memeDecimals)) * quotePrice;
    const open = foldTrade(history, interval, trade.trade.timestampMs, shownPrice, volume);
    if (!open) return history;
    return history.at(-1)?.timestamp === open.timestamp ? [...history.slice(0, -1), open] : [...history, open];
  }, [history, interval, memeDecimals, quoteDecimals, quoteUsd, sources, trade]);
}

/** One tag per labelled trade, newest first up to a cap, on its bar's close. */
function walletTags(trades: readonly WalletChartTrade[], bars: readonly Bar[]) {
  const closes = new Map(bars.map((bar) => [bar.timestamp, bar.close]));
  const first = bars[0]?.timestamp ?? Infinity;
  return [...trades].sort((a, b) => b.timestampMs - a.timestampMs).slice(0, MAX_WALLET_TAGS).flatMap((trade) => {
    const bucket = bars.findLast((bar) => bar.timestamp <= trade.timestampMs)?.timestamp;
    if (bucket === undefined || trade.timestampMs < first) return [];
    const name = trade.labels.map((key) => WALLET_LABELS[key].name).join(" · ");
    return [{ timestamp: bucket, value: closes.get(bucket)!, text: `${name} ${trade.side === "buy" ? "bought" : "sold"}` }];
  });
}

/** The page's tokens resolved to colours the canvas can use. */
function themeStyles(element: HTMLElement): DeepPartial<Styles> {
  const probe = document.createElement("span");
  element.append(probe);
  const resolve = (token: string) => {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  };
  const [up, down, ink, muted, hair, card] = ["--coin-chart-up", "--coin-chart-down", "--ink", "--muted", "--hair", "--card"].map(resolve) as [string, string, string, string, string, string];
  probe.remove();
  const text = { color: muted, size: 11 };
  return {
    grid: { horizontal: { color: hair }, vertical: { show: false } },
    candle: {
      bar: { upColor: up, downColor: down, noChangeColor: muted, upBorderColor: up, downBorderColor: down, noChangeBorderColor: muted, upWickColor: up, downWickColor: down, noChangeWickColor: muted },
      area: { lineColor: ink, backgroundColor: [{ offset: 0, color: "rgba(0,0,0,0)" }, { offset: 1, color: "rgba(0,0,0,0)" }] },
      priceMark: { high: { color: muted }, low: { color: muted }, last: { upColor: up, downColor: down, noChangeColor: muted, text: { color: card } } },
      tooltip: { title: { show: false }, legend: { color: muted } },
    },
    indicator: { tooltip: { title: { color: muted }, legend: { color: muted } } },
    xAxis: { axisLine: { color: hair }, tickLine: { color: hair }, tickText: text },
    yAxis: { axisLine: { color: hair }, tickLine: { color: hair }, tickText: text },
    separator: { color: hair },
    crosshair: { horizontal: { line: { color: muted }, text: { backgroundColor: ink, color: card, borderColor: ink } }, vertical: { line: { color: muted }, text: { backgroundColor: ink, color: card, borderColor: ink } } },
  };
}

function IndicatorMenu({ settings, onToggle }: Readonly<{ settings: ChartSettings; onToggle: (name: IndicatorName) => void }>) {
  return <Popover.Root>
    <Popover.Trigger render={<Button variant="ghost" size="sm" />}>Indicators</Popover.Trigger>
    <PopoverSurface positioner={{ side: "bottom", align: "start", sideOffset: 4, className: styles.layer }} popup={{ className: styles.menu, "aria-label": "Indicators" }}>
      {[...MAIN_INDICATORS, ...PANE_INDICATORS].map((name) => <label key={name} className={styles.menuItem}>
        <Checkbox checked={settings.indicators.includes(name)} onChange={() => onToggle(name)} />
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
