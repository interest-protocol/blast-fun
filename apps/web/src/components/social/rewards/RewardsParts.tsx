"use client";

import { rewardsHeadline } from "./rewards-headline.ts";

import { Collapse } from "#web/components/blast-ui/Collapse.tsx";
import { Button, DisclosureButton } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";

import { diagnosticMessage } from "#web/lib/errors.ts";

import clsx from "clsx";
import { PayoutSkeleton } from "./RewardsSkeleton";
export { RewardsSkeleton } from "./RewardsSkeleton";
import Link from "next/link";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import { EXPLORER_NAMES, explorerTransactionUrl } from "@blast/core/lib/explorer.ts";
import { ExternalIcon } from "#web/components/blast-ui/Icons.tsx";
import { CLAIMS_PATH, HOME_PATH } from "#web/components/blast-ui/nav.ts";
import { instantFeedback } from "#web/components/blast-ui/feedback-motion.ts";
import { EASE_OUT, staggerDelay } from "#web/components/blast-ui/motion-tokens.ts";

import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { ChevIcon } from "../profile/icons";
import {
  amountsText,
  coinPart,
  coinSub,
  coinValue,
  grandText,
  masked,
  exactAmountsText,
  moreText,
  payoutLabel,
  payoutSub,
  quoteText,
  relayOwed,
  waitReason,
  whenText,
  anyUsd,
  WAIT_KINDS,
  RW_PAGE_N,
  RW_MORE,
  type RewardAmountsView,
  type RewardCoinView,
  type RewardPayoutView,
  type WaitKind,
} from "./rewards-model";
import styles from "./Rewards.module.css";

/**
 * Rewards' pieces (OA-45, OA-46; the gate's `rwRow`, `rwRowC`, `rwCoinHTML`,
 * `rwSummaryHTML`, `rwEmptyHTML`, `rwSkelHTML`, `rwTabHTML`, `rwSideHTML`
 * and `rwHowHTML`). Presentational: the reads are `use-rewards.ts`'s.
 */

/* ---------------- icons (the gate's `I` table: 24 px, stroke 1.8, decorative) ---------------- */

function LineIcon({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
    >
      {children}
    </svg>
  );
}
export const RewardIcon = () => (
  <LineIcon>
    <ellipse cx="12" cy="6.5" rx="7" ry="3" />
    <path d="M5 6.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" />
    <path d="M5 11.5v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5" />
  </LineIcon>
);
export const ClockIcon = () => (
  <LineIcon>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </LineIcon>
);

/* ---------------- rows ---------------- */

export type RowContext = Readonly<{
  nowMs: number;
  hidden: boolean;
  explorer: string;
  href: (digest: string) => string | null;
}>;

/** The rows' context: the clock they read times against, the eye, and the viewer's explorer (Settings → Explorer). */
export function useRowContext(nowMs: number, hidden: boolean): RowContext {
  const { explorer } = useDevicePrefs();
  return {
    nowMs,
    hidden,
    explorer: EXPLORER_NAMES[explorer],
    href: (digest) => explorerTransactionUrl(explorer, digest),
  };
}

function Amounts({
  amounts,
  symbol,
  quoteSymbol,
  hidden,
}: Readonly<{
  amounts: RewardAmountsView;
  symbol: string;
  quoteSymbol: string;
  hidden: boolean;
}>) {
  return (
    <span className={styles.v}>
      <b className="num" title={hidden ? undefined : exactAmountsText(amounts, symbol, quoteSymbol)}>
        +
        {masked(
          amounts.coin === 0
            ? quoteText(amounts.quote, quoteSymbol)
            : coinPart(amounts.coin, symbol),
          hidden,
        )}
      </b>
      {amounts.coin > 0 && amounts.quote > 0 ? (
        <span className={clsx("num", styles.muted)}>
          +{masked(quoteText(amounts.quote, quoteSymbol), hidden)}
        </span>
      ) : null}
    </span>
  );
}

/** A payout (the gate's `rwRow`, or `rwRowC` inside its coin): it opens the transaction on the viewer's explorer. */
export function PayoutRow({
  payout,
  ctx,
  inCoin = false,
}: Readonly<{ payout: RewardPayoutView; ctx: RowContext; inCoin?: boolean }>) {
  const href = ctx.href(payout.digest) ?? undefined;
  return (
    <a
      aria-label={payoutLabel(payout, ctx.nowMs, ctx.hidden, ctx.explorer)}
      className={clsx(styles.row, inCoin && styles.c)}
      href={href}
      rel="noopener noreferrer"
      target="_blank"
    >
      {inCoin ? null : (
        <CoinMark
          coin={{
            key: payout.sourceId,
            iconUrl: payout.iconUrl,
            round: false,
          }}
          size={40}
        />
      )}
      <span className={styles.t}>
        {inCoin ? (
          <b>Round {payout.round}</b>
        ) : (
          <b>
            {payout.name}{" "}
            <span className={styles.rd}>Round {payout.round}</span>
          </b>
        )}
        <span>{payoutSub(payout, ctx.nowMs)}</span>
      </span>
      <Amounts
        amounts={payout.amounts}
        hidden={ctx.hidden}
        quoteSymbol={payout.quoteSymbol}
        symbol={payout.symbol}
      />
      <ExternalIcon />
    </a>
  );
}

/** What a coin still owes (the gate's `rwWaitRow`). */
function WaitRow({
  coin,
  kind,
  amounts,
  ctx,
}: Readonly<{
  coin: RewardCoinView;
  kind: WaitKind;
  amounts: RewardAmountsView;
  ctx: RowContext;
}>) {
  return (
    <div className={styles.wait}>
      <ClockIcon />
      <span className={styles.t}>
        <b>
          Waiting{" "}
          <span className="num">
            {masked(
              amountsText(amounts, coin.symbol, coin.quoteSymbol),
              ctx.hidden,
            )}
          </span>
        </b>
        <span>{waitReason(kind)}</span>
      </span>
    </div>
  );
}


/** A coin's rounds, as the open panel draws them; the live page reads them, a fixture hands them over. */
export type CoinRounds = Readonly<{
  errorMessage?: string;
  pageError?: boolean;
  rows: readonly RewardPayoutView[];
  status: "loading" | "ready" | "error";
  /** More rounds than are drawn: the button shows. */
  more: boolean;
  loadingMore: boolean;
  loadMore: () => void;
  retry: () => void;
}>;

/** The rounds inside an open coin: five, then "Show 10 more"; new rows ease in, and the last batch takes the focus. */
function RoundsList({
  coin,
  rounds,
  ctx,
}: Readonly<{ coin: RewardCoinView; rounds: CoinRounds; ctx: RowContext }>) {
  const list = useRef<HTMLDivElement>(null);
  const before = useRef<number | null>(null);
  const left = coin.payouts - rounds.rows.length;
  useLayoutEffect(() => {
    const from = before.current;
    const el = list.current;
    if (from === null || !el || rounds.rows.length <= from) return;
    before.current = null;
    const added = Array.from(el.children).slice(from) as HTMLElement[];
    if (!instantFeedback()) {
      added.forEach((row, index) =>
        row.animate(
          [
            { opacity: 0, transform: "translateY(4px)" },
            { opacity: 1, transform: "none" },
          ],
          {
            duration: 220,
            delay: staggerDelay(index),
            easing: EASE_OUT,
            fill: "backwards",
          },
        ),
      );
    }
    if (!(rounds.more && left > 0)) added[0]?.focus({ preventScroll: true });
  }, [rounds.rows.length, rounds.more, left]);
  if (rounds.status === "error" && rounds.rows.length === 0) {
    return (
      <div role="alert">
        <p className={styles.panelNote}>{rounds.errorMessage ?? diagnosticMessage("Its rounds couldn’t load. Try again.")}</p>
        <Button className={styles.more} onClick={rounds.retry} size="sm">
          Try again
        </Button>
      </div>
    );
  }
  return (
    <>
      <div aria-busy={rounds.status === "loading" || rounds.loadingMore || undefined} className={styles.list} ref={list}>
        {rounds.rows.map((payout) => (
          <PayoutRow ctx={ctx} inCoin key={payout.key} payout={payout} />
        ))}
        {rounds.status === "loading" || rounds.loadingMore ? (
          <div aria-label="Loading payouts" role="status">
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
              .slice(0, Math.min(Math.max(left, 1), rounds.loadingMore ? RW_MORE : RW_PAGE_N))
              .map((slot) => <PayoutSkeleton key={slot} />)}
          </div>
        ) : null}
      </div>
      {rounds.pageError ? <p className={styles.panelNote} role="alert">More payouts couldn’t load. Try loading them again.</p> : null}
      {rounds.more && left > 0 ? (
        <Button
          className={styles.more}
          aria-busy={rounds.status === "loading" || rounds.loadingMore || undefined}
          disabled={rounds.status === "loading" || rounds.loadingMore}
          onClick={() => {
            before.current = rounds.rows.length;
            rounds.loadMore();
          }}
          size="sm"
        >
          {moreText(left)}
        </Button>
      ) : null}
    </>
  );
}

/**
 * One coin, collapsed (the gate's `rwCoinHTML`): mark, name, last payout and
 * rounds, what it paid; it reveals what it still owes, what it paid
 * in all and its rounds with the shared collapse transition; none of the motion
 * under reduced motion.
 */
export function CoinGroup({
  showHistorySummary = true,
  coin,
  ctx,
  open,
  onToggle,
  Rounds,
}: Readonly<{
  coin: RewardCoinView;
  showHistorySummary?: boolean;
  ctx: RowContext;
  open: boolean;
  onToggle: (open: boolean) => void;
  Rounds: (
    props: Readonly<{
      coin: RewardCoinView;
      open: boolean;
      ctx: RowContext;
      children: (rounds: CoinRounds) => ReactNode;
    }>,
  ) => ReactNode;
}>) {
  // Keep histories lazy initially, then retain them through closing and reopening.
  const [hasOpened, setHasOpened] = useState(open);
  if (open && !hasOpened) setHasOpened(true);
  const value = coinValue(coin, ctx.hidden);
  const id = `rwp-${coin.sourceId}`;
  const toggle = () => onToggle(!open);
  return (
    <div className={styles.coin} data-list-row={coin.sourceId}>
      <DisclosureButton
        aria-controls={id}
        aria-expanded={open}
        className={clsx(styles.row, styles.head)}
        onClick={toggle}
        variant="ghost"
      >
        <CoinMark
          coin={{ key: coin.sourceId, iconUrl: coin.iconUrl, round: false }}
          size={40}
        />
        <span className={styles.t}>
          <b>{coin.name}</b>
          {showHistorySummary ? <span>{coinSub(coin, ctx.nowMs)}</span> : null}
        </span>
        <span className={styles.v}>
          <b aria-label={ctx.hidden ? undefined : exactAmountsText(coin.received, coin.symbol, coin.quoteSymbol)} className="num" title={ctx.hidden ? undefined : exactAmountsText(coin.received, coin.symbol, coin.quoteSymbol)}>{value.top}</b>
          {value.bottom ? <span className={clsx("num", styles.muted)}>{value.bottom}</span> : null}
        </span>
      </DisclosureButton>
      <Collapse aria-label={`${coin.name} rewards`} id={id} open={open} role="region">
        <div className={styles.panel}>
        {WAIT_KINDS.map((kind) => {
          const amounts = coin.waiting[kind];
          return amounts ? (
            <WaitRow
              amounts={amounts}
              coin={coin}
              ctx={ctx}
              key={kind}
              kind={kind}
            />
          ) : null;
        })}
        <Rounds coin={coin} ctx={ctx} open={open}>
          {(rounds) => open || hasOpened ? <RoundsList coin={coin} ctx={ctx} rounds={rounds} /> : null}
        </Rounds>
        </div>
      </Collapse>
    </div>
  );
}

/* ---------------- the page's summary, states and the tab ---------------- */

/** What came in, and the most recent payout once there is one (the gate's `rwSummaryHTML`). */
export function SummaryFigures({
  coins,
  last,
  nowMs,
  hidden,
}: Readonly<{
  coins: readonly RewardCoinView[];
  last: RewardPayoutView | null;
  nowMs: number;
  hidden: boolean;
}>) {
  return (
    <div className={styles.figs}>
      <div className={styles.fig}>
        <span>Received</span>
        <b className="num">{masked(grandText(coins), hidden)}</b>
        <em>{anyUsd(coins) ? "At today’s prices" : "Prices not known yet"}</em>
      </div>
      {last ? (
        <div className={styles.fig}>
          <span>Last payout</span>
          <b>{whenText(last.atMs, nowMs)}</b>
          <em>{`${last.name} · Round ${last.round}`}</em>
        </div>
      ) : null}
    </div>
  );
}

/** No payouts yet (the gate's `rwEmptyHTML`). */
export function RewardsEmpty() {
  return (
    <EmptyState action={<Link className="btn btn-line" href={HOME_PATH}>See what’s trending</Link>} title="No rewards yet" />
  );
}

/** The read failed: the payouts themselves are safe, only the page could not read them. */
export function RewardsFailed({
  onRetry,
  card = true,
  message,
}: Readonly<{ onRetry: () => void; card?: boolean; message?: string }>) {
  return (
    <EmptyState action={<Button onClick={onRetry}>Try again</Button>} framed={card} role="alert" title="Couldn’t load your rewards">
      {message ?? diagnosticMessage("Your payouts are safe in your wallet. This page could not read them right now. Try again.")}
    </EmptyState>
  );
}

/** Signed out: the page asks to sign in. */
export function RewardsSignedOut({ signIn }: Readonly<{ signIn: ReactNode }>) {
  return <EmptyState action={signIn} framed title="Sign in to see your rewards" />;
}

/* ---------------- right column ---------------- */

/** Portfolio's side card (the gate's `rwSideHTML`): what came in, the last payout, the next one, and the way to all of them. Nothing until there is a payout. */
export function RewardsSideCard({
  coins,
  latest,
  ctx,
}: Readonly<{
  coins: readonly RewardCoinView[];
  latest: readonly RewardPayoutView[];
  ctx: RowContext;
}>) {
  const last = latest[0];
  if (!last || coins.length === 0) return null;
  const amounts = masked(
    amountsText(last.amounts, last.symbol, last.quoteSymbol),
    ctx.hidden,
  );
  const headline = rewardsHeadline(coins);
  const payouts = coins.reduce((sum, coin) => sum + coin.payouts, 0);
  return (
    <section
      aria-labelledby="rewards-side-heading"
      className={clsx("card", styles.side)}
      data-aside-card=""
    >
      <h3 className={styles.sideH} id="rewards-side-heading">Rewards</h3>
      <span className={clsx(styles.sideFig, "num")} title={headline.priced ? "Received, at today’s prices" : undefined}>
        {masked(headline.figure, ctx.hidden)}
      </span>
      <span className={styles.sideSub}>
        {["Received", `${payouts.toLocaleString("en-US")} ${payouts === 1 ? "payout" : "payouts"}`, ...headline.rest.map((part) => masked(part, ctx.hidden))].join(" · ")}
      </span>
      <a
        aria-label={`Last payout: ${last.name}, round ${last.round}, ${amounts}, ${whenText(last.atMs, ctx.nowMs)}. Opens the transaction`}
        className={styles.sideLast}
        href={ctx.href(last.digest) ?? undefined}
        rel="noopener noreferrer"
        target="_blank"
      >
        <CoinMark
          coin={{ key: last.sourceId, iconUrl: last.iconUrl, round: false }}
          size={34}
        />
        <span className={styles.sideT}>
          <b className="num">{amounts}</b>
          <span>
            Last payout · {last.name} · {whenText(last.atMs, ctx.nowMs)}
          </span>
        </span>
      </a>
      {relayOwed(coins) ? (
        <div className={styles.sideNext}>
          <ClockIcon />
          <span>Queued for automatic delivery</span>
        </div>
      ) : null}
      <Link className={styles.see} href={CLAIMS_PATH}>
        Open rewards
        <ChevIcon />
      </Link>
    </section>
  );
}
