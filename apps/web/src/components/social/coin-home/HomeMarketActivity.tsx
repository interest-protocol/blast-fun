"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

import { FeelSoundButton } from "#web/components/blast-feel/FeelSoundSwitch.tsx";
import { useFeelSound } from "#web/components/blast-feel/FeelProvider.tsx";
import { useSoundSwitch } from "#web/components/social/settings/use-sound-switch.ts";
import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { signPct } from "@blast/core/web/format.ts";
import type { HomeCoin, HomeWindow } from "@blast/core/web/contracts/home.ts";

import { homeCoinHref } from "./home-model";
import styles from "./CoinHome.module.css";
import { HOME_PRICE_MOVE_FRESH_MS, type HomePriceMove } from "./use-home-prices";

type MarketNote = Readonly<{ coin: HomeCoin; bps: number; period: string }>;

function priceHighlight(coins: readonly HomeCoin[], window: HomeWindow, nowMs: number): MarketNote | null {
  let best: MarketNote | null = null;
  for (const coin of coins) {
    if (coin.lifecycle !== "migrated" || coin.price_usd === null || coin.price_as_of_ms === null ||
      nowMs - coin.price_as_of_ms > HOME_PRICE_MOVE_FRESH_MS) continue;
    const bps = window === "1h" ? coin.mobile_market?.change_1h_bps : coin.change_24h_bps;
    if (!bps || (best && Math.abs(bps) <= Math.abs(best.bps))) continue;
    const period = window === "24h" && coin.change_24h_from_ms !== undefined ? "since first quote" : `in ${window}`;
    best = { coin, bps, period };
  }
  return best;
}

type HomeMarketActivityProps = Readonly<{
  coins: readonly HomeCoin[];
  move: HomePriceMove | null;
  nowMs: number;
  window: HomeWindow;
}>;

export function HomeMarketActivity({ coins, move, nowMs, window }: HomeMarketActivityProps) {
  const { play } = useFeelSound();
  const sound = useSoundSwitch();
  const sounded = useRef<HomePriceMove | null>(null);
  const fresh = move && nowMs - move.seenAtMs <= HOME_PRICE_MOVE_FRESH_MS ? move : null;
  const note = fresh ? { ...fresh, period: "since last quote" } : priceHighlight(coins, window, nowMs);
  const direction = note && note.bps < 0 ? "down" : "up";
  const label = <span className={styles.marketActivityLabel}>Market activity</span>;
  const change = note ? signPct(Math.abs(note.bps) / 100).slice(1) : "";
  const message = note ? `$${note.coin.symbol} ${direction} ${change} ${note.period}` : "";

  useEffect(() => {
    if (!fresh || sounded.current === fresh) return;
    sounded.current = fresh;
    play({ kind: fresh.bps > 0 ? "curve-buy" : "curve-sell" });
  }, [fresh, play]);

  return (
    <div className={styles.marketActivity} data-market-activity="" data-direction={note ? direction : undefined}>
      <span aria-atomic="true" className="sr" role="status">{fresh ? message : ""}</span>
      {note ? (
        <Link
          aria-label={message}
          className={`${styles.marketActivityContent} ${styles.marketActivityLink}`}
          href={homeCoinHref(note.coin) ?? coinPagePath(note.coin.coin_type)}
          prefetch={false}
          title={message}
        >
          {label}
          <span className={styles.marketActivityQuote} data-arrival={fresh ? "" : undefined} key={fresh?.seenAtMs}>
            <span className={`ticker ${styles.marketActivitySymbol}`}>${note.coin.symbol}</span>
            <span className={styles.marketActivityChange}><span aria-hidden="true">{direction === "up" ? "↑" : "↓"}</span> {change}</span>
            <span className={styles.marketActivityPeriod}>{note.period}</span>
          </span>
        </Link>
      ) : (
        <div className={styles.marketActivityContent}>
          {label}
          <span className={styles.marketActivityPeriod}>Waiting for price moves</span>
        </div>
      )}
      <FeelSoundButton onToggle={sound.set} />
    </div>
  );
}
