import { MarketCoinChart } from "./MarketCoinChart";
import { TradeCoinChart } from "./TradeCoinChart";
import { useId, useMemo, type ReactNode } from "react";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import { BlastMenu, BlastMenuTrigger, BlastMenuCheckboxItem, BlastMenuCheckboxItemIndicator, BlastMenuRadioGroup, BlastMenuRadioItem, BlastMenuRadioItemIndicator } from "#web/components/blast-ui/BlastMenu.tsx";
import menuStyles from "../WorkspaceShortcuts.module.css";
import { Button, DisclosureButton } from "#web/components/blast-ui/Button.tsx";
import styles from "./CoinPanel.module.css";
import visualStyles from "./CoinChartVisual.module.css";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import type { SocialPriceHistory } from "@blast/core/web/contracts/prices.ts";
import type { CoinHistory } from "./coin-reads";
import { NativeCoinChart, ChartVisual } from "./NativeCoinChart";
import {
  priceStepFor,
  PRICE_MAX_POINTS,
  PRICE_WINDOWS,
  PRICE_WINDOW_MS,
  PRICE_WINDOW_LABELS,
  PRICE_TIERS,
  priceTierFor,
} from "@blast/core/web/contracts/prices.ts";
import { CANDLE_INTERVALS } from "@blast/core/modules/launchpad-contract/venue-history.ts";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { ChartState } from "./ChartState";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { CoinDetails } from "./CoinDetails";
import { readablePrice, readableUsd } from "#web/lib/market-format.ts";
import { ChartTrades } from "./ChartTrades";
import type { ChartActivityRead } from "./chart-trades-context";
import type { HomeDiscussionPage } from "@blast/core/web/contracts/home.ts";
import type { CoinRecord } from "./coin-reads";

const EMPTY_HISTORY_POINTS: SocialPriceHistory["points"] = [];

export function CoinChart({
  history,
  pending,
  failed = false,
  unavailable = false,
  chart,
  onChart,
  retry,
  activity,
  coin,
  loadPosts,
  postMarketId,
}: Readonly<{
  history: CoinHistory | null;
  pending: boolean;
  failed?: boolean;
  unavailable?: boolean;
  chart: PanelSetup["coin"]["chart"];
  onChart: (chart: PanelSetup["coin"]["chart"]) => void;
  retry?: () => void;
  activity: ChartActivityRead;
  coin: CoinRecord | null;
  loadPosts?: (signal: AbortSignal) => Promise<HomeDiscussionPage | null>;
  postMarketId?: string | null;
}>) {
  return (
    <ChartTrades
      activity={activity}
      coin={coin}
      loadPosts={loadPosts}
      postMarketId={postMarketId}
    >
      <div className={visualStyles.chart} data-chart-frame="">
        {pending ? (
          <ChartState state="loading" />
        ) : failed ? (
          <ChartState state="error" retry={retry} />
        ) : !history ? (
          <ChartState state={coin && !unavailable ? "no-history" : "unavailable"} />
        ) : (
          <ResolvedCoinHistory
            history={history}
            chart={chart}
            onChart={onChart}
            retry={retry}
          />
        )}
      </div>
    </ChartTrades>
  );
}

function ResolvedCoinHistory({
  history,
  chart,
  onChart,
  retry,
}: Pick<
  Parameters<typeof CoinChart>[0],
  "history" | "chart" | "onChart" | "retry"
>) {
  if (history && "kind" in history)
    return history.kind === "trades" ? <TradeCoinChart history={history} chart={chart} retry={retry} /> : history.kind === "market" ? (
      <MarketCoinChart history={history} chart={chart} />
    ) : (
      <NativeCoinChart history={history} chart={chart} onChart={onChart} />
    );
  return (
    <SocialCoinHistory
      history={history}
      chart={chart}
      onChart={onChart}
      retry={retry}
    />
  );
}

function priceControls(
  chart: PanelSetup["coin"]["chart"],
  history?: CoinHistory | null,
) {
  const saved: Extract<PanelSetup["coin"]["chart"], { renderer: "recharts" }> =
    chart.renderer === "recharts"
      ? chart
      : {
          renderer: "recharts" as const,
          window: "24h" as const,
          viewport: null,
        };
  const presentation = {
    ...(saved.style ? { style: saved.style } : {}),
    ...(saved.volume !== undefined ? { volume: saved.volume } : {}),
  };
  const { window, interval } = saved;
  const native = history && "kind" in history;
  const span =
    window !== "launch"
      ? PRICE_WINDOW_MS[window]
      : history && !native
        ? (history.points.at(-1)?.[0] ??
            history.quote?.points.at(-1)?.[0] ??
            history.from_ms) - history.from_ms
        : 0;
  const minimum = PRICE_TIERS.indexOf(priceTierFor(span));
  const intervals: readonly string[] = native
    ? CANDLE_INTERVALS
    : PRICE_TIERS.slice(minimum);
  const automaticInterval =
    history && "kind" in history && (history.kind === "market" || history.kind === "trades")
      ? history.page.interval
      : native
        ? "1m"
        : priceTierFor(span);
  const selectedInterval =
    interval && intervals.includes(interval) ? interval : "auto";
  return {
    saved,
    presentation,
    window,
    interval,
    native,
    intervals,
    automaticInterval,
    selectedInterval,
  };
}

/** Only supported price windows, with the active period visibly selected. */
export function CoinPriceWindow({
  chart,
  onChart,
  history,
  sinceLaunch = true,
}: Readonly<{
  chart: PanelSetup["coin"]["chart"];
  onChart: (chart: PanelSetup["coin"]["chart"]) => void;
  history?: CoinHistory | null;
  sinceLaunch?: boolean;
}>) {
  const {
    saved,
    presentation,
    window,
    interval,
    native,
    intervals,
    automaticInterval,
    selectedInterval,
  } = priceControls(chart, history);
  const launchLocked = !sinceLaunch && !native;
  const pickWindow = (value: (typeof PRICE_WINDOWS)[number]) =>
    onChart({
      ...presentation,
      renderer: "recharts",
      window: value,
      ...(native && interval ? { interval } : {}),
      viewport: null,
    });
  return (
    <div
      className={visualStyles.controls}
      role="group"
      aria-label="Price window"
    >
      <div
        className={visualStyles.ranges}
        role="group"
        aria-label="Chart range"
      >
        {PRICE_WINDOWS.map((value) => (
          <Button
            key={value}
            variant="segment"
            size="xs"
            aria-pressed={window === value}
            disabled={value === "launch" && launchLocked}
            title={
              value === "launch" && launchLocked
                ? "A launch record is needed for all history"
                : undefined
            }
            onClick={() => pickWindow(value)}
          >
            {PRICE_WINDOW_LABELS[value]}
          </Button>
        ))}
      </div>
      <span className={visualStyles.rangeMenu}>
        <BlastMenu
          anchored
          label="Chart range"
          className={menuStyles.menu}
          placement={() => ({ side: "bottom", align: "start", sideOffset: 6, avoid: "flip", originX: "0%" })}
          trigger={
            <BlastMenuTrigger
              render={
                <DisclosureButton variant="secondary" size="sm" aria-label={`Chart range: ${PRICE_WINDOW_LABELS[window]}`}>
                  {PRICE_WINDOW_LABELS[window]}
                </DisclosureButton>
              }
            />
          }
        >
          <BlastMenuRadioGroup value={window} onValueChange={(value) => pickWindow(value as (typeof PRICE_WINDOWS)[number])}>
            {PRICE_WINDOWS.map((value) => (
              <BlastMenuRadioItem key={value} className={menuStyles.menuItem} closeOnClick value={value} disabled={value === "launch" && launchLocked}>
                {value === "launch" && launchLocked ? `${PRICE_WINDOW_LABELS[value]} · needs a launch record` : PRICE_WINDOW_LABELS[value]}
                <BlastMenuRadioItemIndicator className={visualStyles.intervalCheck}>✓</BlastMenuRadioItemIndicator>
              </BlastMenuRadioItem>
            ))}
          </BlastMenuRadioGroup>
        </BlastMenu>
      </span>
      <BlastMenu
        anchored
        label="Chart interval"
        className={menuStyles.menu}
        placement={() => ({
          side: "bottom",
          align: "end",
          sideOffset: 6,
          avoid: "flip",
          originX: "100%",
        })}
        trigger={
          <BlastMenuTrigger
            render={
              <DisclosureButton
                variant="secondary"
                size="sm"
                aria-label={`Chart interval: ${selectedInterval === "auto" ? `Auto (${automaticInterval})` : selectedInterval}`}
              >
                {selectedInterval === "auto"
                  ? automaticInterval
                  : selectedInterval}
              </DisclosureButton>
            }
          />
        }
      >
        <BlastMenuRadioGroup
          value={selectedInterval}
          onValueChange={(value) =>
            onChart({
              ...presentation,
              renderer: "recharts",
              window,
              ...(value !== "auto"
                ? { interval: value as typeof interval }
                : {}),
              viewport: null,
            })
          }
        >
          {["auto", ...intervals].map((value) => (
            <BlastMenuRadioItem
              className={menuStyles.menuItem}
              closeOnClick
              key={value}
              value={value}
            >
              {value === "auto" ? `Auto (${automaticInterval})` : value}
              <BlastMenuRadioItemIndicator className={visualStyles.intervalCheck}>
                ✓
              </BlastMenuRadioItemIndicator>
            </BlastMenuRadioItem>
          ))}
        </BlastMenuRadioGroup>
      </BlastMenu>
      <span className={visualStyles.chartOptionsInline}>
      <div
        className={visualStyles.chartTypes}
        role="group"
        aria-label="Chart style"
      >
        <Button
          variant="segment"
          size="xs"
          aria-pressed={saved.style !== "candles" || !native}
          onClick={() => onChart({ ...saved, style: "line" })}
          title="Line chart"
        >
          Line
        </Button>
        {native ? (
          <Button
            variant="segment"
            size="xs"
            aria-pressed={saved.style === "candles"}
            title="Candlestick chart"
            onClick={() => onChart({ ...saved, style: "candles" })}
          >
            Candles
          </Button>
        ) : (
          <UnavailableControl variant="segment" size="xs" reason="Candles need recorded swaps for this market.">Candles</UnavailableControl>
        )}
      </div>
      {native ? (
        <Button
          variant="secondary"
          size="sm"
          aria-pressed={saved.volume !== false}
          title="Toggle traded volume"
          onClick={() => onChart({ ...saved, volume: saved.volume === false })}
        >
          Volume
        </Button>
      ) : (
        <UnavailableControl variant="secondary" size="sm" reason="Volume needs recorded swaps for this market.">Volume</UnavailableControl>
      )}
      </span>
      <ChartOptionsMenu
        native={!!native}
        candles={saved.style === "candles" && !!native}
        volume={saved.volume !== false}
        onStyle={(style) => onChart({ ...saved, style })}
        onVolume={(volume) => onChart({ ...saved, volume })}
      />
    </div>
  );
}

/**
 * The narrow chart card's one "Chart" menu (Blast mode audit 11, 2026-10-28): the style and
 * Volume move here when the card is too narrow for them inline, so the toolbar keeps one row
 * without scrolling. A market without recorded swaps lists Candles and Volume disabled with why.
 */
function ChartOptionsMenu({ native, candles, volume, onStyle, onVolume }: Readonly<{
  native: boolean;
  candles: boolean;
  volume: boolean;
  onStyle: (style: "line" | "candles") => void;
  onVolume: (volume: boolean) => void;
}>) {
  const style = candles ? "Candles" : "Line";
  return (
    <span className={visualStyles.chartOptionsMenu}>
      <BlastMenu
        anchored
        label="Chart options"
        className={menuStyles.menu}
        placement={() => ({ side: "bottom", align: "end", sideOffset: 6, avoid: "flip", originX: "100%" })}
        trigger={<BlastMenuTrigger render={<DisclosureButton variant="secondary" size="sm" aria-label={`Chart options: ${style}${native ? `, volume ${volume ? "on" : "off"}` : ""}`}>{style}</DisclosureButton>} />}
      >
        <BlastMenuRadioGroup value={candles ? "candles" : "line"} onValueChange={(value) => onStyle(value as "line" | "candles")}>
          <BlastMenuRadioItem className={menuStyles.menuItem} closeOnClick value="line">
            Line
            <BlastMenuRadioItemIndicator className={visualStyles.intervalCheck}>✓</BlastMenuRadioItemIndicator>
          </BlastMenuRadioItem>
          <BlastMenuRadioItem className={menuStyles.menuItem} closeOnClick value="candles" disabled={!native}>
            {native ? "Candles" : "Candles · needs recorded swaps"}
            <BlastMenuRadioItemIndicator className={visualStyles.intervalCheck}>✓</BlastMenuRadioItemIndicator>
          </BlastMenuRadioItem>
        </BlastMenuRadioGroup>
        <BlastMenuCheckboxItem className={menuStyles.menuItem} checked={native && volume} disabled={!native} onCheckedChange={onVolume}>
          {native ? "Volume" : "Volume · needs recorded swaps"}
          <BlastMenuCheckboxItemIndicator className={visualStyles.intervalCheck}>✓</BlastMenuCheckboxItemIndicator>
        </BlastMenuCheckboxItem>
      </BlastMenu>
    </span>
  );
}

/**
 * A chart control this market cannot offer yet (audit 14). It stays in place, quiet and focusable;
 * pressing it (tap, click or Enter) explains why instead of toggling, and its reason is its
 * description for assistive technology as well as its hover title.
 */
function UnavailableControl({ variant, size, reason, children }: Readonly<{ variant: "segment" | "secondary"; size: "xs" | "sm"; reason: string; children: ReactNode }>) {
  const id = useId();
  return <Popover.Root>
    <Popover.Trigger render={<Button variant={variant} size={size} data-unavailable="" aria-describedby={id} title={reason} className={visualStyles.unavailable}>{children}</Button>} />
    <span className="sr-only" id={id}>{reason}</span>
    <PopoverSurface
      positioner={{ sideOffset: 6, collisionPadding: 12, className: visualStyles.whyLayer }}
      popup={{ className: visualStyles.why }}
    >{reason}</PopoverSurface>
  </Popover.Root>;
}

function SocialCoinHistory({
  history,
  chart,
  onChart,
  retry,
}: Readonly<{
  history: SocialPriceHistory | null;
  chart: PanelSetup["coin"]["chart"];
  onChart: (chart: PanelSetup["coin"]["chart"]) => void;
  retry?: () => void;
}>) {
  const social = history;
  const quote = social?.price_usd == null ? social?.quote : undefined;
  const points = quote?.points ?? social?.points ?? EMPTY_HISTORY_POINTS;

  const viewport = chart.renderer === "recharts" ? chart.viewport : null;
  const plotted = useMemo(
    () =>
      viewport
        ? points.filter(
            ([at]) => at >= viewport.from_ms && at <= viewport.to_ms,
          )
        : points,
    [points, viewport],
  );
  const window = chart.renderer === "recharts" ? chart.window : "24h";
  return (
    <>
      <ObservedHistoryPlot
        key={`${history?.coin_type}:${JSON.stringify(chart)}`}
        history={history}
        points={points}
        plotted={plotted}
        units={quote?.symbol ?? "USD"}
        range={window === "launch" ? undefined : PRICE_WINDOW_LABELS[window]}
        retry={retry}
        onAll={
          window !== "launch" && history?.presale_id
            ? () =>
                onChart({
                  renderer: "recharts",
                  window: "launch",
                  viewport: null,
                })
            : undefined
        }
      />
      <CoinDetails kind="chart" label="Chart details">
        <p>{plotted.length} recorded observations</p>
        <ObservedPrice history={history} />

        {points.length >= 2 && (
          <Button
            variant="ghost"
            size="sm"
            type="button"
            className={styles.pill}
            onClick={() =>
              onChart({
                ...(chart.renderer === "recharts" ? chart : {}),
                renderer: "recharts",
                window,
                viewport: viewport
                  ? null
                  : {
                      from_ms: points[Math.floor((points.length - 1) / 2)]![0],
                      to_ms: points.at(-1)![0],
                    },
              })
            }
          >
            {viewport ? "Show the whole range" : "Zoom to the latest half"}
          </Button>
        )}
      </CoinDetails>
    </>
  );
}

function ObservedPrice({
  history,
}: Readonly<{ history: SocialPriceHistory | null }>) {
  const hidden = useShellPrefs().amountsHidden;
  const quote = history?.price_usd == null ? history?.quote : undefined;
  const price = quote?.price ?? history?.price_usd;
  return (
    <>
      {" "}
      <p>
        {/* One price format with the header (audit F39): dollars read as $0.9998, a coin quote names its coin once. */}
        Last price{" "}
        <strong>
          {hidden ? (
            "••••"
          ) : price == null ? (
            "Unavailable"
          ) : (
            <InspectValue
              value={`${price} ${quote?.symbol ?? "USD"}`}
              label="observed price"
            >
              {quote ? `${readablePrice(price)} ${quote.symbol}` : readableUsd(price)}
            </InspectValue>
          )}
        </strong>
      </p>
    </>
  );
}

function ObservedHistoryPlot({
  history,
  points,
  plotted,
  units,
  onAll,
  retry,
  range,
}: Readonly<{
  history: SocialPriceHistory | null;
  points: SocialPriceHistory["points"];
  plotted: SocialPriceHistory["points"];
  units: string;
  /** The chosen range in words, for "Not enough price history for 24H"; none for All. */
  range?: string;
  retry?: () => void;
  onAll?: () => void;
}>) {
  const observations = useMemo(
    () =>
      plotted.map(([at, value]) => ({
        at,
        value,
        source: "indexed",
      })),
    [plotted],
  );
  return plotted.length >= 2 ? (
    <ChartVisual
      observations={observations}
      intervalMs={
        history
          ? priceStepFor(
              (points.at(-1)?.[0] ?? history.from_ms) - history.from_ms,
              history.tier,
              PRICE_MAX_POINTS,
            )
          : 300_000
      }
      units={units}
      label="Observed pool price history"
    />
  ) : (
    <ChartState
      state={
        plotted.length === 1 ? "sparse" : "empty"
      }
      onAll={onAll}
      range={range}
      retry={retry}
    />
  );
}
