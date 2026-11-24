"use client";

import { useCallback, useState, type ReactNode } from "react";
import { dyn } from "#web/components/blast-ui/csp-style.ts";
import { short, NO_VALUE } from "@blast/core/web/format.ts";
import { HOME_MARKET_WINDOWS, type HomeCoinMarket, type HomeMarketWindow, type HomeMarketWindowName } from "@blast/core/web/contracts/coin-market.ts";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { fetchCoinMarket } from "./coin-market-reads";
import type { CoinAsset, CoinRecord } from "./coin-reads";
import { useCoinRead } from "./use-coin-read";
import styles from "./FlowCard.module.css";

const LABELS: Readonly<Record<HomeMarketWindowName, string>> = { "5m": "5M", "1h": "1H", "4h": "4H", "24h": "1D" };
/** The period a heading, its read and its empty line all name (audit BM-07). */
const PERIODS: Readonly<Record<HomeMarketWindowName, string>> = { "5m": "5 minutes", "1h": "hour", "4h": "4 hours", "24h": "day" };

/**
 * Flow (BlastMode.dc.html): the coin's move over 5 minutes, 1 hour, 4 hours and
 * a day, and the chosen window's buy and sell pressure on every venue —
 * trades, dollars and wallets on each side; with no trade in any window it is one
 * compact line (audit 23). One public read
 * (`GET /api/social/home/market`, redesign data gaps); a side without a priced
 * trade has no dollars, so its row is left out rather than shown as zero.
 */
export function FlowCard({ asset, coin, visible }: Readonly<{ asset: CoinAsset; coin: CoinRecord | null; visible: boolean }>) {
  const [window, setWindow] = useState<HomeMarketWindowName>("1h");
  const load = useCallback((signal: AbortSignal) => fetchCoinMarket(asset.coin_type, signal), [asset.coin_type]);
  const market = useCoinRead<HomeCoinMarket>(visible && asset.network === "mainnet", asset.coin_type, load);
  if (asset.network !== "mainnet") return null;
  const value = market.value?.coin_type === asset.coin_type ? market.value : null;
  const quiet = value !== null && HOME_MARKET_WINDOWS.every((key) => value.windows[key].buys + value.windows[key].sells === 0);
  // With no trade in any window the card states the widest window, so heading and line name one period.
  const shown = quiet ? "24h" : window;
  return (
    <section className={styles.flow} aria-label="Flow" aria-busy={market.status === "pending" || undefined}>
      <header className={styles.head}>
        <h2>Flow</h2>
        {market.status === "error" && !value ? null : <span>All venues · {LABELS[shown].toLowerCase()}</span>}
      </header>
      {market.status === "error" && !value ? (
        <FlowFailure unavailable={market.unavailable} retry={market.retry} />
      ) : quiet ? (
        <EmptyState compact role="status" title={`No trades in the last ${PERIODS["24h"]}`} />
      ) : (
        <>
          <div className={styles.windows} role="group" aria-label="Window">
            {HOME_MARKET_WINDOWS.map((key) => (
              <Button key={key} variant="secondary" size="md" type="button" className={styles.window} aria-pressed={window === key} onClick={() => setWindow(key)}>
                <span className={styles.windowName}>{LABELS[key]}</span>
                <WindowMove window={value?.windows[key] ?? null} loading={!value} />
              </Button>
            ))}
          </div>
          <FlowPressure window={value?.windows[window] ?? null} period={PERIODS[window]} symbol={coin?.symbol ?? null} />
        </>
      )}
    </section>
  );
}

function FlowPressure({ window, period, symbol }: Readonly<{ window: HomeMarketWindow | null; period: string; symbol: string | null }>) {
  if (!window) return <span role="status" aria-label="Loading flow"><SkeletonText>Buy and sell activity</SkeletonText></span>;
  if (window.buys + window.sells === 0) return <EmptyState compact role="status" title={`No trades in the last ${period}`} />;
  return <Pressure window={window} symbol={symbol} />;
}

/** Coverage the service does not have is a fact, not a failure: no Retry. A failed read offers one. */
function FlowFailure({ unavailable, retry }: Readonly<{ unavailable?: boolean; retry: () => void }>) {
  return unavailable
    ? <EmptyState compact role="status" title="Flow unavailable for this coin" />
    : <EmptyState compact role="alert" title="Flow could not load" action={<Button variant="secondary" size="sm" type="button" onClick={retry}>Retry</Button>} />;
}

function WindowMove({ window, loading }: Readonly<{ window: HomeMarketWindow | null; loading: boolean }>) {
  if (loading) return <SkeletonText>+0.00%</SkeletonText>;
  const bps = window?.change_bps;
  if (bps == null) return <span className={styles.move}><span className="sr">No price at the window&apos;s start</span>{NO_VALUE}</span>;
  const direction = bps > 0 ? "up" : bps < 0 ? "down" : "flat";
  return <span className={styles.move} data-direction={direction}>{`${bps > 0 ? "+" : bps < 0 ? "−" : ""}${(Math.abs(bps) / 100).toFixed(2)}%`}</span>;
}

function Pressure({ window, symbol }: Readonly<{ window: HomeMarketWindow; symbol: string | null }>) {
  const hidden = useShellPrefs().amountsHidden;
  const count = (value: number) => value.toLocaleString("en-US");
  const priced = window.bought_usd !== null || window.sold_usd !== null;
  return (
    <div className={styles.pressure}>
      <PressureRow a={count(window.buys)} aLabel={plural(window.buys, "buy")} b={count(window.sells)} bLabel={plural(window.sells, "sell")} share={[window.buys, window.sells]} />
      {priced && (
        <PressureRow
          a={hidden ? "••••" : <SideDollars usd={window.bought_usd} unpriced={window.unpriced_buys} label={`USD bought${symbol ? ` of ${symbol}` : ""}`} />}
          aLabel="bought"
          b={hidden ? "••••" : <SideDollars usd={window.sold_usd} unpriced={window.unpriced_sells} label={`USD sold${symbol ? ` of ${symbol}` : ""}`} />}
          bLabel="sold"
          share={[Number(window.bought_usd ?? 0), Number(window.sold_usd ?? 0)]}
        />
      )}
      <PressureRow a={count(window.buyers)} aLabel={plural(window.buyers, "buyer")} b={count(window.sellers)} bLabel={plural(window.sellers, "seller")} share={[window.buyers, window.sellers]} />
    </div>
  );
}

const plural = (value: number, word: string) => (value === 1 ? word : `${word}s`);

/** A side's priced dollars (a + when some trades had no price), exact amounts in the inspector. */
function SideDollars({ usd, unpriced, label }: Readonly<{ usd: string | null; unpriced: number; label: string }>) {
  if (usd === null) return NO_VALUE;
  return <InspectValue label={label} value={`$${usd}${unpriced ? ` · ${unpriced} ${unpriced === 1 ? "trade had" : "trades had"} no USD price` : ""}`}>{`${short(Number(usd))}${unpriced > 0 ? "+" : ""}`}</InspectValue>;
}

function PressureRow({ a, aLabel, b, bLabel, share }: Readonly<{ a: ReactNode; aLabel: string; b: ReactNode; bLabel: string; share: readonly [number, number] }>) {
  const total = share[0] + share[1];
  return (
    <div className={styles.row}>
      <div className={styles.figures}>
        <span><b>{a}</b> <span className={styles.label}>{aLabel}</span></span>
        <span><b>{b}</b> <span className={styles.label}>{bLabel}</span></span>
      </div>
      <span className={styles.bar} aria-hidden="true" data-empty={total === 0 || undefined}>
        <span className={styles.buySide} {...dyn({ flexGrow: total === 0 ? 1 : share[0] })} />
        <span className={styles.sellSide} {...dyn({ flexGrow: total === 0 ? 1 : share[1] })} />
      </span>
    </div>
  );
}
