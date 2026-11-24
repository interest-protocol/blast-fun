"use client";

import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";
import { useId, useRef } from "react";

import { Sheet, SheetClose } from "#web/components/blast-ui/Sheet.tsx";
import { fillPct, qm, quoteOf, readsInCoin, timeLeft, usdc } from "@blast/core/web/format.ts";
import { coinCount, wholeCount } from "#web/components/blast-ui/tween-num.ts";
import { CoinTweenNum, TweenNum } from "#web/components/blast-ui/use-tween-num.tsx";
import { ProgressBar } from "#web/components/blast-ui/ProgressBar.tsx";
import { ArtworkMark } from "#web/components/blast-ui/ArtworkMark.tsx";
import { sheetBarStage } from "@blast/core/modules/presale/presentation.ts";
import type { CommitBlocker } from "@blast/core/web/contracts/commit.ts";
import type { PresalePhase } from "@blast/core/web/contracts/presales.ts";
import type { CommitPayCoin, CommitSale, CommitViewer } from "@blast/core/modules/social/commit/quote.ts";

import type { WalletCoinView } from "../coins/coin-model";
import { CommitReceipt } from "./CommitReceipt";
import type { ContributionReceipt } from "./commit-receipt";
import { CommitPanel, type CommitPanelProps } from "./CommitPanel";
import { commitDialogLabel, decimal, saleDialogLine, saleFacts, saleFooterLinkStyle, type CommitSaleRead } from "./commit-view";
import styles from "./commit.module.css";

/**
 * The commit dialog and the sale dialog (FEATURE-MAP §11; OA-7: "Blast"
 * opens a dialog, which supersedes T-028's inline panel and AC-091).
 *
 * Both are the shared `Sheet`, so both get the design's own motion, the focus
 * trap, the labelled close, Escape, the scrim press, the return of focus to
 * the opener and the reduced-motion rule from one place. The gate's own dialog
 * has **no focus trap** — measured: Tab leaves the sheet after seven stops and
 * walks the page behind it — so this is stricter than the reference on
 * purpose, as the Definition of Done requires.
 *
 * The accessible name is the gate's exact string ("Blast into Meridian"),
 * carried by a visually hidden element rather than `aria-label`, so the name a
 * screen reader hears is text that exists in the document.
 */

const PHASE_LABEL: Readonly<Record<PresalePhase, string>> = {
  pending: "Upcoming",
  open: "Open",
  closed: "Closed",
  funded: "Funded",
  trading: "Trading",
  cancelled: "Cancelled",
};

function Chevron() {
  return (
    <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" viewBox="0 0 24 24">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

/** The head: the mark, the name, the symbol, the stage chip and the countdown. */
function SaleHead({ detail, nowMs }: Readonly<{ detail: CommitSaleRead; nowMs: number }>) {
  const sale = detail.presale;
  return (
    <div className={styles.mhead}>
      <ArtworkMark coinType={sale.coin_type} src={sale.icon_url} fallbackId={sale.presale_id} />
      <span className={styles.t}>
        <b>{sale.name}</b>
        <span>
          {sale.symbol}
          <span className="status" data-tone={sale.phase === "pending" ? "upcoming" : sale.phase}>
            {PHASE_LABEL[sale.phase]}
          </span>
          {sale.phase === "open" ? <span className={styles.when}>closes in {timeLeft(Math.max(0, sale.end_ms - nowMs))}</span> : null}
        </span>
      </span>
    </div>
  );
}

/** The raise panel. Not drawn for a sale that has not opened, as §11 has it. */
function SaleRaise({ detail, followed }: Readonly<{ detail: CommitSaleRead; followed: number }>) {
  const sale = detail.presale;
  if (sale.phase === "pending") return null;
  // R3-40: the raise in the sale's own coin (the gate's `qm`): `$184,221 of $250,000`, `99,970 SUI of 100,000 SUI`.
  const quote = quoteOf(sale);
  const raised = qm(quote, { usd: sale.raised_usd, atoms: sale.raised_atoms });
  const target = qm(quote, { usd: sale.target_usd, atoms: sale.target_atoms });
  // OA-28 M3: the raise counts to each new figure (the gate's `paintRaise`), in dollars or in the sale's coin.
  const raisedUsd = decimal(sale.raised_usd);
  const count = readsInCoin(quote) ? coinCount(quote, sale.raised_atoms) : null;
  const raisedNum =
    raised === null ? "—" : count !== null ? <CoinTweenNum count={count} /> : !readsInCoin(quote) && raisedUsd !== null ? <TweenNum format={usdc} value={raisedUsd} /> : raised;
  // The gate's `fillPct`: floored below 100, so 99.7% never reads as full (and 73.7% reads 73%, as the sale page does).
  const pct = fillPct(sale.fill_bps);
  return (
    <div className={styles.mraise}>
      <div className={styles.raiseRow}>
        <b>{raisedNum}</b>
        <span>of {target ?? "its target"}</span>
      </div>
      <ProgressBar pct={Math.min(100, pct)} stage={sheetBarStage(sale.phase)} />
      <div className={styles.legend}>
        <span>
          <TweenNum format={wholeCount} value={sale.participants} /> backers{followed > 0 ? ` · ${followed} you follow` : ""}
        </span>
        <span>{pct}% of target</span>
      </div>
    </div>
  );
}

function SaleFacts({ detail }: Readonly<{ detail: CommitSaleRead }>) {
  return (
    <div className={styles.facts}>
      {saleFacts(detail).map((fact) => (
        <div key={fact.label}>
          <span>{fact.label}</span>
          <b>{fact.value}</b>
          {fact.note ? <small>{fact.note}</small> : null}
        </div>
      ))}
    </div>
  );
}

export type CommitDialogProps = Readonly<{
  open: boolean;
  receipt?: ContributionReceipt | null;
  onRequestClose: () => void;
  onClosed?: () => void;
  onRequestOpen?: () => void;
  detail: CommitSaleRead;
  sale: CommitSale;
  viewer: CommitViewer;
  walletCoins?: readonly WalletCoinView[];
  walletCoinsState?: CommitPanelProps["walletCoinsState"];
  walletFee?: "wallet" | "sponsored";
  walletAddress?: string | null;
  blockers: readonly CommitBlocker[];
  nowMs: number;
  /** Named accounts the viewer follows who backed it, for the raise legend. */
  followed?: number;
  /** "Through <name>'s post", when the dialog was opened from someone else's item. */
  through?: Readonly<{ name: string; avatar: React.ReactNode }> | null;
  onBlast: CommitPanelProps["onBlast"];
  onDeposit: (coin: CommitPayCoin) => void;
  primaryExtra?: Readonly<Record<string, unknown>>;
}>;

export function CommitDialog({
  open,
  receipt = null,
  onRequestClose,
  onClosed,
  onRequestOpen,
  detail,
  sale,
  viewer,
  walletCoins,
  walletCoinsState,
  walletFee,
  walletAddress,
  blockers,
  nowMs,
  followed = 0,
  through = null,
  onBlast,
  onDeposit,
  primaryExtra,
}: CommitDialogProps) {
  const labelId = useId();
  // `Sheet` focuses whatever this names when it opens, so the box is ready to
  // type into; the panel puts the caret at the end of a restored draft.
  const amount = useRef<HTMLInputElement | null>(null);
  return (
    <Sheet
      className={styles.trade}
      hasDock={!receipt}
      initialFocus={() => window.matchMedia("(max-width: 760px)").matches ? null : amount.current}
      labelledBy={labelId}
      onRequestClose={onRequestClose}
      onClosed={onClosed}
      onRequestOpen={onRequestOpen}
      open={open}
    >
      <SheetClose onClick={onRequestClose} />
      {receipt ? (
        <CommitReceipt receipt={receipt} onDone={onRequestClose} titleId={labelId} />
      ) : (
        <>
          <span className="sr-only" id={labelId}>
            {commitDialogLabel(detail.presale.name)}
          </span>
          <CommitPanel
            summary={
              <>
                <SaleHead detail={detail} nowMs={nowMs} />
                <SaleRaise detail={detail} followed={followed} />
                <SaleFacts detail={detail} />
                {through ? (
                  <div className={styles.via}>
                    {through.avatar}
                    <span>Through <b>{through.name}</b>’s post</span>
                  </div>
                ) : null}
              </>
            }
            details={
              <Link className={styles.sheetLink} href={`/presale/${detail.presale.presale_id}`} onClick={onRequestClose}>
                Open the presale page
                <Chevron />
              </Link>
            }
            active={open}
            amountRef={amount}
            blockers={blockers}
            nowMs={nowMs}
            onBlast={onBlast}
            onDeposit={onDeposit}
            primaryExtra={primaryExtra}
            sale={sale}
            viewer={viewer}
            walletAddress={walletAddress}
            walletCoins={walletCoins}
            walletCoinsState={walletCoinsState}
            walletFee={walletFee}
          />
        </>
      )}
    </Sheet>
  );
}

export type SaleDialogProps = Readonly<{
  open: boolean;
  onRequestClose: () => void;
  onClosed?: () => void;
  detail: CommitSaleRead;
  nowMs: number;
  followed?: number;
  /** The bell of a pending sale: `null` hides it (a visitor goes through the gate). */
  notify?: Readonly<{ on: boolean; toggle: () => void }> | null;
}>;

/**
 * The sale dialog: every state but `open` (FEATURE-MAP §11). One line, then
 * the state's action.
 *
 * The footer link's style is the **gate's** rule, which is the reverse of what
 * `FEATURE-MAP-R3.md` §11 and `R3-DELTA.md` §11 both state. See
 * `saleFooterLinkStyle`.
 */
function PendingSaleOpening({ at }: Readonly<{ at: number }>) {
  return at > 0 ? <>Opens <DateStamp at={at} label="presale opening time" />.{" "}</> : <>No opening date yet.{" "}</>;
}

export function SaleDialog({ open, onRequestClose, onClosed, detail, nowMs, followed = 0, notify = null }: SaleDialogProps) {
  const labelId = useId();
  const quiet = saleFooterLinkStyle(detail.presale.phase) === "quiet";
  const href = `/presale/${detail.presale.presale_id}`;
  return (
    <Sheet className={styles.trade} labelledBy={labelId} onClosed={onClosed} onRequestClose={onRequestClose} open={open}>
      <SheetClose onClick={onRequestClose} />
      <span className="sr-only" id={labelId}>
        {detail.presale.name}
      </span>
      <SaleHead detail={detail} nowMs={nowMs} />
      <SaleRaise detail={detail} followed={followed} />
      <SaleFacts detail={detail} />
      <p className={styles.plain}>
        {detail.presale.phase === "pending" ? <PendingSaleOpening at={detail.presale.start_ms} /> : null}
        {saleDialogLine(detail, nowMs)}
      </p>
      {detail.presale.phase === "pending" && notify ? (
        <button aria-pressed={notify.on} className="btn btn-primary btn-lg btn-block" onClick={notify.toggle} type="button">
          {notify.on ? "Notifying" : "Notify me"}
        </button>
      ) : null}
      {quiet ? (
        <Link className={styles.sheetLink} href={href} onClick={onRequestClose}>
          Open the presale page
          <Chevron />
        </Link>
      ) : (
        <Link className="btn btn-line btn-lg btn-block" href={href} onClick={onRequestClose}>
          Open the presale page
        </Link>
      )}
    </Sheet>
  );
}
