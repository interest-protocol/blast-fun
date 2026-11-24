import { shortAddress as shortId } from "@blast/core/lib/format.ts";
import type { ReactNode } from "react";

import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { HolderSummary } from "./HolderSummary";
import { WalletAddress } from "../activity/WalletAddress";
import { Fact, Facts } from "../coin/Facts";
import { formatQuantity } from "../coin/coin-format";
import { provenanceRecord } from "../primitives/provenance";
import { DataState, StateLine } from "../primitives/DataState";
import { DataTable, type DataTableColumn } from "../primitives/DataTable";
import type { SectionState } from "../primitives/data-state";
import primitives from "../primitives/primitives.module.css";
import styles from "./Holders.module.css";
import { holdersDisplay, type HoldersState, type HoldersView as View } from "./holders-model";
import type { HolderRow } from "#web/modules/launchpad-contract/browser-holders.ts";
import { bpsPercent } from "@blast/core/lib/bps.ts";

type Pending = "refresh" | "more" | null;

const NO_HOLDERS = 0n;
const TOP_TEN_HOLDERS = 10n;

const HOLDER_SHARE = "Share of coins held in wallets. Excludes burned coins and coins held inside on-chain objects.";

function Address({ address }: Readonly<{ address: string }>) {
  return <WalletAddress address={address} label="holder address"><code className={styles.address}>{shortId(address)}</code></WalletAddress>;
}

function SnapshotFacts({
  view,
  symbol,
  decimals,
  pending,
  moreFailed,
  showShareNote,
  onMore,
}: Readonly<{ view: View; symbol: string; decimals: number | null; pending: Pending; moreFailed: string | null; showShareNote: boolean; onMore: () => void }>) {
  const { totals } = view;
  const amount = (atoms: bigint) => formatQuantity(atoms, decimals, symbol);
  if (totals.holderCount === NO_HOLDERS) {
    return (
      <div className={styles.body}>
        <Facts label="Holder facts">
          <Fact term="Holders">0</Fact>
        </Facts>
        <StateLine kind="empty">
          No wallets hold {symbol}.
        </StateLine>
      </div>
    );
  }
  const share = (bps: bigint | null) => (bps === null ? "Unknown" : bpsPercent(bps));
  const columns: DataTableColumn<HolderRow>[] = [
    { header: "Address", cell: (row) => <Address address={row.address} /> },
    { header: "Balance", numeric: true, cell: (row) => amount(row.balance) },
    { header: "Share of wallet-held coins", numeric: true, cell: (row) => bpsPercent(row.shareBps) },
  ];
  const spans = view.rowsCheckpoint !== view.snapshot.checkpoint;
  return (
    <div className={styles.body}>
      <Facts label="Holder facts">
        <Fact term="Holders">{totals.holderCount.toLocaleString("en-US")}</Fact>
        <Fact term="Held in wallets">{amount(totals.heldSupply)}</Fact>
        <Fact term="Largest holder">
          {share(totals.top1.shareBps)} ({amount(totals.top1.amount)})
        </Fact>
        <Fact term={totals.holderCount < TOP_TEN_HOLDERS ? `Top 10 holders (all ${totals.holderCount})` : "Top 10 holders"}>
          {share(totals.top10.shareBps)} ({amount(totals.top10.amount)})
        </Fact>
      </Facts>
      {showShareNote ? <p className={styles.note}>{HOLDER_SHARE}</p> : null}
      <DataTable
        caption="Holders by balance"
        columns={columns}
        rows={view.rows}
        rowKey={(row) => row.address}
      />
      <p className={styles.note}>
        Showing {view.rows.length.toLocaleString("en-US")} of {totals.holderCount.toLocaleString("en-US")} holders.
        {spans
          ? " Some balances may have changed while you were loading more holders."
          : null}
      </p>
      {moreFailed ? (
        <p className={styles.note} role="status">More holders couldn’t load. Try again.</p>
      ) : null}
      {view.nextCursor ? (
        <button
          className={styles.button}
          type="button"
          onClick={onMore}
          disabled={pending === "more"}
          aria-busy={pending === "more" || undefined}
        >
          {pending === "more" ? <LoadingIndicator label="Loading more holders">Load more holders</LoadingIndicator> : "Load more holders"}
        </button>
      ) : null}
    </div>
  );
}

/**
 * Wallet balances and concentration, with pagination and a freshness note
 * when the latest balances are unavailable.
 */
export function HoldersView({
  state,
  symbol,
  decimals,
  pending,
  onRefresh,
  onMore,
  onShowNewer,
  compact = false,
  insideDisclosure = false,
}: Readonly<{
  state: HoldersState;
  symbol: string;
  decimals: number | null;
  pending: Pending;
  onRefresh: () => void;
  onMore: () => void;
  onShowNewer: () => void;
  compact?: boolean;
  insideDisclosure?: boolean;
}>) {
  const display = holdersDisplay(state);
  if (compact && display.kind === "facts") return <CompactHolders symbol={symbol} decimals={decimals} display={display} newer={state.newer !== null} onShowNewer={onShowNewer}><HoldersView insideDisclosure state={state} symbol={symbol} decimals={decimals} pending={pending} onRefresh={onRefresh} onMore={onMore} onShowNewer={onShowNewer} /></CompactHolders>;
  const refresh = (
    <button
      className={styles.button}
      type="button"
      onClick={onRefresh}
      disabled={pending === "refresh"}
      aria-busy={pending === "refresh" || undefined}
    >
      {pending === "refresh" ? <LoadingIndicator label="Refreshing holders">Refresh holders</LoadingIndicator> : "Refresh holders"}
    </button>
  );

  if (display.kind === "incomplete") {
    return (
      <div className={styles.holders}>
        <div className={primitives.dataState} data-state="unavailable">
          <StateLine kind="unavailable">
            Holder balances are incomplete. Use Refresh holders to try again.
          </StateLine>
        </div>
        {refresh}
      </div>
    );
  }

  const section: SectionState<View> =
    display.kind === "loading"
      ? { status: "loading" }
      : display.kind === "unavailable"
        ? { status: "unavailable", reason: display.reason }
        : display.stale && !insideDisclosure
          ? { status: "stale", value: display.view, provenance: provenanceRecord(display.view.provenance), reason: display.stale.cause }
          : { status: "ready", value: display.view, provenance: provenanceRecord(display.view.provenance) };

  return (
    <div className={styles.holders}>
      {state.newer && !insideDisclosure ? (
        <p className={styles.note} role="status">
          Newer holder balances are available.{" "}
          <button className={styles.textButton} type="button" onClick={onShowNewer}>
            Show latest
          </button>
        </p>
      ) : null}
      <DataState
        state={section}
        subject="holders"
        loading="Loading holders…"
        recovery="Use Refresh holders to try again."
      >
        {(view) => (
          <SnapshotFacts
            view={view}
            symbol={symbol}
            decimals={decimals}
            pending={pending}
            moreFailed={state.moreFailed}
            showShareNote={!insideDisclosure}
            onMore={onMore}
          />
        )}
      </DataState>
      {display.kind === "loading" ? null : refresh}
    </div>
  );
}

function CompactHolders({ display, symbol, decimals, newer, onShowNewer, children }: Readonly<{
  display: Extract<ReturnType<typeof holdersDisplay>, { kind: "facts" }>;
  symbol: string;
  decimals: number | null;
  newer: boolean;
  onShowNewer: () => void;
  children: ReactNode;
}>) {
  const { rows, totals } = display.view;
  return <>
    {newer ? <p className={styles.note} role="status">Newer holder balances are available. <Button size="sm" variant="ghost" onClick={onShowNewer}>Show latest</Button></p> : null}
    {display.stale ? <p className={styles.note} role="status">Holder balances may be out of date.</p> : null}
    {totals.holderCount === NO_HOLDERS ? <p className={styles.note}>No wallets hold this coin.</p> : null}
    <HolderSummary shareNote={HOLDER_SHARE} rows={rows.slice(0, 4).map((row) => ({
      key: row.address,
      holder: <WalletAddress address={row.address} label="holder address" />,
      balance: formatQuantity(row.balance, decimals, symbol),
      share: bpsPercent(row.shareBps),
    }))}>
      {children}
    </HolderSummary>
  </>;
}
