"use client";

import { signPct } from "@blast/core/web/format.ts";
import clsx from "clsx";
import type { ReactNode } from "react";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { readablePrice } from "#web/lib/market-format.ts";
import type { HappeningCoin } from "@blast/core/web/contracts/happening.ts";

import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import styles from "./Happening.module.css";
import { useHappening } from "./use-happening";
import { TrendingCoinSparkline } from "./TrendingCoinSparkline";

export function TrendingCoinStrip() {
  const { read, failed } = useHappening(null);
  const run = useShellActions();
  return <TrendingCoinStripView coins={read?.top_coins?.trending ?? null} refresh={read?.clock_ms} loading={read === null && !failed} onOpen={(key) => run("openCoin", key)} />;
}

/** The rail's rows while the first read is out. */
function StripLoading({ className, itemClass, detailed }: Readonly<{ className: string; itemClass: string; detailed: boolean }>) {
  return (
    <div aria-label="Loading trending coins" aria-busy="true" className={className} data-aside-card="" data-route-loading="rail" role="group">
      {Array.from({ length: 5 }, (_, index) => (
        <div aria-hidden="true" className={itemClass} key={index}>
          <span className={styles.trendingPlaceholder} />
          {detailed ? (
            <>
              <b className={styles.trendingTicker}><SkeletonText>Ticker</SkeletonText></b>
              <span aria-hidden="true" className={styles.trendingSpark} />
              <span className={styles.trendingValue}>
                <b><SkeletonText>Price</SkeletonText></b>
                <span><SkeletonText>Change</SkeletonText></span>
              </span>
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** A price in dollars with subscript zeros (`$0.0₈182`), never in exponent form. */
function priceText(raw: string): string {
  return `$${readablePrice(raw)}`;
}

/** The coin's accessible name: what the card or row shows, then where it goes. */
function coinLabel(coin: HappeningCoin): string {
  const change = coin.change_24h_bps;
  return `${coin.symbol}, ${coin.name}, ${priceText(coin.price_usd)}, ${change === null ? "24h change unavailable" : `${signPct(change / 100)} today`}. View coin`;
}

/** A coin's card or row: one button that opens the coin's sheet (the rail's and Home's rule), named by what it shows. */
function OpenCoin({ coin, className, onOpen, children }: Readonly<{ coin: HappeningCoin; className: string; onOpen: (key: string) => void; children: ReactNode }>) {
  const label = coinLabel(coin);
  return <button aria-haspopup="dialog" aria-label={label} className={className} onClick={() => onOpen(coinKey(coin))} title={label} type="button">{children}</button>;
}

const coinKey = (coin: HappeningCoin) => coin.presale_id ?? "sui";

function Mark({ coin }: Readonly<{ coin: HappeningCoin }>) {
  return <CoinMark coin={{ key: coinKey(coin), iconUrl: coin.icon_url, round: coin.presale_id === null, symbol: coin.symbol, coinType: coin.coin_type }} size={28} />;
}

export function TrendingCoinStripView({ coins, onOpen, expanded = false, loading = false, refresh }: Readonly<{
  coins: readonly HappeningCoin[] | null;
  onOpen: (key: string) => void;
  expanded?: boolean;
  loading?: boolean;
  refresh?: number;
}>) {
  const className = clsx(styles.trendingCoins, !expanded && styles.coinMini);
  if (loading) return <StripLoading className={className} detailed={expanded} itemClass={styles.trendingRow} />;
  if (!coins || coins.length === 0) {
    const label = coins ? "No trending coins yet" : "Trending coins are unavailable right now";
    return <div aria-label={label} className={className} data-aside-card="" role="group"><span className={styles.coinStatus} title={label}>{expanded ? label : <span className="sr">{label}</span>}</span></div>;
  }
  return (
    <div aria-label="Trending coins" className={className} data-aside-card="" role="group">
      {coins.slice(0, 10).map((coin) => {
        const change = coin.change_24h_bps;
        return (
          <OpenCoin className={styles.trendingRow} coin={coin} key={coin.coin_type} onOpen={onOpen}>
            <Mark coin={coin} />
            {expanded ? (
              <>
                <span className={styles.tickerNamed}><b className={styles.trendingTicker}>{coin.symbol}</b>{coin.verified_team ? <CoinVerifiedMark size="sm" /> : null}</span>
                <TrendingCoinSparkline coin={coin} refresh={refresh} />
                <span className={styles.trendingValue}>
                  <b className="num">{priceText(coin.price_usd)}</b>
                  <span className={clsx("num", change === null ? undefined : change >= 0 ? styles.up : styles.down)}>
                    {change === null ? null : signPct(change / 100)}
                  </span>
                </span>
              </>
            ) : null}
          </OpenCoin>
        );
      })}
    </div>
  );
}
