"use client";

import Link from "next/link";
import { useCallback, useEffect, useState, type MouseEvent, type ReactNode } from "react";

import { opensAt, qty, quoteOf, readsInCoin, usd0 } from "@blast/core/web/format.ts";
import { bpsMultiple } from "@blast/core/lib/bps.ts";
import { exactAtoms, groupedExact } from "@blast/core/lib/exact-amount.ts";
import { AmountFit } from "#web/components/blast-ui/AmountFit.tsx";
import { CoinAmount } from "#web/components/blast-ui/CoinAmount.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { claimDone } from "#web/components/social/claim/claim-projection.ts";
import { saleClaimTarget, type ClaimPath } from "#web/components/social/claim/claims.ts";
import { NO_CLAIMS } from "#web/components/social/claim/claim-runner.ts";
import type { Claims } from "#web/components/social/claim/use-claims.tsx";
import type { CommitKit } from "#web/components/social/commit/commit-kit.ts";
import { InlineCommit } from "#web/components/social/commit/InlineCommit.tsx";
import { useCommitKit, useSaleCommit, useShellClaimPath } from "#web/components/social/feed-ui/shell-bridge.tsx";
import { useSignInGate } from "#web/components/social/SignInGate.tsx";
import { useViewerFollow, useViewerStateStore } from "#web/components/social/ViewerState.tsx";
import type { SocialPresaleDetail, SocialPresaleViewerEntry } from "@blast/core/web/contracts/presales.ts";

import { ClaimButton, useToastedClaims } from "#web/components/social/claim/ClaimButton.tsx";
import { CspStyles } from "./csp-style";
import { cx } from "./cx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { presaleDetailQuery } from "#web/components/social/queries.ts";
import { TokenAmount } from "#web/components/vesting/DetailValues.tsx";
import { vestingPath } from "@blast/core/modules/vesting/model.ts";
import buyerStyles from "./buyer-vesting.module.css";
import { heldTargetOfSale } from "./held-target";
import { BellIcon } from "./icons";
import { SaleAccessContent, SignInToCheck } from "./SaleAccess";
import type { SaleAccess } from "./sale-access";
import { useSaleAccess } from "./use-sale-access";
import { claimableTokenText, fundingState, n, saleMoney } from "@blast/core/modules/presale/presentation.ts";
import { useSaleDetail, useViewerPresalesRead } from "./presales-client";
import { BlastButton, FriendsCard, SHOW_FOLLOWING_EVENT, TokenomicsCard, type SaleCommit } from "./SaleView";
import { SaleTradePanel } from "./SaleTradePanel";
import { SaleTransition } from "./SaleTransition";

/** Tokens a commitment buys at the presale price after the oversubscription refund, as whole tokens (both in the sale's coin). */
function tokensFor(committed: number, fill: number, presalePrice: number | null): number | null {
  return presalePrice && presalePrice > 0 ? Math.round((committed * fill) / presalePrice) : null;
}

function estimatedRefund(sale: SocialPresaleDetail["presale"], committed: string) {
  const raised = BigInt(sale.raised_atoms);
  const target = BigInt(sale.target_atoms);
  return raised > target ? (BigInt(committed) * (raised - target)) / raised : 0n;
}

function QuoteAmount({ sale, atoms, prominent = false }: Readonly<{
  sale: SocialPresaleDetail["presale"];
  atoms: string | bigint;
  prominent?: boolean;
}>) {
  const amount = exactAtoms(atoms, sale.quote_decimals);
  if (!amount) return "Unavailable";
  const value = groupedExact(amount, amount.scale);
  const coinAmount = <CoinAmount amount={value} coinType={sale.quote_type} symbol={sale.quote_symbol} />;
  return prominent ? <AmountFit value={`${value} ${sale.quote_symbol}`}>{coinAmount}</AmountFit> : coinAmount;
}

function SaleTokenAmount({ sale, amount }: Readonly<{ sale: SocialPresaleDetail["presale"]; amount: string }>) {
  return <CoinAmount amount={amount} coinType={sale.coin_type} iconUrl={sale.icon_url} symbol={sale.symbol} />;
}

function NotifyMe({ detail }: Readonly<{ detail: SocialPresaleDetail }>) {
  const sale = detail.presale;
  const gate = useSignInGate();
  const store = useViewerStateStore();
  const toast = useToast();
  const target = { kind: "presale", presale_id: sale.presale_id } as const;
  const on = useViewerFollow(target) === true;
  return (
    <button
      aria-pressed={on}
      className={cx("btn btn-primary btn-lg btn-block notify-btn", on && "on")}
      disabled={gate.sessionPending}
      onClick={async (event: MouseEvent) => {
        if (!gate.signedIn) {
          gate.openSignIn(event);
          if (!event.defaultPrevented) window.location.assign(gate.signInHref);
          return;
        }
        if (!store) return;
        // Shown at once; a refusal puts the button back.
        const result = await store.setFollowing(target, !on);
        if (result.status !== "ok") toast("That didn't save", { sub: "Nothing changed. Try again in a moment." });
      }}
      type="button"
    >
      <BellIcon />
      {on ? "You’ll be notified" : "Notify me"}
    </button>
  );
}

/**
 * The sale's side box (FEATURE-MAP §10.4) for its phase: Blast in (open; the
 * commit panel itself under the commit host, OA-43), the opening countdown (upcoming), the funded split, the viewer's tokens or
 * the price (trading), or the refund (cancelled).
 */
/** Use the same units for the commitment and price when estimating token allocations. */
function sideMoney(sale: SocialPresaleDetail["presale"], mine: SocialPresaleViewerEntry["mine"] | null) {
  const coin = readsInCoin(quoteOf(sale));
  const inCoin = (usdValue: string | null | undefined, atoms: string | null | undefined) => (coin ? n(atoms) / 10 ** sale.quote_decimals : n(usdValue));
  const price = coin ? sale.presale_price_quote : sale.presale_price_usd;
  return {
    inCoin,
    committed: inCoin(mine?.commitment_usd, mine?.commitment_atoms),
    /** The refund as its toast says it, the gate's `usd(amt, 2)` (P-16): `$250.00 refund claimed`. */
    refundToastText: saleMoney(sale, mine?.commitment_usd, mine?.commitment_atoms, 2),
    presalePrice: price === null ? null : n(price),
  };
}

function useSideBoxContext({
  detail,
  entry,
  now,
  commit,
  kit = null,
  onCommitted,
  claims = NO_CLAIMS,
}: Readonly<{
  detail: SocialPresaleDetail;
  entry: SocialPresaleViewerEntry | null;
  now: number;
  commit?: SaleCommit;
  /** The commit host's kit: with it, an open sale's box draws the commit panel inline (OA-43). */
  kit?: CommitKit | null;
  /** A blast from the inline panel landed: the page reads the viewer's position again. */
  onCommitted?: () => void;
  claims?: Claims;
}>) {
  const gate = useSignInGate();
  const sale = detail.presale;
  const mine = gate.signedIn ? entry?.mine ?? null : null;
  const money = sideMoney(sale, mine);
  const noteId = `commit-note-${sale.presale_id.slice(-6)}`;
  return { detail, sale, mine, gate, now, commit, kit, onCommitted, claims, noteId, ...money };
}

type SideBoxContext = ReturnType<typeof useSideBoxContext>;

function CommitSideBox({ detail, sale, mine, gate, noteId, now, commit, kit, onCommitted }: SideBoxContext) {
  const funding = fundingState(detail, now);
  const blastIn = (
    <>
      <BlastButton
        commit={commit}
        describedBy={noteId}
        gate={gate}
        held={heldTargetOfSale(sale)}
        label={`Commit ${sale.quote_symbol}`}
        large
        presaleId={sale.presale_id}
      />
      {gate.signedIn && !commit ? (
        <p className={cx("side-note-muted")} id={noteId}>Commits open here once the sale contract is live on Sui.</p>
      ) : null}
    </>
  );
  // The Sale board's ticket: "Blast", then the commit panel; the time left is the main card's.
  return (
    <div className={cx("card side-box blast-box")}>
      <div className={cx("side-h")}>
        <h2>{funding.open ? "Blast" : "Closed"}</h2>
      </div>
      {funding.open ? (
        // OA-43: signed in under the commit host, the box is the commit panel itself (the dialog's, the same flow);
        // a visitor gets "Sign in to blast in", and the button stays until the panel's first quote answers.
        kit ? (
          <InlineCommit fallback={blastIn} key={sale.presale_id} kit={kit} nowMs={now} onCommitted={onCommitted} presaleId={sale.presale_id} />
        ) : (
          blastIn
        )
      ) : null}
      {sale.phase === "closed" || (sale.phase === "open" && !funding.open) ? <p className={cx("plain flush")}>The sale has ended. The result settles on chain shortly.</p> : null}
      {mine ? <div className={cx("side-pos")}>You&apos;ve committed <b><QuoteAmount atoms={mine.commitment_atoms} sale={sale} /></b></div> : null}
    </div>
  );
}

/** When a listed or open-sale viewer can buy; the countdown itself is the main card's. */
function opensNote(access: SaleAccess, startMs: number): string | null {
  if (access.kind !== "listed" && access.kind !== "open") return null;
  return opensAt(startMs) === null ? "You can buy once the creator opens the sale." : "You can buy when the sale opens.";
}

function PendingSideBox({ sale, detail }: SideBoxContext) {
  // The main card carries the opening time; the box says whether, and how much, the viewer can buy.
  const { access, retry, retrying } = useSaleAccess(detail);
  const note = opensNote(access, sale.start_ms);
  return (
    <div className={cx("card side-box blast-box")}>
      <div className={cx("side-h")}><h2>Blast</h2></div>
      <SaleAccessContent access={access} detail={detail} retry={retry} retrying={retrying} />
      {note ? <p className={cx("access-note")}>{note}</p> : null}
      {access.kind === "signed_out" ? <SignInToCheck primary /> : <NotifyMe detail={detail} />}
    </div>
  );
}

function TradingSideBox(context: SideBoxContext) {
  if (!context.mine) return null;
  if (context.detail.terms?.buyer_vesting || context.mine.buyer_vesting) return <BuyerVestingHolding {...context} />;
  return <WalletTokenHolding {...context} />;
}

function WalletTokenHolding({ sale, mine, inCoin, committed, presalePrice, claims, refundToastText }: SideBoxContext) {
  if (!mine) return null;
  const multipleValue = n(sale.multiple);
  const mult = sale.multiple === null ? null : <b className={cx(multipleValue >= 1 ? "up" : "down")}>{multipleValue.toFixed(1)}×</b>;
  const refund = inCoin(mine.refund_usd, mine.refund_atoms);
  const indexedTokens = mine.claimed ? mine.claimed_tokens : mine.claimable_tokens;
  const tokens = indexedTokens == null ? tokensFor(committed - refund, 1, presalePrice) : n(indexedTokens) / 10 ** sale.sale_decimals;
  const exactTokens = exactAtoms(indexedTokens, sale.sale_decimals);
  const displayTokens = exactTokens ? groupedExact(exactTokens, exactTokens.scale) : tokens === null ? null : qty(tokens);

  return (
    <div className={cx("card side-box")}>
      <TradingValue sale={sale} tokens={tokens} amount={displayTokens} mult={mult} />
      <WalletTokenClaim claims={claims} mine={mine} refundToastText={refundToastText} sale={sale} />
    </div>
  );
}

function WalletTokenClaim({ sale, mine, claims, refundToastText }: Readonly<{
  sale: SocialPresaleDetail["presale"];
  mine: NonNullable<SocialPresaleViewerEntry["mine"]>;
  claims: Claims;
  refundToastText: string;
}>) {
  if (mine.claimed) return <p className={cx("plain side-note")}>Presale tokens claimed.</p>;
  if (claimDone(claims, sale.presale_id, "claim_tokens")) {
    return <p className={cx("plain side-note")} role="status">Claim confirmed. Updating balances.</p>;
  }
  if (!claims.available || !claims.supports("claim_tokens")) return null;
  if (mine.claimable_tokens === "0") return <OverflowRefundClaim claims={claims} mine={mine} sale={sale} />;
  const target = saleClaimTarget("claim_tokens", sale, refundToastText, claimableTokenText(sale, mine));
  return <>
    <p className={cx("plain side-note")}>Any refund goes to your wallet with your tokens.</p>
    <ClaimButton claims={claims} label="Claim tokens" target={target} />
  </>;
}

function OverflowRefundClaim({ sale, mine, claims }: Readonly<{
  sale: SocialPresaleDetail["presale"];
  mine: NonNullable<SocialPresaleViewerEntry["mine"]>;
  claims: Claims;
}>) {
  // A zero token allocation can still leave quote to claim on a migrated sale.
  if (mine.claim_wallet_participated === false || mine.claim_wallet_claimed || BigInt(sale.raised_atoms) <= BigInt(sale.target_atoms)) return null;
  const target = { ...saleClaimTarget("claim_tokens", sale, ""), done: { title: "Claim confirmed", sub: sale.name } };
  return <ClaimButton claims={claims} label="Claim" target={target} />;
}

function BuyerVestingHolding(context: SideBoxContext) {
  return <div className={cx("card side-box")}>
    <div className={cx("side-h")}><b>Your buyer vesting · Blast wallet</b></div>
    <BuyerVestingClaim {...context} />
  </div>;
}

function BuyerVestingClaim({ sale, mine, claims, refundToastText }: SideBoxContext) {
  if (!mine) return null;
  const vesting = mine.buyer_vesting;
  const amount = (value: string, label: string) => <TokenAmount decimals={sale.sale_decimals} label={label} symbol={sale.symbol} value={value} />;
  if (vesting) return <>
    <dl className={buyerStyles.personal}>
      <div><dt>Claimed to date</dt><dd>{amount(vesting.claimed, "Your buyer tokens claimed to date")}</dd></div>
      <div><dt>Unclaimed</dt><dd>{amount(vesting.remaining, "Your remaining buyer vesting tokens")}</dd></div>
    </dl>

    <Link className={cx("btn btn-primary btn-lg btn-block")} data-sale-claim={vesting.remaining === "0" ? undefined : ""} href={vestingPath(vesting.schedule_id)}>{vesting.remaining === "0" ? "View completed schedule" : "View schedule and claim"}</Link>
  </>;
  if (mine.claim_wallet_participated === false) return <p className={cx("plain side-note")}>This presale was backed by another linked wallet. Use that wallet to view and claim its vesting.</p>;
  if ((mine.claim_wallet_claimed ?? mine.claimed) || claimDone(claims, sale.presale_id, "claim_tokens")) return <p className={cx("plain side-note")} role="status">Your initial presale claim is confirmed. Your vesting balances are updating.</p>;
  return <BuyerVestingStart sale={sale} mine={mine} claims={claims} refundToastText={refundToastText} />;
}

function BuyerVestingStart({ sale, mine, claims, refundToastText }: Pick<SideBoxContext, "sale" | "mine" | "claims" | "refundToastText">) {
  if (!mine) return null;
  const canStart = mine.claimable_tokens != null && BigInt(mine.claimable_tokens) > BigInt(0);
  const claimAmount = claimableTokenText(sale, mine);
  const amount = (value: string, label: string) => <TokenAmount decimals={sale.sale_decimals} label={label} symbol={sale.symbol} value={value} />;
  return <>
    {mine.claimable_tokens === "0" ? null : <p className={cx("plain side-note")}>{claimAmount ? <>Your allocation: <b>{claimAmount}</b>. </> : null}Your claim starts vesting; any refund is paid to your wallet.</p>}
    <dl className={buyerStyles.personal}>
      <div><dt>Claimed to date</dt><dd>{mine.claim_wallet_participated || canStart ? amount("0", "Your buyer tokens claimed to date") : "Unavailable"}</dd></div>
      <div><dt>Awaiting vesting</dt><dd>{mine.claimable_tokens == null ? "Unavailable" : amount(mine.claimable_tokens, "Your buyer tokens awaiting vesting")}</dd></div>
    </dl>
    {canStart ? <ClaimButton claims={claims} label="Start your vesting" target={saleClaimTarget("claim_tokens", sale, refundToastText, claimAmount, true)} /> : null}
    {mine.claimable_tokens === "0" ? <OverflowRefundClaim claims={claims} mine={mine} sale={sale} /> : null}
  </>;
}

function TradingValue({ sale, tokens, amount, mult }: Readonly<{
  sale: SocialPresaleDetail["presale"];
  tokens: number | null;
  amount: string | null;
  mult: ReactNode;
}>) {
  const tokenAmount = amount === null ? null : <SaleTokenAmount amount={amount} sale={sale} />;
  const hasMarketValue = sale.price_usd !== null && tokens !== null;
  return <>
    <div className={cx("side-h")}><b>Your {sale.symbol}</b></div>
    <div className={cx("cd-big num")}>{hasMarketValue ? usd0(tokens * n(sale.price_usd)) : tokenAmount ? <AmountFit value={`${amount} ${sale.symbol}`}>{tokenAmount}</AmountFit> : "Unavailable"}</div>
    {hasMarketValue || mult ? <p className={cx("plain side-note")}>{hasMarketValue ? tokenAmount : null}{mult ? <>{hasMarketValue ? " · " : null}{mult} since the presale</> : null}</p> : null}
  </>;
}

function FundedSideBox({ sale, mine, committed, presalePrice }: SideBoxContext) {
  const fill = sale.fill_bps > 0 ? Math.min(1, 10_000 / sale.fill_bps) : 1;
  const tokens = mine ? tokensFor(committed, fill, presalePrice) : null;
  return (
    <div className={cx("card side-box")}>
      <div className={cx("side-h")}>
        <b>Funded</b>
        <span className={cx("status funded")}>{bpsMultiple(sale.fill_bps)}</span>
      </div>
      <p className={cx("plain flush")}>
        Claims open when trading starts on <DexIdentity iconOnly venue={sale.venue} />. Everyone gets {Math.round(fill * 100)}% of their amount in tokens and the rest back.
      </p>
      {mine ? (
        <dl className={cx("terms")}>
          <div><dt>You committed</dt><dd className={cx("num")}><QuoteAmount atoms={mine.commitment_atoms} sale={sale} /></dd></div>
          {tokens !== null ? <div><dt>Estimated tokens</dt><dd className={cx("num")}><SaleTokenAmount amount={qty(tokens)} sale={sale} /></dd></div> : null}
          <div><dt>Estimated refund</dt><dd className={cx("num")}><QuoteAmount atoms={estimatedRefund(sale, mine.commitment_atoms)} sale={sale} /></dd></div>
        </dl>
      ) : null}
    </div>
  );
}

function CancelledSideBox({ sale, mine, claims, noteId, refundToastText }: SideBoxContext) {
  const refunded = mine?.claimed || claimDone(claims, sale.presale_id, "claim_refund");
  const claimable = claims.available && claims.supports("claim_refund");
  return (
    <div className={cx("card side-box")}>
      <div className={cx("side-h")}><b>{mine ? (refunded ? "Refunded" : "Your refund") : "Refunds are open"}</b></div>
      {mine ? <div className={cx("cd-big num")}><QuoteAmount atoms={mine.commitment_atoms} prominent sale={sale} /></div> : null}
      {mine && !refunded ? <>
        <ClaimButton claims={claims} describedBy={claimable ? undefined : noteId} keepVisible label="Claim refund" target={saleClaimTarget("claim_refund", sale, refundToastText)} />
        {claimable ? null : <p className={cx("side-note-muted")} id={noteId}>Refunds are claimed here once the sale contract is live on Sui.</p>}
      </> : null}
    </div>
  );
}

export function SideBox(props: Parameters<typeof useSideBoxContext>[0]) {
  const context = useSideBoxContext(props);
  switch (context.sale.phase) {
    case "open":
    case "closed":
      return <CommitSideBox {...context} />;
    case "pending":
      return <PendingSideBox {...context} />;
    case "trading":
      return <TradingSideBox {...context} />;
    case "funded":
      return <FundedSideBox {...context} />;
    default:
      return <CancelledSideBox {...context} />;
  }
}

/** The sale page's right column (≥1220): the side box and "People you follow". */
export function SaleAside({
  detail: served,
  nowMs,
  commit,
  claim,
  kit,
  compact = false,
}: Readonly<{
  detail: SocialPresaleDetail;
  compact?: boolean;
  nowMs: number;
  commit?: SaleCommit;
  /** The claim transaction (R3-63); by default the shell's, which exists only with a mainnet deployment and a signed-in viewer. */
  claim?: ClaimPath;
  /** The commit host's kit (OA-43's inline panel); by default the shell's. `null`: none (the box keeps its "Blast in" button). */
  kit?: CommitKit | null;
}>) {
  // The main column's read (one shared query): a commit or the sale's close moves the box too.
  const detail = useSaleDetail(served, nowMs);
  const [now, setNow] = useState(nowMs);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  // A claim's answer, confirmed or refused, reads the viewer's position again (`reads`).
  const [reads, setReads] = useState(0);
  const viewer = useViewerPresalesRead([detail.presale.presale_id], reads);
  const entry = viewer.data?.[detail.presale.presale_id] ?? null;
  // Under the shell's commit dialog, "Blast in" opens it (UI-09/10's hand-off).
  const hostCommit = useSaleCommit();
  const hostClaim = useShellClaimPath();
  const hostKit = useCommitKit();
  const queries = useAppQueryClient();
  const reread = useCallback(() => { setReads((count) => count + 1); void queries.invalidateQueries({ queryKey: presaleDetailQuery(detail.presale.presale_id).queryKey }); }, [queries, detail.presale.presale_id]);
  const claims = useToastedClaims(claim ?? hostClaim, { onSettled: reread });
  const trading = detail.presale.phase === "trading";
  return (
    <>
      <CspStyles />
      <SaleTransition aside sale={detail.presale}>
        {!compact && detail.presale.phase === "trading" ? <SaleTradePanel sale={detail.presale} /> : null}
        <SideBox
          claims={claims}
          commit={commit ?? hostCommit}
          detail={detail}
          entry={entry}
          kit={kit === undefined ? hostKit : kit}
          now={now}
          onCommitted={() => setReads((count) => count + 1)}
        />
      </SaleTransition>
      {compact ? null : trading ? (
        // The Coin board's column: the ticket, then the tokenomics.
        detail.terms ? <TokenomicsCard sale={detail.presale} terms={detail.terms} /> : null
      ) : <FriendsCard detail={detail} entry={entry} now={now} onSeeAll={() => window.dispatchEvent(new Event(SHOW_FOLLOWING_EVENT))} />}
    </>
  );
}
