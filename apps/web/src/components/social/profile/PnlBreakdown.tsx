"use client";

import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { PnlCardLoading } from "./PnlCardLoading";
import clsx from "clsx";
import { lazy, Suspense, useState } from "react";
import Link from "next/link";

import type { PnlFigures, SocialPnl } from "@blast/core/web/contracts/pnl.ts";
import { presalePath } from "@blast/core/modules/social/items/do-the-same.ts";
import { Button, DisclosureButton } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import type { Loadable } from "#web/lib/query/seed.ts";
import { canCreatePnlCard, pnlFigure } from "./pnl-model";
import type { PnlCard } from "./pnl-card";
import styles from "./Profile.module.css";

const FILTERS = [["all", "All"], ["open", "Open"], ["closed", "Closed"]] as const;
const FIGURES = [["realized_usd", "Realized"], ["unrealized_usd", "Unrealized"], ["total_usd", "Total"]] as const;
type PnlRead = Loadable<SocialPnl>;
const PnlCardSheet = lazy(() => import("./PnlCardSheet"));

function PnlTileValue({ figure, loading, allowed, id }: Readonly<{
  figure: ReturnType<typeof pnlFigure>; loading: boolean; allowed: boolean; id: string;
}>) {
  if (allowed && !loading && figure.text === "Unavailable") return null;
  return <span className={styles.pnlValue} id={id}>
    <b className={figure.tone ?? undefined}>
      {!allowed ? "Private" : loading ? <SkeletonText>Amount</SkeletonText> : figure.text}
    </b>
  </span>;
}

function pnlTileRead(pnl: PnlRead) {
  switch (pnl.status) {
    case "loading":
    case "none":
      return { total: null, loading: true, empty: false };
    case "error":
      return { total: null, loading: false, empty: false };
    case "ready": {
      const value = pnl.value;
      const syncing = value.wallet_sync.status === "syncing";
      return {
        total: value.totals.total_usd,
        loading: syncing && value.totals.total_usd === null,
        empty: !syncing && !hasFigures(value.totals) && !value.assets.some(hasFigures),
      };
    }
  }
}

/**
 * The PnL since launch tile (the Profile board): the whole tile is the
 * disclosure, the label with "View details ⌄" beside it over the figure; it
 * opens the breakdown below the card.
 */
export function PnlTile({ pnl, allowed, hidden, expanded, controls, onToggle }: Readonly<{
  pnl: PnlRead; allowed: boolean; hidden: boolean; expanded: boolean; controls: string; onToggle: () => void;
}>) {
  const read = allowed ? pnlTileRead(pnl) : { total: null, loading: false, empty: false };
  const { loading } = read;
  const figure = pnlFigure(read.total, hidden, true);
  if (read.empty && !hidden) return null;
  const value = <PnlTileValue figure={figure} loading={loading} allowed={allowed} id={`${controls}-figure`} />;
  if (!allowed) return <div className={styles.pnlTile}><span className={styles.pnlHead}><span>PnL since launch</span></span>{value}</div>;
  return (
    <div className={styles.pnlTile}>
      <DisclosureButton variant="ghost"
        aria-busy={loading || undefined}
        aria-controls={controls}
        aria-describedby={loading || figure.text !== "Unavailable" ? `${controls}-figure` : undefined}
        aria-expanded={expanded}
        aria-label="View PnL breakdown since launch"
        className={styles.pnlToggle}
        onClick={onToggle}
        type="button"
      >
        <span className={styles.pnlHead}>
          <span>PnL since launch</span>
          <span className={styles.pnlAction}>{expanded ? "Hide details" : "View details"}</span>
        </span>
        {value}
      </DisclosureButton>
    </div>
  );
}

function hasFigures(figures: PnlFigures) {
  return FIGURES.some(([key]) => figures[key] !== null);
}

function Figures({ figures, hidden }: Readonly<{ figures: PnlFigures; hidden: boolean }>) {
  const available = FIGURES.filter(([key]) => hidden || figures[key] !== null);
  if (available.length === 0) return null;
  return <dl className={styles.pnlFigures}>
    {available.map(([key, label]) => {
      const figure = pnlFigure(figures[key], hidden);
      return (
        <div key={key}>
          <dt>{label}</dt>
          <dd className={figure.tone ?? undefined}>{figure.text}</dd>
        </div>
      );
    })}
  </dl>;
}

function PnlFiguresLoading() {
  return <dl aria-hidden="true" className={styles.pnlFigures}>{FIGURES.map(([key, label]) => <div key={key}><dt>{label}</dt><dd><SkeletonText>$0,000.00</SkeletonText></dd></div>)}</dl>;
}

function emptyPositions(value: SocialPnl, filter: string): string {
  if (!value.history_complete) return "Waiting for complete wallet history.";
  if (value.assets.length === 0) return "No trading PnL yet.";
  return `No ${filter} positions.`;
}

function PnlCoinRow({ asset, hidden, historyComplete, onCreate }: Readonly<{
  asset: SocialPnl["assets"][number]; hidden: boolean; historyComplete: boolean;
  onCreate?: (asset: SocialPnl["assets"][number]) => void;
}>) {
  const status = !historyComplete ? "Updating" : asset.tracked_balance === "0" ? "Closed" : "Open";
  return <li>
    <div className={styles.pnlCoin}>
      <Link href={asset.launch_id ? coinPagePath(asset.coin_type ?? asset.launch_id) : presalePath(asset.presale_id!)}>{asset.symbol}</Link>
      <span className="status">{status}</span>
    </div>
    <Figures figures={asset} hidden={hidden} />
    {onCreate ? <Button aria-haspopup="dialog" aria-label={`Create PnL card for ${asset.symbol}`} className={styles.pnlCoinCardAction} disabled={!historyComplete || !canCreatePnlCard(asset)} onClick={() => onCreate(asset)} size="sm" variant="ghost">Create card</Button> : null}
  </li>;
}

export function PnlBreakdown({ pnl, hidden, retry, ownerCallsign }: Readonly<{ pnl: PnlRead; hidden: boolean; retry?: () => void; ownerCallsign?: string }>) {
  if (pnl.status === "loading" || pnl.status === "none") {
    return <section aria-busy="true" aria-label="Loading PnL since launch" className={clsx("card", styles.pnlCard)} role="status">
      <span className="sr">Loading PnL since launch…</span>
      <div aria-hidden="true" className={styles.pnlHeading}><h3>PnL since launch</h3><span>Blast-launched coins</span></div>
      <PnlFiguresLoading />
      <div aria-hidden="true"><Segmented disabled label="PnL positions" onChange={() => undefined} options={FILTERS} value="all" /></div>
      <ul aria-hidden="true" className={styles.pnlAssets}>{[0, 1, 2].map(row => <li key={row}><div className={styles.pnlCoin}><SkeletonText>COIN</SkeletonText></div><PnlFiguresLoading /></li>)}</ul>
    </section>;
  }
  if (pnl.status === "error") {
    return (
      <EmptyState action={retry ? <Button onClick={retry}>Try again</Button> : null} framed role="alert" title="PnL could not load">
        {pnl.message ?? "Try again in a moment."}
      </EmptyState>
    );
  }
  return <PnlBreakdownReady hidden={hidden} ownerCallsign={ownerCallsign} value={pnl.value} />;
}

function PnlBreakdownReady({ value, hidden, ownerCallsign }: Readonly<{ value: SocialPnl; hidden: boolean; ownerCallsign?: string }>) {
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>("all");
  const [card, setCard] = useState<PnlCard | null>(null);
  const matchingAssets = value.assets.filter((asset) => filter === "all" || (filter === "closed" ? asset.tracked_balance === "0" : asset.tracked_balance !== "0"));
  const assets = matchingAssets.filter((asset) => hidden || hasFigures(asset));
  const canCreate = ownerCallsign && !hidden;
  function createCard(asset?: SocialPnl["assets"][number]) {
    if (!ownerCallsign || hidden || !value.history_complete || !canCreatePnlCard(asset ?? value.totals)) return;
    setCard({ callsign: ownerCallsign, figures: asset ?? value.totals, asset });
  }
  const onCreate = canCreate ? createCard : undefined;
  if (!hidden && !hasFigures(value.totals) && !value.assets.some(hasFigures)) {
    if (value.wallet_sync.status !== "syncing") return null;
    return <section aria-busy="true" aria-label="Syncing PnL since launch" className={clsx("card", styles.pnlCard)} role="status"><span className="sr">Syncing wallet history…</span><PnlFiguresLoading /></section>;
  }
  return <section aria-label="PnL since launch" className={clsx("card", styles.pnlCard)}>
    <div className={styles.pnlHeading}>
      <h3>PnL since launch</h3>
      <span>Blast-launched coins</span>
      {canCreate ? <Button aria-haspopup="dialog" disabled={!value.history_complete || !canCreatePnlCard(value.totals)} onClick={() => createCard()} size="sm">Create PnL card</Button> : null}
    </div>
    <Figures figures={value.totals} hidden={hidden} />
    {value.wallet_sync.status === "syncing" ? <p className={styles.pnlNote} role="status">Syncing wallet history…</p> : null}
    <Segmented label="PnL positions" onChange={setFilter} options={FILTERS} value={filter} />
    {assets.length > 0 ? <ul className={styles.pnlAssets}>
      {assets.map((asset) => <PnlCoinRow asset={asset} hidden={hidden} historyComplete={value.history_complete} key={asset.coin_type} onCreate={onCreate} />)}
    </ul> : null}
    {matchingAssets.length === 0 ? <p className={styles.pnlNote}>{emptyPositions(value, filter)}</p> : null}
    {canCreate && card ? <Suspense fallback={<PnlCardLoading onClose={() => setCard(null)} />}><PnlCardSheet card={card} onClose={() => setCard(null)} /></Suspense> : null}
  </section>;
}
