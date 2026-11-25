"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import {
  Sheet,
  SheetClose,
  SheetCta,
  SheetHeading,
} from "#web/components/blast-ui/Sheet.tsx";
import { AlertCircleIcon } from "#web/components/blast-ui/Icons.tsx";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import { EXPLORER_NAMES, explorerTransactionUrl } from "@blast/core/lib/explorer.ts";
import type {
  PublicVesting,
  VestingAttempt,
} from "@blast/core/modules/vesting/model.ts";
import { vestingFeedbackId } from "#web/components/social/portfolio/portfolio-model.ts";
import { TokenAmount, Identifier } from "./DetailValues";
import { overviewSchedule } from "./overview-model";
import { useVestingWallet } from "./use-vesting-wallet";
import { VestingReviewRequiredError } from "./vesting-errors";
import { isSignatureRefusal } from "#web/lib/sui-signing.ts";
import styles from "./VestingOverview.module.css";

/** Public schedules use the utility vesting review flow, including its recorded-digest recovery. */
export function useOverviewClaim(
  nowMs: number,
  refresh: () => Promise<unknown>,
  restoreFocus: () => void,
  inlineFeedback: boolean,
) {
  const wallet = useVestingWallet();
  const toast = useToast();
  const { explorer } = useDevicePrefs();
  const heading = useId();
  const lock = useRef(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [schedule, setSchedule] = useState<PublicVesting | null>(null);
  const [attempt, setAttempt] = useState<VestingAttempt | null>(null);
  const [working, setWorking] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [completed, setCompleted] = useState<Record<string, string>>({});
  const view = schedule ? overviewSchedule(schedule, nowMs, false) : null;
  const href = attempt
    ? explorerTransactionUrl(explorer, attempt.digest)
    : null;

  async function prepare(target: PublicVesting) {
    if (lock.current || wallet.busy) return;
    lock.current = true;
    setWorking(true);
    setError(null);
    setAttempt(null);
    setSubmitted(false);
    await wallet
      .prepare({ action: "claim", scheduleId: target.schedule_id })
      .then(setAttempt)
      .catch((cause: unknown) =>
        setError(
          cause instanceof Error
            ? cause.message
            : "Unable to prepare this claim. Please retry.",
        ),
      )
      .finally(() => {
        lock.current = false;
        setWorking(false);
      });
  }

  function start(target: PublicVesting, button: HTMLButtonElement) {
    if (lock.current || wallet.busy || wallet.wallet !== target.beneficiary)
      return;
    if (schedule && schedule.schedule_id !== target.schedule_id) return;
    trigger.current = button;
    setReviewOpen(true);
    if (schedule) return;
    setSchedule(target);
    void prepare(target);
  }

  async function confirm() {
    if (
      !attempt ||
      !schedule ||
      lock.current ||
      wallet.busy ||
      wallet.wallet !== schedule.beneficiary
    )
      return;
    lock.current = true;
    setWorking(true);
    setError(null);
    setSubmitted(true);
    const execution = submitted
      ? wallet.refresh(attempt)
      : wallet.execute(attempt);
    await execution
      .then((result) => {
        if (result.state === "submitted") return;
        if (result.state === "failed") {
          setAttempt(null);
          setSubmitted(false);
          setError(
            "The claim failed. No vesting payout was made. Network gas may still have been charged. Retry to review a new claim.",
          );
          return;
        }
        setCompleted((previous) => ({
          ...previous,
          [schedule.schedule_id]: schedule.released,
        }));
        setReviewOpen(false);
        setSchedule(null);
        setAttempt(null);
        setSubmitted(false);
        const transaction = explorerTransactionUrl(explorer, result.digest);
        toast("Vested coins claimed", {
          sub: `${view?.name ?? "Vesting"} · balances update when the claim is indexed`,
          href: transaction ?? undefined,
          link: `View on ${EXPLORER_NAMES[explorer]}`,
          mobileTargetId: inlineFeedback ? vestingFeedbackId(schedule.schedule_id) : undefined,
        });
        void refresh().catch(() => undefined);
      })
      .catch((cause: unknown) => {
        if (cause instanceof VestingReviewRequiredError) {
          setAttempt(null);
          setSubmitted(false);
          setError(cause.message);
        } else if (isSignatureRefusal(cause)) {
          setSubmitted(false);
          setError(
            "You rejected the claim in your wallet. Nothing was sent. Retry when you’re ready.",
          );
        } else
          setError(
            cause instanceof Error
              ? cause.message
              : "Unable to confirm this claim. Check its status before retrying.",
          );
      })
      .finally(() => {
        lock.current = false;
        setWorking(false);
      });
  }

  const busy = working || wallet.busy;
  function close() {
    if (busy) return;
    setReviewOpen(false);
    if (!submitted) setSchedule(null);
  }
  return {
    wallet,
    start,
    active: reviewOpen,
    pending: submitted,
    busy,
    scheduleId: schedule?.schedule_id,
    awaitingIndex: (target: PublicVesting) =>
      completed[target.schedule_id] === target.released,
    node: (
      <OverviewClaimReview
        walletNode={wallet.node}
        open={reviewOpen}
        close={close}
        onClosed={() => {
          if (document.querySelector('[aria-modal="true"]')) return;
          if (trigger.current?.isConnected && !trigger.current.disabled)
            trigger.current.focus({ preventScroll: true });
          else restoreFocus();
        }}
        heading={heading}
        schedule={schedule}
        view={view}
        attempt={attempt}
        href={href}
        explorer={EXPLORER_NAMES[explorer]}
        submitted={submitted}
        error={error}
        busy={busy}
        phase={wallet.phase}
        walletAddress={wallet.wallet}
        retry={() => {
          if (schedule) void prepare(schedule);
        }}
        confirm={() => void confirm()}
      />
    ),
  };
}

function OverviewClaimReview({
  walletNode,
  open,
  close,
  onClosed,
  heading,
  schedule,
  view,
  attempt,
  href,
  explorer,
  submitted,
  error,
  busy,
  phase,
  walletAddress,
  retry,
  confirm,
}: Readonly<{
  walletNode: ReactNode;
  open: boolean;
  close: () => void;
  onClosed: () => void;
  heading: string;
  schedule: PublicVesting | null;
  view: ReturnType<typeof overviewSchedule> | null;
  attempt: VestingAttempt | null;
  href: string | null;
  explorer: string;
  submitted: boolean;
  error: string | null;
  busy: boolean;
  phase: string;
  walletAddress: string | null;
  retry: () => void;
  confirm: () => void;
}>) {
  const label = claimReviewLabel(attempt, error, submitted);
  return (
    <>
      {walletNode}
      <Sheet
        open={open}
        onRequestClose={close}
        onClosed={onClosed}
        labelledBy={heading}
        hasCta
      >
        <SheetClose onClick={close} />
        <SheetHeading
          id={heading}
          title="Review vesting claim"
          lead={view?.name}
        />
        {schedule && view ? (
          <div className={styles.claimReview}>
            <ClaimReviewFacts
              schedule={schedule}
              view={view}
              attempt={attempt}
            />
            <p>
              The contract pays the beneficiary on Sui mainnet. The payout may
              increase as more tokens vest before execution.
            </p>
            {submitted && attempt ? (
              <p role="status">
                Check the original transaction before retrying.
                {href ? (
                  <>
                    {" "}
                    <a href={href} target="_blank" rel="noreferrer">
                      View on {explorer} ↗
                    </a>
                  </>
                ) : null}
              </p>
            ) : null}
            {error ? (
              <p role="alert" className={styles.claimError}>
                <AlertCircleIcon />
                <span>{error}</span>
              </p>
            ) : null}
          </div>
        ) : null}
        <SheetCta>
          <button
            className="btn btn-primary"
            disabled={
              busy ||
              (!attempt && !error) ||
              walletAddress !== schedule?.beneficiary
            }
            onClick={attempt ? confirm : retry}
            type="button"
          >
            <LoadingIndicator
              loading={busy}
              label={phase === "idle" ? "Preparing claim" : phase}
            >
              {label}
            </LoadingIndicator>
          </button>
        </SheetCta>
      </Sheet>
    </>
  );
}

function claimReviewLabel(
  attempt: VestingAttempt | null,
  error: string | null,
  submitted: boolean,
) {
  if (!attempt && error) return "Retry";
  if (submitted) return "Check transaction status";
  return error ? "Retry in wallet" : "Confirm in wallet";
}

function ClaimReviewFacts({
  schedule,
  view,
  attempt,
}: Readonly<{
  schedule: PublicVesting;
  view: ReturnType<typeof overviewSchedule>;
  attempt: VestingAttempt | null;
}>) {
  return (
    <dl className={styles.reviewFacts}>
      <div>
        <dt>Available to beneficiary</dt>
        <dd>
          {view.balances.available === undefined ? (
            "—"
          ) : (
            <TokenAmount
              value={view.balances.available}
              decimals={schedule.coin_decimals}
              symbol={view.symbol}
              label="beneficiary payout"
              compact={false}
            />
          )}
        </dd>
      </div>
      <div>
        <dt>Beneficiary</dt>
        <dd>
          <Identifier
            value={schedule.beneficiary}
            label="beneficiary address"
          />
        </dd>
      </div>
      <div>
        <dt>Schedule</dt>
        <dd>
          <Identifier value={schedule.schedule_id} label="schedule ID" />
        </dd>
      </div>
      {attempt ? (
        <div>
          <dt>Maximum network gas</dt>
          <dd>
            <TokenAmount
              value={attempt.gas_budget}
              decimals={9}
              symbol="SUI"
              label="maximum network gas"
              compact={false}
            />
            {attempt.sponsor_reservation_id
              ? " · Paid by Blast"
              : " · Paid by your wallet"}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}
