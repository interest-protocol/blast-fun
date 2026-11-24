"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Sheet, SheetClose, SheetHeading, SheetCta } from "#web/components/blast-ui/Sheet.tsx";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { usePhoneLayout } from "#web/components/blast-ui/use-shell-prefs.ts";
import type { WalletCoinView } from "#web/components/social/coins/coin-model.ts";
import { isContinuousLinear, formatVestingAmount, type CreateVesting, type VestingAttempt } from "@blast/core/modules/vesting/model.ts";
import { linearReleaseSummary } from "./creation-model";
import { reviewVestingAmount } from "./creation-display";
import { releaseInterval, vestingDate } from "./schedule-display";
import { ReviewIdentifier } from "./ReviewIdentifier";
import { ReviewDisclosure } from "./ReviewDisclosure";
import { VestingChart } from "./VestingChart";
import styles from "./CreationReview.module.css";

export type CreationReviewState = Readonly<{
  intent: CreateVesting;
  attempt: VestingAttempt;
  coin: WalletCoinView;
  timezone: string;
  sender: string | null;
}>;

export function CreationReview({ review, setReview, wallet, confirm, error, pending = false }: Readonly<{
  review: CreationReviewState | null;
  setReview: (value: CreationReviewState | null) => void;
  wallet: Readonly<{ busy: boolean; phase: string }>;
  confirm: () => Promise<void>;
  error: string | null;
  pending?: boolean;
}>) {
  const confirming = useRef(false);
  async function create() {
    if (confirming.current || wallet.busy) return;
    confirming.current = true;
    await confirm().finally(() => { confirming.current = false; });
  }
  return (
    <Sheet open={review !== null} className={styles.modal} labelledBy="create-vesting-review" hasCta
      onRequestClose={() => { if (!wallet.busy) setReview(null); }}
      onClosed={() => document.getElementById("vesting-review")?.focus({ preventScroll: true })}>
      <SheetClose disabled={wallet.busy} onClick={() => setReview(null)} />
      <SheetHeading id="create-vesting-review" title="Review vesting"
        lead="Recipient and schedule cannot be changed." />
      {review ? <ReviewBody review={review} /> : null}
      <SheetCta className={styles.footer}>
        {review ? <div className={styles.gas}>
          <span>Maximum network gas</span>
          <span>{formatVestingAmount(review.attempt.gas_budget, 9)} SUI
            <small>{review.attempt.sponsor_reservation_id ? "Paid by Blast" : "Paid from your wallet"}</small>
          </span>
        </div> : null}
        {pending && review ? <p role="status">Submitted. Awaiting confirmation. <a href={`https://suiscan.xyz/mainnet/tx/${review.attempt.digest}`} target="_blank" rel="noreferrer">View original transaction</a></p> : null}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}
        <button className="btn btn-primary" disabled={wallet.busy} onClick={() => void create()} type="button">
          <LoadingIndicator label={wallet.phase} loading={wallet.busy}>{pending ? "Check transaction status" : "Create vesting in wallet"}</LoadingIndicator>
        </button>
      </SheetCta>
    </Sheet>
  );
}

function ReviewBody({ review }: Readonly<{ review: CreationReviewState }>) {
  const phone = usePhoneLayout();
  const { coin, intent } = review;
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [more, setMore] = useState(false);
  function updateScrollHint() {
    const node = scroller.current;
    if (node) setMore(node.scrollHeight - node.clientHeight - node.scrollTop > 2);
  }
  useEffect(() => {
    const observer = new ResizeObserver(updateScrollHint);
    if (scroller.current) observer.observe(scroller.current);
    if (content.current) observer.observe(content.current);
    return () => observer.disconnect();
  }, []);
  const decimals = coin.metadataAvailable === false ? null : coin.decimals;
  return <div className={styles.bodyFrame}><div className={styles.body} ref={scroller} onScroll={updateScrollHint} tabIndex={0} role="region" aria-label="Vesting review details">
    <div className={styles.content} ref={content}>
    <div className={styles.asset}>
      <div className={styles.coinIdentity}>
        <CoinMark coin={coin} size={44} />
        <div><strong>{coin.symbol}</strong>{coin.name !== coin.symbol ? <span>{coin.name}</span> : null}</div>
      </div>
      <p className={styles.amount}>{reviewVestingAmount(intent.total, decimals)} <span className={styles.amountSymbol}>{coin.symbol}</span></p>
      <p className={styles.muted}>Locked in full at creation</p>
    </div>
    <div className={styles.identifiers}>
      <ReviewIdentifier label="Coin type" value={intent.coinType} coinType />
      <ReviewIdentifier label="Recipient wallet" value={intent.beneficiary} />
    </div>
    <section className={styles.section} aria-labelledby="review-schedule-title">
      <div className={styles.sectionHeading}><h3 id="review-schedule-title">Release schedule</h3><span>UTC</span></div>
      {intent.schedule.kind === "linear"
        ? <LinearSchedule schedule={intent.schedule} total={intent.total} />
        : <CustomSchedule schedule={intent.schedule} coin={coin} />}
      {phone ? <ReviewDisclosure label="Schedule preview">
        <VestingChart schedule={{ terms: intent.schedule, total: intent.total }} />
      </ReviewDisclosure> : null}
    </section>
    <section className={styles.section} aria-labelledby="review-cancellation-title">
      <div className={styles.sectionHeading}><h3 id="review-cancellation-title">Cancellation</h3>
        <span className={styles.cancellation}>{intent.refundRecipient ? "Allowed" : "Irrevocable"}</span>
      </div>
      {intent.refundRecipient ? <>
        <div className={styles.identifiers}>
          <ReviewIdentifier label="Refund wallet" value={intent.refundRecipient} />
          <ReviewIdentifier label="Who can cancel" value={intent.cancelCapRecipient!} />
        </div>
        <p className={styles.muted}>Unclaimed vested funds go to the recipient; unvested funds return to the refund wallet.</p>
        <ReviewDisclosure label="How cancellation authority works">
          <p>Cancellation authority transfers with the CancelCap. The refund wallet stays fixed; claimed funds stay with the recipient.</p>
        </ReviewDisclosure>
      </> : <p className={styles.muted}>Nobody can cancel this schedule after creation.</p>}
    </section>
    </div>
  </div><span className={styles.scrollHint}>{more ? "Scroll for more details ↓" : "All details shown"}</span></div>;
}

function ScheduleRow({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return <div className={styles.scheduleRow}><dt>{label}</dt><dd>{children}</dd></div>;
}

function LinearSchedule({ schedule, total }: Readonly<{
  schedule: Extract<CreateVesting["schedule"], { kind: "linear" }>;
  total: string;
}>) {
  const summary = linearReleaseSummary(schedule, BigInt(total));
  const continuous = isContinuousLinear(schedule);
  const single = summary.first === summary.final;
  const dates: (readonly [string, string | bigint])[] = [["Start", schedule.start_ms], [continuous ? "First claimable" : single ? "Release date" : "First release", summary.first]];
  if (BigInt(schedule.cliff_ms) > BigInt(0)) dates.push(["Cliff ends", summary.cliffEnd]);
  return <div className={styles.scheduleGroup}>
    <dl className={styles.schedule}>
      {dates.map(([label, value]) => <ScheduleRow key={label} label={label}>{vestingDate(value)}</ScheduleRow>)}
      <ScheduleRow label="Schedule">{continuous ? "Linear · continuous" : single ? "1 release" : `${steppedReleaseCount(schedule, BigInt(total))} releases · every ${releaseInterval(schedule.period_ms)}`}</ScheduleRow>
      {continuous || !single ? <ScheduleRow label={continuous ? "Fully vested" : "Final release"}>{vestingDate(summary.final)}</ScheduleRow> : null}
    </dl>
  </div>;
}

// Preserve historical stepped release counts, including cliff catch-up and zero-atom steps.
function steppedReleaseCount(schedule: Extract<CreateVesting["schedule"], { kind: "linear" }>, total: bigint) {
  const periods = BigInt(schedule.periods);
  const stepsAtCliff = BigInt(schedule.cliff_ms) / BigInt(schedule.period_ms);
  const nonzeroSteps = total < periods ? total : periods;
  const combinedSteps = total < periods ? (total * stepsAtCliff) / periods : stepsAtCliff;
  const cliffHasFunds = (total * stepsAtCliff) / periods > 0n;
  return nonzeroSteps - combinedSteps + (cliffHasFunds ? 1n : 0n);
}

function CustomSchedule({ schedule, coin }: Readonly<{
  schedule: Extract<CreateVesting["schedule"], { kind: "checkpoints" }>;
  coin: WalletCoinView;
}>) {
  const dates = schedule.checkpoints.map((point, index) => [`Release ${index + 1}`, point.timestamp_ms] as const);
  return <div className={styles.scheduleGroup}>
    <p className={styles.customCount}>{dates.length} custom {dates.length === 1 ? "release" : "releases"}</p>
    <dl className={styles.schedule}>
      {schedule.checkpoints.map((point, index, checkpoints) => <ScheduleRow key={point.timestamp_ms} label={vestingDate(point.timestamp_ms)}>
        {reviewVestingAmount(BigInt(point.cumulative_amount) - BigInt(checkpoints[index - 1]?.cumulative_amount ?? 0), coin.metadataAvailable === false ? null : coin.decimals)} {coin.symbol}
      </ScheduleRow>)}
    </dl>

  </div>;
}
