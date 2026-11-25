"use client";

import { hoverExcerpt } from "#web/lib/hover-text.ts";
import { Button, IconButton } from "#web/components/blast-ui/Button.tsx";
import { NavPending } from "#web/components/blast-ui/NavigationLink.tsx";

import clsx from "clsx";
import Link from "next/link";
import { useId, useMemo, useRef } from "react";
import { usePriceTick } from "./use-price-tick";
import { coinAtPrice, sparkAtPrice } from "./live-market";

import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { CoinVerifiedMark, CloseIcon } from "#web/components/blast-ui/Icons.tsx";
import { usePrice } from "../prices/price-client";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { bxAgo, fillPercent, NO_VALUE, signPct, timeUntil, utc } from "@blast/core/web/format.ts";
import type { HomeCoin, HomeWindow } from "@blast/core/web/contracts/home.ts";
import type { SocialTradeCoin } from "@blast/core/web/contracts/trades.ts";

import { encodeTradeAction } from "../coins/swap-model";
import { useWatchStar } from "../watchlist/Watchlist";
import { Fill } from "../happening/parts";
import { PresaleMark } from "../post/PostMedia";
import { saleLifecycleAt } from "@blast/core/web/contracts/presales.ts";
import styles from "./CoinHome.module.css";
import { HomeSpark } from "./HomeSpark";
import { homeAnalytics } from "./home-analytics";
import { homeCoinHref, homeCoinKey, lifecycleTone, marketFacts, marketVolume, raiseFigures, shareText, type HomeBuyCue } from "./home-model";
import { Unknown } from "./MetricHelp";
import { homeTablePrice } from "#web/lib/market-format.ts";
import type { DisplayPrice } from "@blast/core/modules/launchpad-contract/market-stream.ts";
import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";

export type CoinCardProps = Readonly<{
  coin: HomeCoin;
  /** The row's place in its list (the board's `#` column), counted across pages; omitted where a list has no order. */
  rank?: number;
  marketLoading?: boolean;
  livePrice?: DisplayPrice;
  /** A buy that just landed on this coin. */
  buy?: HomeBuyCue;
  window: HomeWindow;
  nowMs: number;
  /** The trading flag: without it no trade control is drawn. */
  trading: boolean;
  watchlist?: boolean;
}>;

/** The ticker link covers the row. Buy has its own target above the link. */
export function CoinCard({ coin, rank, window, nowMs, trading, watchlist = false, marketLoading = false, livePrice, buy }: CoinCardProps) {
  const marketCoin = useMemo(() => coinAtPrice(coin, livePrice), [coin, livePrice]);
  const valuationAt = livePrice && !coin.live_inputs ? coin.price_as_of_ms : marketCoin.price_as_of_ms;
  const id = useId();
  const tradingCoin = coin.lifecycle === "migrated";
  const canBuy = tradingCoin && coin.tradable && trading;
  return (
    <li data-list-row={homeCoinKey(coin)} className={styles.item} data-lifecycle={coin.lifecycle}>
      <article
        aria-labelledby={id}
        className={clsx(styles.row, styles.cols, styles.coinRow)}
        data-buy={buy && buy.tier !== "small" ? buy.tier : undefined}
        data-sale={tradingCoin ? undefined : ""}
        data-surface=""
      >
        {rank === undefined ? null : <span className={clsx("num", styles.rank)}>{rank.toLocaleString("en-US")}</span>}
        <CoinIdentity coin={coin} id={id} buy={buy} />
        {tradingCoin ? <MarketCells window={window} coin={marketCoin} nowMs={nowMs} loading={marketLoading} valuationAt={valuationAt} /> : <SaleCells coin={coin} nowMs={nowMs} />}
        {canBuy || watchlist ? <span className={styles.rowActions}>
          {canBuy ? <RowBuy coin={coin} /> : null}
          {watchlist ? <RemoveSavedCoin coin={coin} /> : null}
        </span> : null}
      </article>
    </li>
  );
}

/** Buying a coin opens the shell's transaction dialog with the coin chosen (nothing executes); with the page as a fallback. */
function useStartBuy(coin: HomeCoin): () => void {
  const run = useShellActions();
  return () => {
    homeAnalytics.trade(homeCoinKey(coin), "buy");
    if (!run("openTrade", encodeTradeAction({ side: "buy", coin: tradeCoinOf(coin) }))) {
      window.location.assign(homeCoinHref(coin) ?? coinPagePath(coin.coin_type));
    }
  };
}

function RowBuy({ coin }: Readonly<{ coin: HomeCoin }>) {
  const startBuy = useStartBuy(coin);
  return <Button aria-haspopup="dialog" aria-label={`Buy ${coin.symbol}`} onClick={startBuy} size="sm" variant="primary">Buy</Button>;
}

function RemoveSavedCoin({ coin }: Readonly<{ coin: HomeCoin }>) {
  const star = useWatchStar({ presale_id: homeCoinKey(coin), name: coin.name });
  const label = `Remove ${coin.symbol} from your watchlist`;
  return (
    <IconButton aria-label={label} onClick={() => {
      homeAnalytics.watchlistAction(homeCoinKey(coin), !star.on);
      star.toggle();
    }} size="touch" title={label}><CloseIcon /></IconButton>
  );
}

/** The sale's coin as the swap names it, from the item. */
function tradeCoinOf(coin: HomeCoin): SocialTradeCoin {
  return { coin_type: coin.coin_type, symbol: coin.symbol, name: coin.name, decimals: coin.decimals, icon_url: coin.icon_url, usd_price: coin.price_usd, presale_id: coin.presale_id };
}

/** The identity: the coin icon, linked symbol, name and the venue's logo (its name for assistive technology and on hover). */
function CoinIdentity({ coin, id, buy }: Readonly<{ coin: HomeCoin; id: string; buy?: HomeBuyCue }>) {
  const venue = coin.venue && coin.lifecycle !== "cancelled" ? coin.venue : null;
  const href = homeCoinHref(coin) ?? coinPagePath(coin.coin_type);
  const distinct = coin.name.trim().toLowerCase() !== coin.symbol.trim().toLowerCase();
  return (
    <span className={styles.ident}>
      <PresaleMark coinType={coin.coin_type} presaleId={homeCoinKey(coin)} size={44} src={coin.icon_url} />
      <span className={styles.identText}>
        {buy ? <span aria-hidden="true" className={styles.buyAnchor}>
          <span className={clsx("num", styles.buyCue)} data-home-buy={buy.tier}>{buy.text}</span>
        </span> : null}
        <span className="coinNamed">
          <Link aria-label={distinct ? `Open ${coin.name} (${coin.symbol})` : `Open ${coin.symbol}`} className={styles.symbol} href={href} id={id} prefetch={false}>
            <NavPending label={`Opening ${coin.symbol}`}>{coin.symbol}</NavPending>
          </Link>
          {coin.verified_team ? <CoinVerifiedMark /> : null}
        </span>
        <span className={clsx(styles.coinName, styles.coinMeta)}>
          {distinct ? <span className={styles.coinNameText} title={hoverExcerpt(coin.name)}>{coin.name}</span> : null}
          {venue ? <span className={styles.coinVenue}><DexIdentity iconOnly venue={venue} /></span> : null}
        </span>
      </span>
    </span>
  );
}

function MarketValue({ value, loading, name }: Readonly<{ value: string | null; loading: boolean; name: string }>) {
  if (value !== null) return value;
  return loading ? <span className={styles.metricLoading} role="status" aria-label={`Loading ${name}`} /> : null;
}

function marketObservation(asOfMs: number | null, nowMs: number) {
  if (asOfMs === null || nowMs - asOfMs <= 120_000) return undefined;
  return `Last price update ${utc(asOfMs)}`;
}

function MarketPrice({ amount, at, loading, observed }: Readonly<{ amount: string | null; at: number | null; loading: boolean; observed?: string }>) {
  const node = useRef<HTMLSpanElement>(null);
  const display = amount === null ? null : homeTablePrice(amount);
  usePriceTick(node, amount, display, at);
  if (!loading && display === null) return null;
  return <span className={clsx("num", styles.price)} title={observed} data-stale={observed ? true : undefined}>
    <span ref={node} data-slot="coin-price"><MarketValue value={display} loading={loading} name="Price" /></span>{observed ? <span className="sr-only">{observed}</span> : null}
  </span>;
}

function MarketFdv({ value, loading, observed }: Readonly<{ value: string | null; loading: boolean; observed?: string }>) {
  if (!loading && value === null) return null;
  return <span className={clsx("num", styles.fdv)} title={observed} data-stale={observed ? true : undefined}><MarketValue value={value} loading={loading} name="FDV" /></span>;
}

function StaleMarketLabel({ observed }: Readonly<{ observed?: string }>) {
  return observed ? <>
    <span className={styles.mobileMarketLabel} aria-hidden="true">Stale</span>
    <span className="sr-only">{observed}</span>
  </> : null;
}

function MobileFdv({ value, loading, observed }: Readonly<{ value: string | null; loading: boolean; observed?: string }>) {
  if (value === null && !loading) return null;
  return <span className={clsx("num", styles.mobileFdv)} title={observed}>
    <span className={styles.mobileMarketLabel}>FDV</span>
    <span><MarketValue value={value} loading={loading} name="FDV" /></span>
    {value !== null ? <StaleMarketLabel observed={observed} /> : null}
  </span>;
}

function MobilePriceChange({ bps, window, observed, since }: Readonly<{ bps: number; window: HomeWindow; observed?: string; since?: string }>) {
  return <span className={clsx("num", styles.change, styles.mobileChange, bps > 0 ? styles.up : bps < 0 ? styles.down : undefined)} title={since}>
    <span className="sr-only">{since ?? (window === "1h" ? "1-hour price change" : "24-hour price change")} </span>
    <span className={since ? styles.mobileMarketLabel : styles.changeWindow} aria-hidden="true">{since ? "≤24h" : window}</span>
    {bps === 0 ? "0%" : signPct(bps / 100)}
    <StaleMarketLabel observed={observed} />
  </span>;
}

function PriceChangeCells({ coin, window, observed }: Readonly<{ coin: HomeCoin; window: HomeWindow; observed?: string }>) {
  const bps = window === "1h" ? coin.mobile_market?.change_1h_bps : coin.change_24h_bps;
  if (coin.price_usd === null || bps == null) return null;
  const since = window === "24h" && coin.change_24h_from_ms !== undefined
    ? `Since the first price on ${utc(coin.change_24h_from_ms)}`
    : undefined;
  return <>
    <span className={clsx("num", styles.change, styles.desktopChange, bps >= 0 ? styles.up : styles.down)} title={since}>
      {since ? <>
        <span className="sr-only">{since} </span>
        <span className={styles.changeWindow} aria-hidden="true">≤24h </span>
      </> : null}{signPct(bps / 100)}
    </span>
    <MobilePriceChange bps={bps} window={window} observed={observed} since={since} />
  </>;
}

/** Each figure stays in its own column when other figures are missing. */
function MarketCells({ coin, nowMs, window, loading, valuationAt }: Readonly<{ coin: HomeCoin; window: HomeWindow; nowMs: number; loading: boolean; valuationAt: number | null }>) {
  const facts = marketFacts(coin, nowMs);
  const observed = marketObservation(valuationAt, nowMs);
  const { text: volume, label: volumeLabel } = marketVolume(coin);
  const concentration = shareText(coin.top_holders.share_bps);
  return <>
    <span className={styles.marketQuote}>
      <MarketPrice amount={coin.price_usd} at={coin.price_as_of_ms} loading={loading} observed={marketObservation(coin.price_as_of_ms, nowMs)} />
      <MobileFdv value={facts.fdv} loading={loading} observed={observed} />
    </span>
    <PriceChangeCells coin={coin} window={window} observed={facts.fdv === null ? observed : undefined} />
    <span className={clsx("num", styles.vol)}>
      <span aria-hidden="true">{volume ?? NO_VALUE}</span>
      <span className="sr-only">{volumeLabel}</span>
    </span>
    <MarketFdv value={facts.fdv} loading={loading} observed={observed} />
    {concentration !== null ? <span className={clsx("num", styles.top)}>{concentration}</span> : null}
    {coin.launched_ms !== null ? <span className={clsx("num", styles.age)}>{bxAgo(coin.launched_ms, nowMs)}</span> : null}
    <WeekLine coin={coin} up={facts.change?.up} />
  </>;
}

/** Use the row's observed day history when the weekly reader has too few samples. */
function WeekLine({ coin, up }: Readonly<{ coin: HomeCoin; up: boolean | undefined }>) {
  const history = usePrice({ presaleId: coin.presale_id, coin: coin.coin_type, window: "7d" });
  const useWeek = (history?.points.length ?? 0) >= 2 || (coin.spark.length === 0 && Boolean(history?.points.length));
  const source = useWeek ? history?.points : coin.spark;
  const observed = useMemo(() => source?.map(([at, usd]) => [at, Number(usd)] as const) ?? null, [source]);
  const points = useMemo(() => sparkAtPrice(observed, coin.price_as_of_ms, coin.price_usd, useWeek ? 7 : 1),
    [observed, coin.price_as_of_ms, coin.price_usd, useWeek]);
  const tone = up === undefined ? (points && points.length >= 2 ? (points.at(-1)![1] >= points[0]![1] ? styles.up : styles.down) : undefined) : up ? styles.up : styles.down;
  return <HomeSpark className={clsx(styles.week, tone)} points={points} slot="coin-week" title={useWeek ? "Last 7 days" : "Last 24 hours"} />;
}

/** A presale's cells in the same columns: raised, of target, the bar, backers, the state, the time. */
function SaleCells({ coin, nowMs }: Readonly<{ coin: HomeCoin; nowMs: number }>) {
  if (coin.sale === null) return null;
  const { raised, target } = raiseFigures(coin);
  const pct = fillPercent(Number(coin.sale.raised), Number(coin.sale.raise_target));
  const oversubscribed = BigInt(coin.sale.raised) > BigInt(coin.sale.raise_target) && BigInt(coin.sale.raise_target) > BigInt(0);
  const lifecycle = saleLifecycleAt(coin.lifecycle, coin.sale.start_ms, nowMs);
  const closingSoon = lifecycle === "open" && coin.sale.end_ms > nowMs && coin.sale.end_ms - nowMs <= 3_600_000;
  return <>
    <span className={styles.funding}>
      <span className="num">{raised ?? <Unknown why="Raised amount unavailable" />} <span className={styles.ofTarget}>/ {target ?? <Unknown why="Target unavailable" />}</span></span>
      <span className={styles.bar} role="progressbar" aria-label={`Raised ${raised ?? "unknown"} of ${target ?? "unknown"}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, pct)} aria-valuetext={`${raised ?? "Unknown"} raised of ${target ?? "unknown"}${oversubscribed ? "; oversubscribed" : ""}`}><Fill pct={Math.min(100, pct)} /></span>
    </span>
    <SaleClosingTime coin={coin} nowMs={nowMs} />
    <span className={clsx("num", styles.backers)}><span className={styles.mobileLabel}>Backers</span>{coin.sale.participants.toLocaleString("en-US")}</span>
    <span className={styles.saleStatus}><span className="status" data-tone={lifecycleTone(lifecycle)}>{stateWord(lifecycle)}</span>{oversubscribed ? <span>Above target</span> : closingSoon ? <span>Closing soon</span> : null}</span>
  </>;
}

function SaleClosingTime({ coin, nowMs }: Readonly<{ coin: HomeCoin; nowMs: number }>) {
  const due = saleDue(coin, nowMs);
  const lifecycle = saleLifecycleAt(coin.lifecycle, coin.sale?.start_ms, nowMs);
  return <span className={clsx("num", styles.closes)}><span className={styles.mobileLabel}>{due?.word === "opens" ? "Opens" : "Closes"}</span>{due?.time || (lifecycle === "open" ? "Awaiting close" : lifecycle === "pending" ? <Unknown why="Opening time unavailable" /> : "Ended")}</span>;
}

/** The sale's state as a word in its column (`saleLifecycleAt`): `open`, `upcoming`, `funded`, `cancelled`. */
function stateWord(lifecycle: string): string {
  switch (lifecycle) {
    case "open":
      return "open";
    case "pending":
      return "upcoming";
    case "funded":
      return "funded";
    default:
      return lifecycle;
  }
}

/** When the sale closes or opens, to the minute (`closes 1h 11m`, `opens 39m`): a row never ticks by the second. */
function saleDue(coin: HomeCoin, nowMs: number): Readonly<{ word: string; time: string }> | null {
  if (coin.sale === null) return null;
  const coarse = (ms: number) => timeUntil(ms, nowMs).replace(/\s*\d+s$/, "") || "<1m";
  const lifecycle = saleLifecycleAt(coin.lifecycle, coin.sale.start_ms, nowMs);
  if (lifecycle === "open" && coin.sale.end_ms > nowMs) return { word: "closes", time: coarse(coin.sale.end_ms) };
  if (lifecycle === "pending" && coin.sale.start_ms > nowMs) return { word: "opens", time: coarse(coin.sale.start_ms) };
  if (lifecycle === "funded") return { word: "funded", time: "" };
  return null;
}
