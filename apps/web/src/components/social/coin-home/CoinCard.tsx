"use client";

import { hoverExcerpt } from "#web/lib/hover-text.ts";
import { Button, IconButton } from "#web/components/blast-ui/Button.tsx";
import { NavPending } from "#web/components/blast-ui/NavigationLink.tsx";

import clsx from "clsx";
import Link from "next/link";
import { useId, useMemo, useRef } from "react";
import { usePriceTick } from "./use-price-tick";
import { coinAtPrice } from "./live-market";

import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { CoinVerifiedMark, CloseIcon } from "#web/components/blast-ui/Icons.tsx";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { NO_VALUE, signPct, utc } from "@blast/core/web/format.ts";
import type { HomeCoin, HomeWindow } from "@blast/core/web/contracts/home.ts";
import type { SocialTradeCoin } from "@blast/core/web/contracts/trades.ts";

import { encodeTradeAction } from "../coins/swap-model";
import { useWatchStar } from "../watchlist/Watchlist";
import { PresaleMark } from "../post/PostMedia";
import styles from "./CoinHome.module.css";
import { homeAnalytics } from "./home-analytics";
import { homeCoinHref, homeCoinKey, homeStatus, marketVolume, type HomeBuyCue, type HomeStatus } from "./home-model";
import { readableUsd } from "#web/lib/market-format.ts";
import type { DisplayPrice } from "@blast/core/modules/launchpad-contract/market-stream.ts";
import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";

export type CoinCardProps = Readonly<{
  coin: HomeCoin;
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

/**
 * One row of the Coins table (plan decision 7): Coin · MCap · price change ·
 * Volume · Holders · Status, then the row's actions. Every row draws every
 * cell, "—" where a figure is unknown, so the columns line up. The ticker
 * link covers the row; Buy has its own target above the link.
 */
export function CoinCard({ coin, window, nowMs, trading, watchlist = false, marketLoading = false, livePrice, buy }: CoinCardProps) {
  const marketCoin = useMemo(() => coinAtPrice(coin, livePrice), [coin, livePrice]);
  const valuationAt = livePrice && !coin.live_inputs ? coin.price_as_of_ms : marketCoin.price_as_of_ms;
  const id = useId();
  const canBuy = coin.lifecycle === "migrated" && coin.tradable && trading;
  const status = homeStatus(coin, nowMs);
  // The Status cell already says where the coin trades while it names a venue or a curve still filling.
  const filling = coin.curve != null && coin.curve.lifecycle !== "migrated";
  const { text: volume, label: volumeLabel } = marketVolume(coin);
  return (
    <li className={styles.item} data-lifecycle={coin.lifecycle} data-list-row={homeCoinKey(coin)} role="none">
      <div aria-labelledby={id} className={clsx(styles.row, styles.cols, styles.coinRow)} data-surface="" role="row">
        <CoinIdentity buy={buy} coin={coin} id={id} venue={status.venue || filling ? null : coin.venue} />
        <MarketCap amount={marketCoin.mobile_market?.market_cap_usd ?? null} at={valuationAt} loading={marketLoading} nowMs={nowMs} />
        <PriceChange coin={marketCoin} window={window} />
        <span className={clsx("num", styles.vol)} role="cell">
          <span aria-hidden="true">{volume ?? NO_VALUE}</span>
          <span className="sr-only">{volumeLabel}</span>
        </span>
        <span className={clsx("num", styles.holders)} role="cell">{coin.holders === null ? <Missing what="Holders" /> : coin.holders.toLocaleString("en-US")}</span>
        <StatusCell status={status} />
        <span className={styles.rowActions} role="cell">
          {canBuy ? <RowBuy coin={coin} /> : null}
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

/** The identity: the coin icon, linked symbol, name and the venue's logo (its name for assistive technology and on hover) when the Status cell does not name it. */
function CoinIdentity({ coin, id, buy, venue }: Readonly<{ coin: HomeCoin; id: string; buy?: HomeBuyCue; venue: string | null }>) {
  const shownVenue = venue && coin.lifecycle !== "cancelled" ? venue : null;
  const href = homeCoinHref(coin) ?? coinPagePath(coin.coin_type);
  const distinct = coin.name.trim().toLowerCase() !== coin.symbol.trim().toLowerCase();
  return (
    <span className={styles.ident} role="cell">
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

/** The price move over the window, signed and uncoloured: the row's one colour is its progress bar (Shibui). */
function PriceChange({ coin, window }: Readonly<{ coin: HomeCoin; window: HomeWindow }>) {
  const bps = window === "1h" ? coin.mobile_market?.change_1h_bps : coin.change_24h_bps;
  if (coin.price_usd === null || bps == null) return <span className={clsx("num", styles.change)} role="cell"><Missing what="Price change" /></span>;
  const since = window === "24h" && coin.change_24h_from_ms !== undefined
    ? `Since the first price on ${utc(coin.change_24h_from_ms)}`
    : undefined;
  return <span className={clsx("num", styles.change)} role="cell" title={since}>
    {since ? <>
      <span className="sr-only">{since} </span>
      <span aria-hidden="true" className={styles.changeWindow}>≤24h </span>
    </> : null}{bps === 0 ? "0%" : signPct(bps / 100)}
  </span>;
}

/** Where the coin is in its life, in one line: a filling curve or an open sale draws its bar; a coin with no Blast history, its venue. */
function StatusCell({ status }: Readonly<{ status: HomeStatus }>) {
  return <span className={styles.status} role="cell">
    {status.venue ? <DexIdentity venue={status.venue} /> : <>
      {status.fill === undefined ? null : <progress aria-hidden="true" className={styles.fill} max={100} value={status.fill} />}
      <span className={styles.statusText}>{status.text}</span>
    </>}
  </span>;
}
