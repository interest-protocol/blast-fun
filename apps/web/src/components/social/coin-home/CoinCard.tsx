"use client";

import { hoverExcerpt } from "#web/lib/hover-text.ts";
import { Button, IconButton } from "#web/components/blast-ui/Button.tsx";
import { NavPending } from "#web/components/blast-ui/NavigationLink.tsx";

import clsx from "clsx";
import Link from "next/link";
import { useId, useMemo, useRef } from "react";
import { usePriceTick, useTradeTick } from "./use-price-tick";
import { coinAtPrice } from "./live-market";

import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { CoinVerifiedMark, CloseIcon } from "#web/components/blast-ui/Icons.tsx";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { bxAgo, NO_VALUE, signPct, utc } from "@blast/core/web/format.ts";
import type { HomeCoin, HomeWindow } from "@blast/core/web/contracts/home.ts";

import { encodeTradeAction } from "../coins/swap-model";
import { useWatchStar } from "../watchlist/Watchlist";
import { PresaleMark } from "../post/PostMedia";
import styles from "./CoinHome.module.css";
import { homeAnalytics } from "./home-analytics";
import { homeBuyRoute, homeCoinHref, homeCoinKey, homeStatus, marketVolume, shareText, tradeCoinOf, type HomeBuyRoute, type HomePop, type HomeStatus } from "./home-model";
import { readableUsd } from "#web/lib/market-format.ts";
import type { HomeTrade } from "./use-home-prices";
import type { DisplayPrice } from "@blast/core/modules/launchpad-contract/market-stream.ts";
import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";

export type CoinCardProps = Readonly<{
  coin: HomeCoin;
  marketLoading?: boolean;
  livePrice?: DisplayPrice;
  /** This coin's latest own trade on the stream, apart from SUI moves. */
  trade?: HomeTrade | null;
  /** Trades popping on this coin right now. */
  pops?: readonly HomePop[];
  window: HomeWindow;
  nowMs: number;
  /** The trading flag: without it no trade control is drawn. */
  trading: boolean;
  watchlist?: boolean;
}>;

/**
 * One row of the Coins table (plan decision 7): Coin · MCap · price change ·
 * Volume · Holders · Status, then the row's actions. Every row draws every
 * cell, "—" where a figure is unknown, so the columns line up. The ticker
 * link covers the row; Buy has its own target above the link.
 */
export function CoinCard({ coin, window, nowMs, trading, watchlist = false, marketLoading = false, livePrice, trade = null, pops }: CoinCardProps) {
  const marketCoin = useMemo(() => coinAtPrice(coin, livePrice), [coin, livePrice]);
  const valuationAt = livePrice && !coin.live_inputs ? coin.price_as_of_ms : marketCoin.price_as_of_ms;
  const id = useId();
  const route = trading ? homeBuyRoute(coin, nowMs) : null;
  const status = homeStatus(coin, nowMs);
  // The Status cell already says where the coin trades while it names a venue or a curve still filling.
  const filling = coin.curve != null && coin.curve.lifecycle !== "migrated";
  const { text: volume, label: volumeLabel } = marketVolume(coin);
  return (
    <li className={styles.item} data-lifecycle={coin.lifecycle} data-list-row={homeCoinKey(coin)} role="none">
      <div aria-labelledby={id} className={clsx(styles.row, styles.cols, styles.coinRow)} data-surface="" role="row">
        <CoinIdentity coin={coin} pops={pops} id={id} nowMs={nowMs} venue={status.venue || filling ? null : coin.venue} />
        <MarketCap amount={marketCoin.mobile_market?.market_cap_usd ?? null} at={valuationAt} loading={marketLoading} nowMs={nowMs} />
        <PriceChange coin={marketCoin} trade={trade} window={window} />
        <span className={clsx("num", styles.vol)} role="cell">
          <span aria-hidden="true">{volume ?? NO_VALUE}</span>
          <span className="sr-only">{volumeLabel}</span>
        </span>
        <HoldersCell coin={coin} />
        <StatusCell status={status} />
        <span className={styles.rowActions} role="cell">
          {route ? <RowBuy coin={coin} route={route} /> : null}
          {watchlist ? <RemoveSavedCoin coin={coin} /> : null}
        </span>
      </div>
    </li>
  );
}

/** An unknown figure: a dash on screen, its name for assistive technology. */
function Missing({ what }: Readonly<{ what: string }>) {
  return <><span aria-hidden="true">{NO_VALUE}</span><span className="sr-only">{what} unknown</span></>;
}

/** Buying a coin opens the shell's transaction dialog with the coin chosen (nothing executes); with the page as a fallback. */
function useStartBuy(coin: HomeCoin, route: HomeBuyRoute): () => void {
  const run = useShellActions();
  return () => {
    homeAnalytics.trade(homeCoinKey(coin), "buy");
    if (!run("openTrade", encodeTradeAction({ side: "buy", coin: tradeCoinOf(coin, route) }))) {
      window.location.assign(homeCoinHref(coin) ?? coinPagePath(coin.coin_type));
    }
  };
}

function RowBuy({ coin, route }: Readonly<{ coin: HomeCoin; route: HomeBuyRoute }>) {
  const startBuy = useStartBuy(coin, route);
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

/**
 * Holders, over the top 10's share when it is known (phones drop it), even when the count is not. The line is kept
 * even when empty, so every known count sits at the same height.
 */
function HoldersCell({ coin }: Readonly<{ coin: HomeCoin }>) {
  const topTen = shareText(coin.top_holders.share_bps);
  const count = coin.holders === null ? <Missing what="Holders" /> : coin.holders.toLocaleString("en-US");
  if (coin.holders === null && topTen === null) return <span className={clsx("num", styles.holders)} role="cell">{count}</span>;
  return (
    <span className={clsx("num", styles.holders)} role="cell">
      {count}
      <span className={styles.topTen}>
        {topTen === null ? null : <><span aria-hidden="true">top 10 · {topTen}</span><span className="sr-only">, top 10 hold {topTen}</span></>}
      </span>
    </span>
  );
}

/** The identity: the coin icon, linked symbol, name, age and the venue's logo (its name for assistive technology and on hover) when the Status cell does not name it. */
function CoinIdentity({ coin, id, nowMs, pops, venue }: Readonly<{ coin: HomeCoin; id: string; nowMs: number; pops?: readonly HomePop[]; venue: string | null }>) {
  const shownVenue = venue && coin.lifecycle !== "cancelled" ? venue : null;
  const href = homeCoinHref(coin) ?? coinPagePath(coin.coin_type);
  const distinct = coin.name.trim().toLowerCase() !== coin.symbol.trim().toLowerCase();
  const age = coin.launched_ms === null ? null : bxAgo(coin.launched_ms, nowMs);
  return (
    <span className={styles.ident} role="cell">
      <PresaleMark coinType={coin.coin_type} presaleId={homeCoinKey(coin)} size={44} src={coin.icon_url} />
      <span className={styles.identText}>
        {pops?.length ? <span aria-hidden="true" className={styles.popAnchor}>
          {pops.map(pop => <span key={pop.id} className={clsx("num", styles.pop)} data-home-pop={pop.cue.tier} data-side={pop.cue.side} data-pop-slot={pop.slot}>{pop.cue.text}</span>)}
        </span> : null}
        <span className="coinNamed">
          <Link aria-label={distinct ? `Open ${coin.name} (${coin.symbol})` : `Open ${coin.symbol}`} className={styles.symbol} href={href} id={id} prefetch={false}>
            <NavPending label={`Opening ${coin.symbol}`}>{coin.symbol}</NavPending>
          </Link>
          {coin.verified_team ? <CoinVerifiedMark /> : null}
        </span>
        <span className={clsx(styles.coinName, styles.coinMeta)} data-age={age === null ? undefined : ""}>
          {distinct ? <span className={styles.coinNameText} title={hoverExcerpt(coin.name)}>{coin.name}</span> : null}
          {age === null ? null : (
            <span className={clsx("num", styles.coinAge)}>
              {distinct ? <span aria-hidden="true" className={styles.ageDot}>·</span> : null}
              <span className="sr-only">Age </span>{age}
            </span>
          )}
          {shownVenue ? <span className={styles.coinVenue}><DexIdentity iconOnly venue={shownVenue} /></span> : null}
        </span>
      </span>
    </span>
  );
}

function marketObservation(asOfMs: number | null, nowMs: number) {
  if (asOfMs === null || nowMs - asOfMs <= 120_000) return undefined;
  return `Last price update ${utc(asOfMs)}`;
}

/** Market cap from the live price (`coinAtPrice`); a change in its visible digits pulses once in its direction. */
function MarketCap({ amount, at, loading, nowMs }: Readonly<{ amount: string | null; at: number | null; loading: boolean; nowMs: number }>) {
  const node = useRef<HTMLSpanElement>(null);
  const display = amount === null ? null : readableUsd(amount);
  usePriceTick(node, amount, display, at);
  const observed = marketObservation(at, nowMs);
  return <span className={clsx("num", styles.mcap)} data-stale={observed && display ? true : undefined} role="cell" title={display ? observed : undefined}>
    <span data-slot="coin-mcap" ref={node}>
      {display ?? (loading ? <span aria-label="Loading market cap" className={styles.metricLoading} role="status" /> : <Missing what="Market cap" />)}
    </span>
    {observed && display ? <span className="sr-only">{observed}</span> : null}
  </span>;
}

/**
 * The price move over the window, signed and coloured like every price move: green up, red down, neutral when flat.
 * Its two decimals show a trade the rounded market cap hides, so a trade on this coin alone washes it briefly in the
 * trade's direction, as the chart's last trade does. A SUI move, a window switch or a baseline rollover changes it quietly.
 * A row without a figure yet washes its dash on each trade, so every row shows its own trades.
 */
function PriceChange({ coin, trade, window }: Readonly<{ coin: HomeCoin; trade: HomeTrade | null; window: HomeWindow }>) {
  const node = useRef<HTMLSpanElement>(null);
  const bps = window === "1h" ? coin.mobile_market?.change_1h_bps : coin.change_24h_bps;
  const display = coin.price_usd === null || bps == null ? null : changeText(bps);
  useTradeTick(node, display, trade);
  if (display === null || bps == null) return <span className={clsx("num", styles.change)} role="cell">
    <span className={styles.changeFigure} data-slot="coin-change" ref={node}><Missing what="Price change" /></span>
  </span>;
  const since = window === "24h" && coin.change_24h_from_ms !== undefined
    ? `Since the first price on ${utc(coin.change_24h_from_ms)}`
    : undefined;
  return <span className={clsx("num", styles.change, bps > 0 && styles.up, bps < 0 && styles.down)} role="cell" title={since}>
    {since ? <>
      <span className="sr-only">{since} </span>
      <span aria-hidden="true" className={styles.changeWindow}>≤24h </span>
    </> : null}<span className={styles.changeFigure} data-slot="coin-change" ref={node}>{display}</span>
  </span>;
}

function changeText(bps: number): string {
  return bps === 0 ? "0%" : signPct(bps / 100);
}

/** Where the coin is in its life, in one line: a filling curve or an open sale draws its bar; a coin with no Blast history, its venue. */
function StatusCell({ status }: Readonly<{ status: HomeStatus }>) {
  return <span className={styles.status} role="cell">
    {status.venue ? <DexIdentity venue={status.venue} /> : <>
      {status.fill === undefined ? null : <progress aria-hidden="true" className={styles.fill} max={100} value={status.fill} />}
      {status.label ? <><span aria-hidden="true" className={styles.statusText}>{status.text}</span><span className="sr-only">{status.label}</span></> : <span className={styles.statusText}>{status.text}</span>}
    </>}
  </span>;
}
