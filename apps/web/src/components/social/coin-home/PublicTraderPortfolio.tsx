"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { PortfolioCoin, SocialPortfolio } from "@blast/core/web/contracts/portfolio.ts";
import { ButtonLink } from "#web/components/blast-ui/Button.tsx";
import { CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { QueryRefusal } from "#web/lib/query/client.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { publicPortfolioQuery } from "../queries";
import { presaleHref } from "../feed-ui/shell-bridge-model";
import { coinFigure, pnlText, portfolioText } from "./home-model";
import styles from "./CoinHome.module.css";

function Holding({ coin }: Readonly<{ coin: PortfolioCoin }>) {
  return <div className={styles.holdingRow}>
    <div><span className="coinNamed">{coin.presale_id ? <Link className={styles.name} href={presaleHref(coin.presale_id)}>{coin.symbol}</Link> : <b className="nm">{coin.symbol}</b>}{coin.verified_team ? <CoinVerifiedMark /> : null}</span><span className={styles.holdingAmount}>{coin.decimals == null ? `${coin.balance} base units` : coinFigure(coin.balance, coin.symbol, coin.decimals, 4)}</span></div>
    <span>{portfolioText(coin.value_usd)}</span>
    <span />
    <span>{pnlText(coin.pnl_usd)?.text}</span>
  </div>;
}

function Holdings({ coins }: Readonly<{ coins: readonly PortfolioCoin[] | null }>) {
  if (coins === null) return null;
  if (coins.length === 0) return <p>No holdings.</p>;
  const sorted = [...coins].sort((a, b) => {
    if (a.value_usd === null || b.value_usd === null) return a.value_usd === b.value_usd ? a.coin_type.localeCompare(b.coin_type) : a.value_usd === null ? 1 : -1;
    return Number(b.value_usd) - Number(a.value_usd);
  });
  return <>{sorted.map((coin) => <Holding coin={coin} key={coin.coin_type} />)}</>;
}

function Commitments({ positions }: Readonly<{ positions: SocialPortfolio["positions"] }>) {
  if (positions === null) return null;
  if (positions.length === 0) return <p>No presales.</p>;
  return positions.map((position) => <div className={styles.activityRow} key={position.presale_id}><Link className={styles.name} href={presaleHref(position.presale_id)}>{position.symbol}</Link><span>{coinFigure(position.commitment, position.quote_symbol, position.quote_decimals)}</span><span>{position.status}</span></div>);
}

function Portfolio({ data }: Readonly<{ data: SocialPortfolio }>) {
  return <>
    {data.coins !== null ? <section className={`card ${styles.card}`}><h2 className={styles.previewHeading}>Holdings</h2>
      <div className={styles.holdingHead}><span>Token / amount</span><span>{data.coins.some((coin) => coin.value_usd !== null) ? "Value · USD" : null}</span><span /><span>{data.coins.some((coin) => coin.pnl_usd !== null) ? "Unrealized PnL" : null}</span></div>
      <Holdings coins={data.coins} />
    </section> : null}
    {data.balances !== null ? <section className={`card ${styles.card}`}><h2 className={styles.previewHeading}>Cash</h2><p>SUI: {coinFigure(data.balances.sui.atoms, "SUI", 9)} · USDC: {coinFigure(data.balances.usdc.atoms, "USDC", 6)}</p></section> : null}
    {data.positions !== null ? <section className={`card ${styles.card}`}><h2 className={styles.previewHeading}>Presales</h2><Commitments positions={data.positions} /></section> : null}
  </>;
}

/** A full read of the existing opt-in public portfolio; the API rechecks privacy. */
export function PublicTraderPortfolio({ callsign }: Readonly<{ callsign: string }>) {
  const query = useQuery(publicPortfolioQuery(callsign), useAppQueryClient());
  const privatePortfolio = query.error instanceof QueryRefusal && query.error.code === "portfolio_private";
  return <div className={styles.portfolio}>
    <PageHeader title={`@${callsign} · Portfolio`} actions={<ButtonLink href={`/@${callsign}`} size="sm">View profile</ButtonLink>} />
    {query.isPending ? <p role="status">Loading portfolio…</p> : null}
    {query.isError ? <p role="alert">{privatePortfolio ? "This portfolio is private." : "This portfolio couldn’t load."} <button className="btn btn-line btn-sm" type="button" onClick={() => void query.refetch()}>Retry</button></p> : null}
    {query.data && !query.isError ? <Portfolio data={query.data} /> : null}
  </div>;
}
