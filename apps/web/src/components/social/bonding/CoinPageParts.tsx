"use client";

import { useId, useState, type ReactNode } from "react";
import { HIDDEN_AMOUNT } from "@blast/core/web/format.ts";
import { CoinTypeTag } from "#web/components/blast-ui/CoinTypeTag.tsx";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { LiveFigureCue } from "#web/components/blast-ui/LiveFigureCue.tsx";
import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import { usePhoneLayout, useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { SectionBoundary } from "#web/components/launchpad/primitives/SectionBoundary.tsx";
import { useCoinPriceCurrency } from "#web/components/launchpad/chart/CoinPriceCurrency.tsx";
import { readablePrice, readableUsd } from "#web/lib/market-format.ts";
import styles from "./bonding-coin.module.css";

export function CoinCover({ cover }: Readonly<{ cover: Readonly<{ url: string; width: number; height: number }> }>) {
  const [failed, setFailed] = useState<string | null>(null);
  if (failed === cover.url) return null;
  return <div className={styles.aboutCover} data-coin-cover="" aria-hidden="true">
    {/* Uploaded covers are sanitized WebP files. */}
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img alt="" src={cover.url} referrerPolicy="no-referrer" width={cover.width} height={cover.height} loading="lazy" decoding="async" onError={() => setFailed(cover.url)} />
  </div>;
}

export function CoinIdentityHeader({ coin, name, symbol, status, graduated, mark, actions, children }: Readonly<{
  coin: Parameters<typeof CoinMark>[0]["coin"];
  name: string | null;
  symbol: string | null;
  status: string;
  graduated: boolean;
  mark?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
}>) {
  const tickerOnly = symbol && (!name || name.trim().toLowerCase() === symbol.trim().toLowerCase());
  return (
    <div className={styles.identity} data-coin-identity="">
      <span className={styles.heroMark}><CoinMark coin={coin} size={55} /></span>
      <PageHeader
        title={<span className={styles.coinName}>
          <span>{tickerOnly ? `$${symbol}` : name}</span>
          <small className="coinNamed">
            {symbol && !tickerOnly ? <span className="ticker">${symbol}</span> : null}
            {mark}
          </small>
        </span>}
        sub={<span className={styles.byline}>
          {status ? <span className="status" data-tone={graduated ? "live" : "upcoming"}>{status}</span> : null}
          {children}
          <CoinTypeTag coinType={coin.coinType} />
        </span>}
      />
      {actions ? <div className={styles.identityActions}>{actions}</div> : null}
    </div>
  );
}

export function CoinPriceFigure({ price, tradeId, quoteSymbol, quoteMark }: Readonly<{
  price: string; tradeId: string | null; quoteSymbol?: string; quoteMark?: ReactNode;
}>) {
  const { amountsHidden } = useShellPrefs();
  if (amountsHidden) return <>{HIDDEN_AMOUNT}</>;
  const formatted = readablePrice(price);
  return <span className={styles.priceFigure}>
    <LiveFigureCue tradeId={tradeId} value={price}>
      {quoteSymbol ? <span className={styles.amount}>{formatted}{quoteMark ?? <span>{quoteSymbol}</span>}</span> : `$${formatted}`}
    </LiveFigureCue>
  </span>;
}

/** The last confirmed price, kept while the live price waits for a newer checkpoint. */
export function useLastPrice(price: string | null | undefined): string | null {
  const [last, setLast] = useState(price ?? null);
  if (price != null && price !== last) setLast(price);
  return price ?? last;
}

function PriceSlot({ price, reserve }: Readonly<{ price: ReactNode; reserve?: ReactNode }>) {
  if (reserve == null) return <strong>{price}</strong>;
  return <div className={styles.priceHold}><strong>{price}</strong><strong aria-hidden="true">{reserve}</strong></div>;
}

/**
 * `reserve` is the last confirmed figure. While `price` waits with "—", the
 * row keeps that figure's space, unseen, so the content below does not move.
 */
export function MarketPriceRow({ price, reserve, priceLabel = "Price", change, activity, showCurrency = true }: Readonly<{
  price: ReactNode; reserve?: ReactNode; priceLabel?: string; change?: Readonly<{ value: ReactNode; direction?: "up" | "down" }> | null;
  activity?: ReactNode; showCurrency?: boolean;
}>) {
  const { amountsHidden } = useShellPrefs();
  const displayCurrency = useCoinPriceCurrency();
  const currency = showCurrency ? displayCurrency : null;
  const hasPrice = price != null;
  const held = reserve == null ? undefined : true;
  if (!hasPrice && !currency && !activity) return null;
  return <div className={styles.marketPriceRow}>
    {hasPrice || activity ? <div className={styles.marketPrice}>
      {hasPrice && <><span>{priceLabel}</span><PriceSlot price={price} reserve={reserve} /></>}
      {hasPrice && change && !amountsHidden && <span className={styles.priceChange} data-direction={change.direction}
        data-held={held} aria-hidden={held}>{change.value}</span>}
      {activity}
    </div> : null}
    {currency && <div className={styles.priceControls}>
      <Segmented
        label="Price currency" size="sm"
        options={[["usd", "USD"], ["quote", currency.quoteSymbol]]}
        value={currency.currency} onChange={currency.setCurrency}
        optionDisabled={(choice) => choice === "usd" && currency.rate === null}
      />
    </div>}
  </div>;
}

export function Fact({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return <div><dt>{label}</dt><dd>{children}</dd></div>;
}

export function MarketOverview({
  fdv, fdvFigure, holders, holdersFigure, volume, volumeFigure, venue, tradeId = null,
}: Readonly<{
  fdv?: string | null; fdvFigure?: ReactNode;
  holders?: number | null; holdersFigure?: ReactNode;
  volume?: string | null; volumeFigure?: ReactNode;
  venue?: string | null; tradeId?: string | null;
}>) {
  const fdvLabel = fdv == null ? null : readableUsd(fdv);
  const fdvValue = fdvLabel === null ? fdvFigure : <LiveFigureCue tradeId={tradeId} value={fdvLabel}>{fdvFigure ?? fdvLabel}</LiveFigureCue>;
  const holdersValue = holders == null ? holdersFigure : holders.toLocaleString("en-US");
  const volumeValue = volumeFigure ?? (volume == null ? null : readableUsd(volume));
  if (fdvValue == null && holdersValue == null && volumeValue == null && !venue) return null;
  return <section className={`${styles.card} ${styles.marketStats}`} aria-label="Market overview">
    <dl className={styles.stats}>
      {fdvValue == null ? null : <Fact label="FDV">{fdvValue}</Fact>}
      {holdersValue == null ? null : <Fact label="Holders">{holdersValue}</Fact>}
      {volumeValue == null ? null : <Fact label="Volume 24h">{volumeValue}</Fact>}
      {venue ? <Fact label="DEX"><DexIdentity venue={venue} iconOnly size={18} /></Fact> : null}
    </dl>
  </section>;
}

export function ChartCard({ children }: Readonly<{ children: ReactNode }>) {
  return <section className={`${styles.card} ${styles.marketChart}`} aria-label="Price chart">{children}</section>;
}

type ActivityTab = "trades" | "holders" | "posts";
const ACTIVITY_TABS = [["trades", "Trades"], ["holders", "Holders"], ["posts", "Posts"]] as const;

/** `lazy` mounts each tab when first shown; `lazyHolders` defers only Holders (the live screen keeps trades streaming). */
export function CoinTradingActivity({ trades, holders, posts, lazy = false, lazyHolders = false }: Readonly<{
  trades: ReactNode; holders: ReactNode; posts?: ReactNode; lazy?: boolean; lazyHolders?: boolean;
}>) {
  const phone = usePhoneLayout();
  const [tab, setTab] = useState<ActivityTab>("trades");
  const id = useId();
  const panels = { trades, holders, posts };
  const tabs = posts == null ? ACTIVITY_TABS.slice(0, 2) : ACTIVITY_TABS;
  return <section className={styles.card} aria-label="Trading activity">
    <Segmented label="Trading activity" options={tabs} value={tab} onChange={setTab} stretch={phone} tabs tabId={(key) => `${id}-${key}`} panelId={(key) => `${id}-${key}-panel`} />
    {tabs.map(([key]) => <div className={styles.activityPanel} key={key} hidden={tab !== key} id={`${id}-${key}-panel`} role="tabpanel" aria-labelledby={`${id}-${key}`}>
      {(tab === key || !(lazy || (lazyHolders && key === "holders"))) && <SectionBoundary subject={key}>{panels[key]}</SectionBoundary>}
    </div>)}
  </section>;
}
