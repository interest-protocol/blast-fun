"use client";

import { Button } from "#web/components/blast-ui/Button.tsx";
import { diagnosticMessage, publicErrorMessage } from "#web/lib/errors.ts";

import { useState, useRef, useSyncExternalStore, useEffect, useLayoutEffect, type ReactNode } from "react";

import { walletCoinViews, type WalletCoinView } from "../coins/coin-model";
import type { CommitFacts, CommitKit } from "./commit-kit";
import type { QuoteSnapshot } from "./commit-quote";
import { commitFactsAt, viaEntryOf } from "./commit-view";
import type { ContributionReceipt } from "./commit-receipt";
import { CommitPanel, type CommitDraft, type CommitPanelProps } from "./CommitPanel";
import { QueryRefusal } from "#web/lib/query/client.ts";
import styles from "./commit.module.css";

/**
 * The commit panel drawn inline (OA-43: the sale page's side box at the
 * right column's width draws the whole commit form, `panelHTML('commit', id,
 * null, true, 'side')`, where the app used to show a "Blast in" button that
 * opened the dialog).
 *
 * Nothing about the commit is new here. The panel is the dialog's own
 * `CommitPanel`; its facts are the commit host's quote reads (`CommitKit
 * .quotes`: the same sale read, Blast wallet, position and allowlist leaf the
 * dialog reads when it opens, through the same `commitSaleOf`,
 * `commitViewerOf` and `commitBlockers`); and its blast is the host's
 * `CommitKit.send`, which is the dialog's own `blastWith` → `runCommitFor`
 * → `runCommit` (the server-built commit, the signature, the intent, the
 * toast, the sounds, the balances and the reads it invalidates). A sale page
 * reached through a shared post credits it (`?via=`), exactly as the
 * dialog's `openCommitTo` does, and names nobody in the toast (no post in
 * hand).
 *
 * The loading fallback is replaced by an explicit, retryable error or
 * unavailable state when the read finishes. USD prices are not required.
 *
 * After a blast lands, the panel starts afresh (the gate redraws it), the
 * quote is read again and `onCommitted` lets the page read the viewer's
 * position again.
 */

const NO_QUOTE: QuoteSnapshot<CommitFacts> = Object.freeze({ facts: null, at: null, loading: false, failed: false });

function presaleReadNotice(snapshot: QuoteSnapshot<CommitFacts>, nowMs: number): Readonly<{ state: "unavailable" | "error"; message: string }> | null {
  if (snapshot.error instanceof QueryRefusal && snapshot.error.code === "not_found") return { state: "unavailable", message: diagnosticMessage("This presale is no longer available.", snapshot.error) };
  if (snapshot.failed) return { state: "error", message: publicErrorMessage(snapshot.error, snapshot.error?.name === "TimeoutError" ? "Presale terms took too long to load." : "Presale terms could not load. Try again.", "service_unavailable") };
  const facts = snapshot.facts;
  if (!facts?.sale || !facts.detail.terms) return { state: "unavailable", message: diagnosticMessage("Presale terms are unavailable.", { code: "service_unavailable" }) };
  if (facts.sale.presalePrice === null || facts.sale.presalePrice <= 0) return { state: "unavailable", message: diagnosticMessage("Presale pricing terms are unavailable.", { code: "service_unavailable" }) };
  if (facts.sale.lifecycle !== "open" || facts.sale.endMs <= nowMs || facts.detail.presale.start_ms > nowMs) return { state: "unavailable", message: diagnosticMessage("This presale is not open for purchases.", { code: "commit_unavailable" }) };
  return null;
}

/** Purchase-sheet state stays with the coin sheet; sale pages need only the commit lifecycle. */
type InlineCommitPurchase = Readonly<{
  initialPayCoin?: string;
  initialPaymentCoin?: WalletCoinView;
  draft?: CommitPanelProps["draft"];
  onDraftChange?: CommitPanelProps["onDraftChange"];
  onDetails?: () => void;
  onPendingChange?: (pending: boolean) => void;
  active?: boolean;
  onConfirmed?: (receipt: ContributionReceipt) => void;
}>;

export function InlineCommit({ kit, presaleId, nowMs, fallback, onCommitted, purchase: purchaseState }: Readonly<{
  kit: CommitKit;
  presaleId: string;
  nowMs: number;
  fallback: ReactNode;
  onCommitted?: () => void;
  purchase?: InlineCommitPurchase;
}>) {
  const purchase = purchaseState !== undefined;
  const { initialPayCoin, initialPaymentCoin, draft, onDraftChange,
    onDetails, onPendingChange, active = true, onConfirmed } = purchaseState ?? {};
  const surface = useRef<HTMLDivElement>(null);
  const visible = useRef(active);
  useLayoutEffect(() => { visible.current = active; }, [active]);
  const quotes = kit.quotes;
  const snapshot = useSyncExternalStore(quotes.subscribe, () => quotes.peek(presaleId), () => NO_QUOTE);
  // One read on arrival; the source answers from its cache when the quote is fresh.
  useEffect(() => {
    quotes.want(presaleId, { now: true });
  }, [quotes, presaleId]);
  // Each landed blast draws a fresh panel (its amount and why reset), as the gate's `panel.outerHTML = panelHTML(…)`.
  const [round, setRound] = useState(0);
  // The pay coin the person picked outlives that fresh panel and any re-read: only the amount and why reset.
  const [payCoin, setPayCoin] = useState<WalletCoinView | undefined>(undefined);
  const draftChange = (next: CommitDraft) => { setPayCoin(next.paymentCoin); onDraftChange?.(next); };
  const facts = commitFactsAt(snapshot.facts, nowMs);
  const sale = facts?.sale ?? null;
  if (facts === null && (snapshot.loading || !snapshot.failed)) return <div className={purchase ? styles.purchaseRead : undefined} aria-busy="true" data-presale-state="loading">{fallback}</div>;
  const notice = presaleReadNotice(snapshot, nowMs);
  if (notice) return <CommitReadNotice notice={notice} purchase={purchase} onRetry={() => void quotes.refresh(presaleId)} />;
  if (sale === null || facts === null) return null;

  const blast: CommitPanelProps["onBlast"] = async (input, onPhase) => {
    if (!kit.signedIn) return { ok: false, message: diagnosticMessage("Your wallet is still loading. Try again in a moment.", { code: "blast_wallet_missing" }) };
    onPendingChange?.(true);
    const origin = surface.current;
    const sent = await kit.send(facts, input, { onPhase,
      onConfirmed: onConfirmed ? (receipt) => {
        if (!visible.current || !origin?.isConnected || surface.current !== origin || origin.dataset.presaleId !== presaleId) return;
        onConfirmed(receipt);
      } : undefined,
      source: { entryId: viaEntryOf(window.location.search), through: null } }).finally(() => onPendingChange?.(false));
    if (sent.status === "pending") return { ok: true, digest: sent.digest, pending: sent.message };
    if (sent.status !== "sent") return { ok: false, message: sent.message ?? undefined };
    if (surface.current === origin && origin?.dataset.presaleId === presaleId) {
      setRound((count) => count + 1);
      void Promise.resolve().then(() => onCommitted?.()).catch(() => {});
    }
    void Promise.resolve().then(() => quotes.refresh(presaleId)).catch(() => {});
    return { ok: true };
  };

  const walletCoins = walletCoinViews(facts.wallet);
  return (
    // Interacting with the panel re-reads a quote older than its age (the source's own rule), so a panel that sat on
    // the page for a while blasts with today's balances and raise, as the dialog does with its read at opening.
    <div className={purchase ? styles.purchaseRead : undefined} data-inline-commit="" data-presale-id={presaleId} data-presale-state="ready" ref={surface} onFocusCapture={() => quotes.want(presaleId)}>
      <CommitPanel
        active={active}
        blockers={facts.blockers}
        inline
        purchase={purchase}
        draft={draft}
        onDraftChange={draftChange}
        onDetails={onDetails}
        key={`${presaleId}:${round}`}
        nowMs={nowMs}
        onBlast={blast}
        onDeposit={kit.deposit}
        sale={sale}
        initialPayCoin={payCoin?.coinType ?? initialPayCoin}
        initialPaymentCoin={payCoin ?? initialPaymentCoin}
        walletAddress={facts.wallet?.address}
        walletCoins={walletCoins}
        walletCoinsState={facts.wallet?.address ? "ready" : "unavailable"}
        walletFee={facts.wallet?.fee}
        viewer={facts.viewer}
      />
    </div>
  );
}

function CommitReadNotice({ notice, purchase, onRetry }: Readonly<{ notice: { state: "unavailable" | "error"; message: string }; purchase: boolean; onRetry: () => void }>) {
  return <div className={purchase ? `${styles.panel} ${styles.purchase}` : undefined} data-presale-state={notice.state}>
    <div className={purchase ? styles.purchaseBody : undefined}>
      <div className={styles.readNotice}>
        <p role="status">{notice.message}</p>
        <button className="btn btn-quiet" onClick={onRetry} type="button">Retry</button>
      </div>
    </div>
    {purchase ? <div className={styles.purchaseFooter}><p>Commitments can’t be withdrawn before close.</p><Button className={styles.primary} disabled size="lg" variant="primary">Presale terms unavailable</Button></div> : null}
  </div>;
}
