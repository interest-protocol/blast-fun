"use client";
import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { Button, IconButton } from "#web/components/blast-ui/Button.tsx";
import { workspaceScrollOwner } from "./scroll-owner";

import { addDiscoveryAsset, assetOnScreen, canonicalCoinType, fundedShare } from "./coin-row-model";
import { Fragment, useEffectEvent, useId, useLayoutEffect, useRef, type ReactNode } from "react";
import { NOT_OPEN_YET, opensAt, timeUntil, utc, ago } from "@blast/core/web/format.ts";
import { exactAtoms, groupedExact } from "@blast/core/web/exact-amount.ts";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { IntentLink } from "#web/components/blast-ui/NavigationLink.tsx";
import { presalePath } from "@blast/core/modules/social/items/do-the-same.ts";
import { Sparkline } from "#web/components/charts/Sparkline.tsx";
import type {
  HomeActivity,
  HomeCoin,
} from "@blast/core/web/contracts/home.ts";
import {
  marketFacts,
  volumeLabel,
  volumeText,
  raiseFigures,
} from "../../coin-home/home-model";
import { QuoteMark } from "../../coin-home/glyphs";
import { saleLifecycleAt } from "@blast/core/web/contracts/presales.ts";
import { CoinParticipants } from "./CoinParticipants";
import { ProgressRing } from "./panels/Figures";
import { useWorkspace } from "./workspace-context";
import { SORT_LABELS, SOURCE_LABELS } from "../../coin-home/home-state";
import styles from "./CoinsData.module.css";

/**
 * The row's action: add the asset's panel, or a check (still pressable, to show it) once it is on screen.
 * With `row`, the whole row head is the control instead of an icon.
 */
export function PanelAddButton({
  symbol,
  open,
  disabled,
  onAdd,
  row = false,
  describedBy,
}: Readonly<{ symbol: string; open: boolean; disabled?: boolean; onAdd: () => void; row?: boolean; describedBy?: string }>) {
  const { snapshot } = useWorkspace();
  let label = `Replace a panel with ${symbol}`;
  if (snapshot.presentation === "focus") label = `Open ${symbol} in Focus`;
  else if (open) label = `Show ${symbol} in Compare`;
  else if (snapshot.desktop_slots!.includes(null)) label = `Add ${symbol} to Compare`;
  const Control = row ? Button : IconButton;
  return (
    <Control variant="ghost" size="sm"
      aria-current={row && open ? "true" : undefined}
      aria-describedby={describedBy}
      aria-label={label}
      className={row ? styles.toggle : styles.add}
      data-open={row ? undefined : open}
      disabled={disabled}
      onClick={onAdd}
      title={row ? undefined : label}
      type="button"
    >
      {row ? null : <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth={open ? 2.2 : 2} viewBox="0 0 24 24">
        <path d={open ? "m5 12 5 5 9-10" : "M12 5v14M5 12h14"} />
      </svg>}
    </Control>
  );
}

/** A list's refresh as a small icon button, disabled while its read is in flight. */
export function RefreshButton({ label, title, busy, onRefresh }: Readonly<{ label: string; title: string; busy: boolean; onRefresh: () => void }>) {
  return (
    <IconButton variant="ghost" size="sm" aria-label={label} className={styles.iconButton} disabled={busy} onClick={onRefresh} title={title} type="button">
      <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" viewBox="0 0 24 24">
        <path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4" />
      </svg>
    </IconButton>
  );
}

/** A coin or sale's own page; following it leaves Blast mode, and B returns to it exactly. */
export function CoinPageLink({
  presaleId,
  launchId,
  coinType,
  symbol,
  className,
  children,
}: Readonly<{ presaleId: string | null; launchId?: string; coinType?: string; symbol: string; className: string; children: ReactNode }>) {
  return (
    <IntentLink
      aria-label={`Open ${symbol} page`}
      className={className}
      href={launchId ? coinPagePath(coinType ?? launchId) : presalePath(presaleId!)}
      title={`Open ${symbol} page (B returns to Blast mode)`}
    >
      {children}
    </IntentLink>
  );
}

/** A row head that discloses its details: the whole head is the control, under its content. */
export function RowToggle({
  label,
  expanded,
  controls,
  describedBy,
  onToggle,
}: Readonly<{ label: string; expanded: boolean; controls: string; describedBy?: string; onToggle: () => void }>) {
  return (
    <Button variant="ghost" size="sm"
      aria-controls={controls}
      aria-describedby={describedBy}
      aria-expanded={expanded}
      aria-label={label}
      className={styles.toggle}
      onClick={onToggle}
      type="button"
    />
  );
}

export function CoinsRows({
  coins,
  nowMs,
  view = "Coins",
  followed,
  insert,
}: Readonly<{
  coins: readonly HomeCoin[];
  nowMs: number;
  view?: "Coins" | "Presales";
  followed?: Readonly<Record<string, HomeActivity>>;
  /** Other rows placed before the coin at `at` (after the last when `at` is the count). */
  insert?: Readonly<{ at: number; rows: ReactNode }>;
}>) {
  const { dispatch, snapshot } = useWorkspace();
  const controls = snapshot.data.controls[view];
  const id = useId();
  const list = useRef<HTMLOListElement>(null);
  const rowOrder = JSON.stringify(coins.map((coin) => coin.coin_type));
  const restoreOrderScroll = useEffectEvent(() => {
    const localBody = list.current?.closest<HTMLElement>("#workspace-data-panel");
    const body = localBody ? workspaceScrollOwner(localBody) : null;
    if (!body) return;
    const rows = [
      ...list.current!.querySelectorAll<HTMLElement>("[data-workspace-row]"),
    ];
    const anchor = controls.navigation.anchor;
    const exact =
      anchor &&
      rows.find((row) => row.dataset.workspaceRow === anchor.coin_type);
    const row =
      exact || (anchor && rows[Math.min(anchor.index, rows.length - 1)]);
    if (row && anchor) {
      body.scrollTop +=
        row.getBoundingClientRect().top -
        body.getBoundingClientRect().top -
        anchor.offset;
      if (!exact)
        dispatch.patchDataControls(view, {
          ...controls,
          navigation: {
            ...controls.navigation,
            anchor: {
              ...anchor,
              coin_type: row.dataset.workspaceRow!,
              index: rows.indexOf(row),
            },
          },
        });
    } else body.scrollTop = controls.navigation.scroll_top;
  });
  useLayoutEffect(() => {
    // Focus and price updates must not replay a position awaiting its scroll event.
    restoreOrderScroll();
  }, [rowOrder, view]);
  return (
    <ol
      aria-label={
        view === "Presales"
          ? "Open and upcoming presales"
          : `${SOURCE_LABELS[snapshot.data.controls.Coins.source]} coins${snapshot.data.controls.Coins.source === "discover" ? `, ${SORT_LABELS[snapshot.data.controls.Coins.sort]}` : ""}`
      }
      className={styles.list}
      ref={list}
    >
      {coins.map((coin, index) => (
        <Fragment key={coin.coin_type}>
          {index === insert?.at && insert.rows}
          <CoinRow
            coin={coin}
            nowMs={nowMs}
            view={view}
            followed={coin.presale_id ? followed?.[coin.presale_id] : undefined}
            listId={id}
            shared={coins.some((other) => other !== coin && other.symbol === coin.symbol)}
          />
        </Fragment>
      ))}
      {insert?.at === coins.length && insert.rows}
    </ol>
  );
}

function CoinRow({
  coin,
  nowMs,
  view,
  followed,
  listId,
  shared = false,
}: Readonly<{
  coin: HomeCoin;
  nowMs: number;
  view: "Coins" | "Presales";
  followed?: HomeActivity;
  listId: string;
  /** Another row has this symbol: line two names the venue and the contract (audit 08). */
  shared?: boolean;
}>) {
  const { dispatch, snapshot } = useWorkspace();
  const canonical = canonicalCoinType(coin.coin_type);
  const coinKey = canonical ?? coin.coin_type;
  const aboutId = `${listId}-${coinKey}-about`;
  const open = assetOnScreen(snapshot, canonical);
  const facts = marketFacts(coin, nowMs);
  const stale = coin.price_as_of_ms !== null && nowMs - coin.price_as_of_ms > 120_000;
  const about = rowAbout(coin, view, nowMs, stale);
  return (
    <li
      className={styles.row}
      data-on-screen={open}
      data-view={view}
      data-workspace-row={canonical ?? undefined}
      title={about}
    >
      {/* The whole head opens the coin in the middle; everything about it is there, so the row has no details of its own. A coin with no canonical type opens nothing, so its row is plain. */}
      <div
        className={styles.head}
        data-cols={view === "Presales" ? "sale" : "coin"}
        data-disclosure={canonical !== null || undefined}
      >
        {canonical !== null && (
          <PanelAddButton
            describedBy={aboutId}
            onAdd={() => addDiscoveryAsset(dispatch, coin)}
            open={open}
            row
            symbol={coin.symbol}
          />
        )}
        <span className={styles.tile}>
          <CoinMark
            coin={{ key: coinKey, coinType: coinKey, symbol: coin.symbol, iconUrl: coin.icon_url, round: false }}
            size={34}
          />
        </span>
        <span className={styles.text}>
          <span className={styles.t1}>
            <strong>{coin.symbol}</strong>
            {coin.verified_team ? <CoinVerifiedMark size="sm" /> : null}
            {stale && <span aria-hidden="true" className={styles.staleMark}>·</span>}
          </span>
          <RowPeople coin={coin} followed={followed} nowMs={nowMs} shared={shared} />
          <span className={styles.visuallyHidden} id={aboutId}>{about}</span>
        </span>
        {view === "Presales" ? <SaleRing coin={coin} /> : <CoinSpark coin={coin} />}
        {view === "Presales" ? <SaleRaise coin={coin} /> : <CoinPrice coin={coin} facts={facts} />}
        <CoinParticipants symbol={coin.symbol} activity={followed ?? coin.activity} sale={isSale(coin)} className={styles.participants} />
      </div>
    </li>
  );
}

/** Whether the row is still a sale (not yet trading on its venue). */
function isSale(coin: HomeCoin): boolean {
  return coin.lifecycle !== "migrated" && coin.sale !== null;
}

/** The short muted count beside the faces: people you follow, buyers, backers, or how funded a sale is. */
function peopleCount(coin: HomeCoin, followed: HomeActivity | undefined, nowMs: number): string | null {
  if (followed) return `${followed.participants} you follow`;
  if (!isSale(coin)) return coin.activity.buyers > 0 ? `${coin.activity.buyers} bought` : null;
  if (coin.activity.backers > 0) return `${coin.activity.backers} backed`;
  if (coin.lifecycle === "cancelled") return "Cancelled";
  if (saleLifecycleAt(coin.lifecycle, coin.sale?.start_ms, nowMs) === "pending") return NOT_OPEN_YET;
  const share = fundedShare(coin.sale!);
  return share ? `${share.text} funded` : null;
}

/**
 * Line two: the venue's mark and the window's volume (FDV when no volume is priced), or presale
 * participation. A symbol shared with another row (three RHRSL markets, audit 08) names its
 * venue and shows its contract instead, so the rows read apart.
 */
function RowPeople({ coin, followed, nowMs, shared = false }: Readonly<{ coin: HomeCoin; followed?: HomeActivity; nowMs: number; shared?: boolean }>) {
  const sale = isSale(coin);
  const count = peopleCount(coin, followed, nowMs);
  const [address] = coin.coin_type.split("::");
  return (
    <span className={styles.t2}>
      {sale ? (
        <span className={styles.mark}><QuoteMark symbol={coin.quote.symbol} /></span>
      ) : coin.venue ? (
        <span className={`${styles.mark} ${styles.venueMark}`} data-named={shared || undefined}><DexIdentity iconOnly={!shared} venue={coin.venue} /></span>
      ) : null}
      {shared && address ? <span className={`${styles.rowIdentity} ${styles.rowContract}`}><InspectValue label={`full ${coin.symbol} coin type`} value={coin.coin_type}>{`${address.slice(0, 6)}…${address.slice(-4)}`}</InspectValue></span> : null}
      {!sale && !shared && <RowMarket coin={coin} />}
      {(sale || followed) && count !== null && <span className={styles.count}>{count}</span>}
    </span>
  );
}

/** A trading coin's market size on its row: volume when the indexer priced it, else FDV, else a plain word for the gap. */
function RowMarket({ coin }: Readonly<{ coin: HomeCoin }>) {
  const volume = volumeText(coin.activity);
  // A venue mark alone is not a state (live audit F30): an empty window says so, and an unpriced one says that.
  if (volume === "$0") return <span className={styles.rowIdentity}>No trades</span>;
  if (volume !== null)
    return <span className={styles.rowIdentity}>
      <span aria-hidden="true">{volume} vol</span>
      <span className="sr-only">{volumeLabel(coin.activity.window, volume, coin.activity.scope)}</span>
    </span>;
  if (coin.fdv_usd === null) return <span className={styles.rowIdentity}>No price yet</span>;
  return <span className={styles.rowIdentity}><InspectValue label="FDV in USD" value={coin.fdv_usd}>{`${marketFacts(coin, 0).fdv} FDV`}</InspectValue></span>;
}

/** What the row no longer prints: the sale's state (Presales), a stale price, and why the coin is listed, as its title and accessible description. */
function rowAbout(coin: HomeCoin, view: "Coins" | "Presales", nowMs: number, stale: boolean): string {
  const state = view === "Presales" ? saleStateText(coin, nowMs) : null;
  const price = stale ? `Stale price · observed ${ago(coin.price_as_of_ms!, nowMs)} ago` : null;
  return [state, price, coin.rank.why].filter(Boolean).join(" · ");
}

function saleStateText(coin: HomeCoin, nowMs: number): string | null {
  const sale = coin.sale;
  if (!sale) return null;
  const lifecycle = saleLifecycleAt(coin.lifecycle, sale.start_ms, nowMs);
  if (lifecycle === "open" && sale.end_ms > nowMs)
    return `Live · closes in ${timeUntil(sale.end_ms, nowMs).replace(/\s*\d+s$/, "") || "<1m"}`;
  if (lifecycle === "pending") {
    const start = opensAt(sale.start_ms);
    return start === null ? NOT_OPEN_YET : `Opens ${utc(start)}`;
  }
  if (lifecycle === "funded") return "Filled · launching";
  if (lifecycle === "migrated") return "Filled · trading";
  return lifecycle === "cancelled" ? "Cancelled" : "Ended";
}

/** The 24 h line, drawn only from at least two observed prices; coloured by the 24 h move when there is one. */
function CoinSpark({ coin }: Readonly<{ coin: HomeCoin }>) {
  const points = coin.spark.map(([at, usd]) => [at, Number(usd)] as const);
  return (
    <Sparkline
      className={styles.spark}
      height={18}
      ink={coin.change_24h_bps === 0}
      points={points}
      slot="workspace-coin-sparkline"
      up={coin.change_24h_bps === null ? undefined : coin.change_24h_bps > 0}
      width={44}
    />
  );
}

function CoinPrice({ coin, facts }: Readonly<{ coin: HomeCoin; facts: ReturnType<typeof marketFacts> }>) {
  const bps = coin.change_24h_bps;
  return (
    <span className={styles.figs}>
      {coin.price_usd !== null && <span className={styles.figTop}>
        <InspectValue label="price in USD" value={coin.price_usd}>
          {facts.price}
        </InspectValue>
      </span>}
      {facts.change && bps !== null ? (
        <span className={styles.figSub} data-direction={bps > 0 ? "up" : bps < 0 ? "down" : "flat"}>
          <InspectValue label="24 hour change in basis points" value={String(bps)}>
            {facts.change.text}
          </InspectValue>
        </span>
      ) : coin.lifecycle !== "migrated" ? (
        <span className={styles.figSub}>Presale</span>
      ) : null}
    </span>
  );
}

/** A sale's state in plain words: live until a time, opening at one, or filled and where it trades. */
function SaleRing({ coin }: Readonly<{ coin: HomeCoin }>) {
  const share = coin.sale ? fundedShare(coin.sale) : null;
  return (
    <span className={styles.ring}>
      <ProgressRing
        label={share ? `${share.text} funded` : "Funding unavailable"}
        ratio={share?.ratio ?? null}
        size={26}
        stroke={3.5}
      />
    </span>
  );
}

function SaleRaise({ coin }: Readonly<{ coin: HomeCoin }>) {
  const sale = raiseFigures(coin);
  if (!coin.sale) return <span className={styles.figs} />;
  // The compact figure floors while a sale fills; a nonzero raise never reads as zero.
  const raised =
    sale.raised !== null && /^\$?0(?:\s|$)/.test(sale.raised) && coin.sale.raised !== "0"
      ? sale.raised.startsWith("$") ? "<$1" : `<1 ${coin.quote.symbol}`
      : sale.raised;
  const exactAmount = (atoms: string) => {
    const amount = exactAtoms(atoms, coin.quote.decimals);
    return amount === null ? "Unavailable" : `${groupedExact(amount, amount.scale)} ${coin.quote.symbol}`;
  };
  return (
    <span className={styles.figs}>
      <span className={styles.figTop}>
        <span className={styles.mark}><QuoteMark symbol={coin.quote.symbol} /></span>
        <InspectValue
          label="Presale funding"
          value={`Raised ${exactAmount(coin.sale.raised)}. Target ${exactAmount(coin.sale.raise_target)}.`}
        >
          {raised ?? "—"}
        </InspectValue>
      </span>
      <span className={styles.figSub}>of {sale.target ?? "an unknown target"}</span>
    </span>
  );
}
