"use client";

import { TransactionLink } from "#web/components/blast-ui/TransactionLink.tsx";
import { pollInterval } from "#web/lib/query/polling.ts";
import { vestingEligibilitySchema } from "@blast/core/modules/vesting/responses.ts";

import { VestingCapabilityUnavailable, retryVestingRead } from "./read-availability";

import { VestingSubmissionPendingError, VestingReviewRequiredError } from "./vesting-errors";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { Disclosure } from "#web/components/blast-ui/Disclosure.tsx";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { SkeletonLine } from "#web/components/blast-ui/Skeleton.tsx";
import { usePhoneLayout } from "#web/components/blast-ui/use-shell-prefs.ts";
import { useQuery } from "@tanstack/react-query";
import { useCommitClock } from "#web/components/social/commit/commit-clock.ts";
import { useBoundaryClock } from "#web/components/social/use-boundary-clock.ts";
import { GatedAction } from "#web/components/social/SignInGate.tsx";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import {
  Sheet,
  SheetCta,
  SheetHeading,
} from "#web/components/blast-ui/Sheet.tsx";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { callSocialApi } from "#web/components/social/social-api.ts";
import { gatedFetch } from "#web/lib/api-gate-client.ts";
import {
  formatVestingAmount,
  vestingAmounts,
  type VestingAttempt,
  type PublicVesting,
  type VestingDetail as Detail,
  type VestingIntent,
} from "@blast/core/modules/vesting/model.ts";
import { useVestingWallet } from "./use-vesting-wallet";
import { useVestingAccountState, vestingAccountKey } from "./use-account-state";
import { VestingShare } from "./parts";
import { scheduleBounds, releaseInterval } from "./schedule-display";
import { Identifier, TokenAmount, ExactDate } from "./DetailValues";
import {
  releaseAfter,
  isContinuousSchedule,
  scheduleState,
} from "./detail-schedule";
import detailStyles from "./VestingDetail.module.css";
import { DetailChart } from "./DetailChart";
import { reportVestingAction } from "./feedback";
import styles from "./Vesting.module.css";

/** The chart's "now" dot moves on at least this often. */
const VIEW_STEP_MS = 60_000;

/**
 * When the page's figures next change: the schedule's next release, at most
 * a minute away; never once it has ended. A continuous schedule turns at its
 * first unlock and at its end; in between only its amounts move, and they
 * tick by themselves (`useLiveAmounts`).
 */
function nextChange(schedule: PublicVesting, nowMs: number): number | null {
  if (schedule.status !== "active") return null;
  const now = BigInt(nowMs);
  const next = releaseAfter(schedule, now);
  if (!next) return null;
  const bounds = scheduleBounds(schedule.terms);
  const vesting = isContinuousSchedule(schedule) && bounds !== null && (vestingAmounts(schedule, now)?.vested ?? BigInt(0)) > BigInt(0);
  return Math.min(Number(vesting ? bounds[1] : next.time), nowMs + VIEW_STEP_MS);
}

function useDetailView({ initial }: Readonly<{ initial: Detail }>) {
  const wallet = useVestingWallet(),
    toast = useToast();
  const owner = vestingAccountKey(wallet.viewer, wallet.wallet);
  const currentOwner = useRef(owner);
  useLayoutEffect(() => { currentOwner.current = owner; }, [owner]);
  const [error, setError] = useVestingAccountState<string | null>(owner, null),
    [preparing, setPreparing] = useVestingAccountState<Exclude<
      VestingIntent["action"],
      "create"
    > | null>(owner, null),
    [attempt, setAttempt] = useVestingAccountState<VestingAttempt | null>(owner, null);
  const actionTrigger = useRef<HTMLElement | null>(null);
  const [submitted, setSubmitted] = useVestingAccountState(owner, false);
  const [reviewOpen, setReviewOpen] = useVestingAccountState(owner, false);
  const [checking, setChecking] = useVestingAccountState(owner, false);
  const read = useQuery({
    queryKey: ["vesting", initial.schedule.schedule_id],
    initialData: initial,
    queryFn: async () => {
      const response = await gatedFetch(
        `/api/vesting/${initial.schedule.schedule_id}`,
      );
      if (!response.ok) throw new Error("Unable to refresh schedule");
      return (await response.json()) as Detail;
    },
    refetchInterval: (query) => pollInterval(15_000, query),
  });
  const eligibility = useQuery({
    queryKey: [
      "blast",
      "me",
      "vesting-eligibility",
      initial.schedule.schedule_id,
      wallet.wallet,
      wallet.viewer.sessionIdentity ?? null,
    ],
    enabled: wallet.viewer.signedIn && !wallet.viewer.sessionPending && !wallet.walletLoading && !wallet.walletError && !!wallet.wallet,
    queryFn: async ({ signal }) => {
      const response = await callSocialApi(
        { getAccessToken: wallet.viewer.getAccessToken ?? (async () => null), signal },
        `/api/social/me/vesting?schedule_id=${initial.schedule.schedule_id}`,
        { method: "GET" },
        vestingEligibilitySchema,
      );
      if (response.status === "refused" && response.reasons?.includes("vesting_authority_unavailable"))
        throw new VestingCapabilityUnavailable("Cancellation-key indexing is unavailable. This schedule is readable, but cancellation authority cannot be verified yet.");
      if (response.status !== "ok")
        throw new Error("Unable to check cancellation capability");
      return response.body.can_cancel;
    },
    retry: retryVestingRead,
    refetchInterval: (query) => query.state.error instanceof VestingCapabilityUnavailable ? false : pollInterval(15_000, query),
    refetchOnWindowFocus: (query) => !(query.state.error instanceof VestingCapabilityUnavailable),
  });
  const schedule = read.data.schedule;
  const clock = useBoundaryClock((at) => nextChange(schedule, at), initial.now_ms);
  const now = BigInt(clock),
    amounts = vestingAmounts(schedule, now),
    bounds = scheduleBounds(schedule.terms);
  const symbol =
    schedule.coin_symbol ?? schedule.coin_type.split("::").at(-1) ?? "coin";
  const next =
    schedule.status === "active" ? releaseAfter(schedule, now) : null;
  async function prepare(action: VestingIntent["action"]) {
    if (action === "create") return;
    actionTrigger.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (submitted && attempt) { setReviewOpen(true); return; }
    setError(null);
    setSubmitted(false);
    setPreparing(action);
    await reportVestingAction(
      async () => {
        setAttempt(
          await wallet.prepare({ action, scheduleId: schedule.schedule_id }),
        );
        setReviewOpen(true);
      },
      setError,
      () => setPreparing(null),
    );
  }
  async function confirm() {
    if (!attempt || wallet.viewer.sessionPending || !wallet.viewer.signedIn) return;
    if (!submitted && (wallet.walletLoading || wallet.walletError || !wallet.wallet)) return;
    setError(null);
    setChecking(true);
    await reportVestingAction(
      async () => {
        const result = submitted
          ? await wallet.refresh(attempt)
          : await wallet.execute(attempt).catch((caught: unknown) => {
              if (caught instanceof VestingSubmissionPendingError) setSubmitted(true);
              if (caught instanceof VestingReviewRequiredError) {
                setSubmitted(false);
                setAttempt(null);
              }
              throw caught;
            });
        setSubmitted(true);
        if (result.state === "submitted") return;
        if (result.state === "failed") {
          setAttempt(null);
          setSubmitted(false);
          throw new Error(
            "The transaction failed. No vesting payout was made. Network gas may still have been charged.",
          );
        }
        setAttempt(null);
        if (currentOwner.current !== owner) return;
        toast(
          attempt.action === "claim"
            ? "Vested coins claimed"
            : attempt.action === "cancel"
              ? "Vesting canceled"
              : "Schedule closed",
          { href: `https://suiscan.xyz/mainnet/tx/${result.digest}` },
        );
        await Promise.all([read.refetch(), eligibility.refetch()]);
      },
      (caught) => setError(caught),
      () => setChecking(false),
    );
  }
  const view = {
    schedule,
    amounts,
    symbol,
    bounds,
    now,
    next,
    wallet,
    preparing,
    prepare,
    eligibility,
    read,
    error,
    submitted,
    reviewOpen,
    setReviewOpen,
    checking,
    attempt,
    setAttempt,
    actionTrigger,
    confirm,
  };
  return { ...view, initial };
}
type DetailView = ReturnType<typeof useDetailView>;

/**
 * The amounts to the second while a continuous schedule vests (money: as
 * fresh as the page-wide second clock left them), read where they show;
 * otherwise the page's, which turns at each release.
 */
function useLiveAmounts({ schedule, amounts, now }: DetailView): DetailView["amounts"] {
  const live = schedule.status === "active" && isContinuousSchedule(schedule) && amounts !== null && amounts.vested > BigInt(0) && amounts.unvested > BigInt(0);
  const tick = useCommitClock(live);
  return live && BigInt(tick) > now ? vestingAmounts(schedule, BigInt(tick)) : amounts;
}

/** One of the schedule's amounts, redrawn by itself while it vests continuously. */
function LiveAmount({ view, part, label, compact }: Readonly<{
  view: DetailView;
  part: "releasable" | "unvested";
  label: string;
  compact?: boolean;
}>) {
  const amounts = useLiveAmounts(view);
  return amounts ? <DisplayAmount view={view} value={amounts[part]} label={label} compact={compact} /> : null;
}

export function VestingDetail(props: Readonly<{ initial: Detail }>) {
  const view = useDetailView(props);
  const { schedule, symbol, wallet } = view;
  return (
    <div className={`${styles.page} ${detailStyles.page}`}>
      <header className={detailStyles.header}>
        <div className={styles.identity}>
          <span className={styles.coinMark}><CoinMark
            coin={{
              key: schedule.coin_type,
              coinType: schedule.coin_type,
              symbol,
              iconUrl: schedule.coin_icon_url,
              round: false,
            }}
            size={44}
          /></span>
          <div>
            <h1>{schedule.coin_name ?? symbol} vesting</h1>
            <p>
              {isContinuousSchedule(schedule)
                ? "Continuous linear vesting"
                : schedule.terms.kind === "linear"
                  ? `Every ${releaseInterval(schedule.terms.period_ms)} · ${schedule.terms.periods} releases`
                  : "Custom release dates"}
            </p>
          </div>
        </div>
        <div className={detailStyles.headerActions}>
          <VestingShare id={schedule.schedule_id} />
          {view.submitted && view.attempt && !view.reviewOpen ? (
            <Button
              variant="primary"
              type="button"
              onClick={() => void view.prepare(view.attempt!.action)}
            >
              Check transaction status
            </Button>
          ) : null}
        </div>
      </header>
      <div className={detailStyles.layout}>
        <ScheduleOverview view={view} />
        <aside
          className={detailStyles.sidebar}
          aria-label="Recipients and schedule details"
        >
          <ScheduleDetails view={view} />
        </aside>
        <Activity view={view} />
      </div>
      <ActionReview view={view} />
      {wallet.node}
    </div>
  );
}

function DisplayAmount({
  view,
  value,
  label,
  compact = true,
}: Readonly<{
  view: DetailView;
  value: bigint | string;
  label: string;
  compact?: boolean | "readable";
}>) {
  return (
    <TokenAmount
      value={value}
      decimals={view.schedule.coin_decimals}
      symbol={view.symbol}
      label={label}
      compact={compact}
    />
  );
}

function NextUnlock({ view }: Readonly<{ view: DetailView }>) {
  const { schedule, amounts, bounds, next } = view;
  if (schedule.status !== "active") return null;
  const complete = amounts?.unvested === BigInt(0);
  return (
    <div className={detailStyles.timeline}>
      {complete && bounds ? (
        <>
          <span>Completed</span>
          <ExactDate value={bounds[1]} />
        </>
      ) : next ? (
        <>
          <span>
            {isContinuousSchedule(schedule) ? "Fully unlocks" : "Next release"}
          </span>
          <ExactDate
            value={
              isContinuousSchedule(schedule) && bounds ? bounds[1] : next.time
            }
          />
          {!isContinuousSchedule(schedule) ? (
            <DisplayAmount
              view={view}
              value={next.amount}
              label="next release amount"
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ScheduleOverview({ view }: Readonly<{ view: DetailView }>) {
  const phone = usePhoneLayout();
  const { schedule, amounts } = view;
  return (
    <section className={detailStyles.overview}>
      <div className={detailStyles.overviewTop}>
        <div className={`card ${styles.panel} ${detailStyles.claimPane}`}>
          <div className={detailStyles.currentState}>
            <span className={detailStyles.statusDot} aria-hidden="true" />
            <h2>
              {scheduleState(schedule, view.now).replace(
                " · claim available",
                "",
              )}
            </h2>
          </div>
          <VestingActions phone={phone} view={view} />
          <dl className={detailStyles.balances}>
            <div>
              <dt>
                {schedule.status === "canceled"
                  ? "Paid to beneficiary"
                  : "Claimed"}
              </dt>
              <dd>
                <DisplayAmount
                  view={view}
                  value={schedule.released}
                  label="claimed amount"
                />
              </dd>
            </div>
            <div>
              <dt>Total allocation</dt>
              <dd>
                <DisplayAmount
                  view={view}
                  value={schedule.total}
                  label="total allocation"
                />
              </dd>
            </div>
            {amounts ? (
              <div>
                <dt>Locked</dt>
                <dd>
                  <LiveAmount view={view} part="unvested" label="locked amount" />
                </dd>
              </div>
            ) : null}
          </dl>
        </div>
        <div className={detailStyles.context}>
          {view.bounds ? (
            <div className={`card ${styles.panel} ${detailStyles.timing}`}>
              {!phone ? <NextUnlock view={view} /> : null}
              <ScheduleFacts view={view} />
            </div>
          ) : null}
          <ScheduleManagement view={view} />
        </div>
      </div>
      {view.bounds || schedule.status === "canceled" ? (
        <div className={`card ${styles.panel} ${detailStyles.chartCard}`}>
          {schedule.status === "canceled" ? (
            <div className={styles.notice}>
              <p>
                Cancellation settled the accrued funds to the beneficiary and
                returned the unvested funds to the refund recipient.
              </p>
              <div>
                Refunded:{" "}
                <DisplayAmount
                  view={view}
                  value={schedule.refunded}
                  label="refunded amount"
                />
              </div>
              {view.bounds ? (
                <p>The chart shows the original projection, not future releases.</p>
              ) : null}
            </div>
          ) : null}
          <DetailChart schedule={schedule} now={view.now} />
        </div>
      ) : null}
    </section>
  );
}

function ScheduleFacts({ view }: Readonly<{ view: DetailView }>) {
  const { schedule, bounds, amounts } = view;
  const continuous = isContinuousSchedule(schedule);
  const completionShown =
    schedule.status === "active" && amounts?.unvested === BigInt(0);
  if (!bounds) return null;
  return (
    <dl className={detailStyles.scheduleFacts}>
      {schedule.terms.kind === "linear" ? (
        <div>
          <dt>Schedule starts</dt>
          <dd>
            <ExactDate value={bounds[0]} />
          </dd>
        </div>
      ) : null}
      {!completionShown ? (
        <div>
          <dt>{continuous ? "Fully vested" : "Final release"}</dt>
          <dd>
            <ExactDate value={bounds[1]} />
          </dd>
        </div>
      ) : null}
      {schedule.terms.kind === "linear" &&
      BigInt(schedule.terms.cliff_ms) > BigInt(0) ? (
        <div>
          <dt>Cliff</dt>
          <dd>
            <ExactDate
              value={
                BigInt(schedule.terms.start_ms) +
                BigInt(schedule.terms.cliff_ms)
              }
            />
          </dd>
        </div>
      ) : null}
    </dl>
  );
}

function Activity({ view }: Readonly<{ view: DetailView }>) {
  const { read } = view;
  if (!read.data.events.length) return null;
  const names: Record<string, string> = {
    created: "Vesting created",
    claimed: "Coins claimed",
    canceled: "Vesting canceled",
    closed: "Schedule closed",
  };
  return (
    <section className={`card ${styles.panel} ${detailStyles.activity}`}>
      <h2>Activity</h2>
      {read.data.events.length === 100 ? (
        <p>Showing the 100 most recent events.</p>
      ) : null}
      {read.data.events.map((event) => (
        <div className={detailStyles.event} key={event.event_id}>
          <div>
            <b>{names[event.kind] ?? event.kind}</b>
            <ExactDate value={event.timestamp_ms} clock />
          </div>
          <TransactionLink href={`https://suiscan.xyz/mainnet/tx/${event.digest}`} />
        </div>
      ))}
    </section>
  );
}

function claimExplanation(view: DetailView): ReactNode {
  const { schedule, amounts, wallet, preparing, read, attempt } = view;
  if (schedule.status !== "active")
    return `This schedule is ${schedule.status}. No claim can be made.`;
  if (wallet.busy) return wallet.phase;
  if (preparing !== null)
    return "Preparing your transaction. Other actions are temporarily unavailable.";
  if (attempt)
    return "A transaction is open for review. Complete or dismiss it before preparing another.";
  if (read.isError)
    return "Unable to refresh the schedule. Retry before preparing a claim.";
  if (!amounts)
    return "The release data is unavailable. Claiming is disabled until it can be verified.";
  if (amounts.releasable === BigInt(0)) return noClaimMessage(view);
  return walletClaimMessage(view);
}
function noClaimMessage({ amounts, next }: DetailView): ReactNode {
  if (!next)
    return "All funds have been claimed. No further releases are scheduled.";
  const reason =
    amounts?.vested === BigInt(0)
      ? "Nothing to claim yet. First release"
      : "All unlocked funds have been claimed. Next release";
  return <>{reason}: <ExactDate value={next.time} />.</>;
}
function walletClaimMessage({ wallet, schedule }: DetailView): ReactNode {
  if (wallet.viewer.sessionPending)
    return <SkeletonLine label="Checking your sign-in…" />;
  if (!wallet.viewer.signedIn)
    return "Sign in with the beneficiary’s wallet to claim.";
  if (wallet.walletLoading)
    return <SkeletonLine label="Checking your Blast wallet…" />;
  if (wallet.walletError)
    return "Your wallet could not be loaded. Retry the wallet check.";
  if (!wallet.wallet)
    return "Your Blast wallet is not ready. Reconnect it before claiming.";
  if (wallet.wallet !== schedule.beneficiary)
    return "To claim through Blast, use the beneficiary’s wallet.";
  return "";
}

/** The claim box: its amount, button and note follow the live amounts. */
function VestingActions({ phone, view: page }: Readonly<{ phone: boolean; view: DetailView }>) {
  const view = { ...page, amounts: useLiveAmounts(page) };
  const { amounts, wallet, read, error, attempt } = view;
  const explanation = claimExplanation(view);
  return (
    <div className={detailStyles.claim}>
      <h3>Available to claim</h3>
      {amounts ? (
        <div className={detailStyles.claimAmount}>
          <DisplayAmount
            view={view}
            value={amounts.releasable}
            label="claimable amount"
            compact="readable"
          />
        </div>
      ) : null}
      {phone && view.bounds ? <NextUnlock view={view} /> : null}
      <div className={detailStyles.beneficiary}>
        <span>To beneficiary</span>
        <Identifier
          value={view.schedule.beneficiary}
          label="beneficiary address"
          isWallet={wallet.wallet === view.schedule.beneficiary}
          href={`https://suiscan.xyz/mainnet/account/${view.schedule.beneficiary}`}
        />
      </div>
      <ClaimAction
        view={view}
        describedBy={explanation ? "vesting-claim-explanation" : undefined}
      />
      {explanation ? (
        <p id="vesting-claim-explanation" role="status">
          {explanation}
        </p>
      ) : null}
      {wallet.walletError ? (
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          onClick={() => void wallet.retryWallet()}
        >
          Retry wallet check
        </button>
      ) : null}
      {read.isError ? (
        <>
          <p>Displaying the last confirmed schedule.</p>
          <button
            className="btn btn-ghost btn-sm"
            type="button"
            onClick={() => void read.refetch()}
          >
            Retry schedule
          </button>
        </>
      ) : null}
      {amounts && amounts.releasable > BigInt(0) &&
      (wallet.fee === "sponsored" || wallet.fee === "wallet") ? (
        <p>
          {wallet.fee === "sponsored"
            ? "Gas covered by Blast"
            : "Network gas paid in SUI"}
        </p>
      ) : null}
      {error && !attempt ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ScheduleDetails({ view }: Readonly<{ view: DetailView }>) {
  const { schedule, wallet } = view;
  return (
    <section className={`card ${styles.panel} ${detailStyles.technical}`}>
      <Disclosure title="Contract details">
        <dl>
          <div>
            <dt>Network</dt>
            <dd>Sui Mainnet · All times UTC</dd>
          </div>
          <div>
            <dt>Schedule ID</dt>
            <dd>
              <Identifier
                value={schedule.schedule_id}
                label="schedule ID"
                href={`https://suiscan.xyz/mainnet/object/${schedule.schedule_id}`}
              />
            </dd>
          </div>
          <div>
            <dt>Coin type</dt>
            <dd>
              <Identifier value={schedule.coin_type} label="coin type" />
            </dd>
          </div>
          {schedule.refund_recipient ? (
            <div>
              <dt>Refund recipient</dt>
              <dd>
                <Identifier
                  value={schedule.refund_recipient}
                  label="refund recipient address"
                  isWallet={wallet.wallet === schedule.refund_recipient}
                />
              </dd>
            </div>
          ) : null}
        </dl>
      </Disclosure>
    </section>
  );
}

function ScheduleManagement({ view }: Readonly<{ view: DetailView }>) {
  const { schedule } = view;
  if (schedule.status !== "active") return null;
  const explanation = schedule.refund_recipient
    ? cancellationExplanation(view)
    : "Irrevocable · this schedule cannot be canceled.";
  return (
    <section className={`card ${styles.panel} ${detailStyles.management}`}>
      <div>
        <h2>Cancellation</h2>
        {explanation ? (
          <p id="vesting-cancel-explanation" role="status">
            {explanation}
          </p>
        ) : null}
      </div>
      <ManageVestingActions view={view} />
    </section>
  );
}

function reviewTitle(attempt: VestingAttempt | null): string {
  if (attempt?.action === "cancel") return "Cancel this vesting?";
  if (attempt?.action === "close") return "Close empty schedule";
  return "Claim vested coins";
}

function ActionReview({ view }: Readonly<{ view: DetailView }>) {
  const { schedule, amounts, wallet, attempt, setAttempt, error } = view;
  return (
    <Sheet
      open={attempt !== null && view.reviewOpen}
      onRequestClose={() => {
        if (!wallet.busy && !view.checking) {
          view.setReviewOpen(false);
          if (!view.submitted) setAttempt(null);
        }
      }}
      onClosed={() =>
        view.actionTrigger.current?.focus({ preventScroll: true })
      }
      labelledBy="vesting-action-review"
      hasCta
    >
      <SheetHeading id="vesting-action-review" title={reviewTitle(attempt)} />
      <div className={styles.review}>
        <Identifier value={schedule.schedule_id} label="schedule ID" />
        <dl className={styles.details}>
          <div>
            <dt>Beneficiary</dt>
            <dd>
              <Identifier
                value={schedule.beneficiary}
                label="beneficiary address"
              />
            </dd>
          </div>
          {attempt?.action !== "close" ? (
            <div>
              <dt>Available to beneficiary</dt>
              <dd>
                {amounts ? (
                  <LiveAmount view={view} part="releasable" label="beneficiary payout" compact={false} />
                ) : (
                  "—"
                )}
              </dd>
            </div>
          ) : null}
          {attempt?.action === "cancel" ? (
            <>
              <div>
                <dt>Unvested refund</dt>
                <dd>
                  {amounts ? (
                    <LiveAmount view={view} part="unvested" label="unvested refund" compact={false} />
                  ) : (
                    "—"
                  )}
                </dd>
              </div>
              <div>
                <dt>Refund recipient</dt>
                <dd>
                  <Identifier
                    value={schedule.refund_recipient!}
                    label="refund recipient address"
                  />
                </dd>
              </div>
            </>
          ) : null}
          <div>
            <dt>Maximum network gas</dt>
            <dd>
              {formatVestingAmount(attempt?.gas_budget ?? "0", 9)} SUI
              {attempt?.sponsor_reservation_id ? " · Paid by Blast" : ""}
            </dd>
          </div>
        </dl>
        <p>
          {attempt?.action === "cancel"
            ? "Cancellation is permanent. Both payouts are made by the contract. Amounts can advance at an unlock boundary before execution."
            : attempt?.action === "close"
              ? "Closes the empty schedule. No tokens are transferred."
              : "The exact payout shown is a preview. It may increase as more tokens vest before execution. The contract pays the beneficiary."}{" "}
          {attempt?.sponsor_reservation_id
            ? "Blast pays the network gas."
            : "Your wallet pays network gas."}
        </p>
        {view.submitted ? (
          <p role="status">
            Confirmation is pending. Check the original transaction before
            preparing another.{" "}
            <a
              href={`https://suiscan.xyz/mainnet/tx/${attempt?.digest}`}
              target="_blank"
              rel="noreferrer"
            >
              View transaction ↗
            </a>
          </p>
        ) : null}
        {error ? (
          <p className={styles.error} role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <ReviewAction view={view} />
    </Sheet>
  );
}

function ReviewAction({ view }: Readonly<{ view: DetailView }>) {
  const { wallet, confirm } = view;
  return (
    <SheetCta>
      <button
        className="btn btn-primary"
        disabled={
          wallet.busy || view.checking || wallet.viewer.sessionPending || !wallet.viewer.signedIn ||
          (!view.submitted && (wallet.walletLoading || wallet.walletError || !wallet.wallet))
        }
        onClick={() => void confirm()}
        type="button"
      >
        <LoadingIndicator
          label={wallet.busy ? wallet.phase : "Checking transaction status"}
          loading={wallet.busy || view.checking}
        >
          {view.submitted ? "Check transaction status" : "Confirm in wallet"}
        </LoadingIndicator>
      </button>
    </SheetCta>
  );
}

function ClaimAction({ view, describedBy }: Readonly<{ view: DetailView; describedBy?: string }>) {
  const { wallet, schedule, amounts, preparing, prepare, read, attempt } = view;
  const available =
    schedule.status === "active" &&
    amounts !== null &&
    amounts.releasable > BigInt(0) &&
    !read.isError;
  if (available && !wallet.viewer.sessionPending && !wallet.viewer.signedIn)
    return (
      <GatedAction className={`btn btn-primary ${styles.block}`}>
        Sign in to claim
      </GatedAction>
    );
  const eligible =
    wallet.viewer.signedIn &&
    !wallet.viewer.sessionPending &&
    available &&
    !wallet.walletLoading &&
    !wallet.walletError &&
    wallet.wallet === schedule.beneficiary;
  return (
    <button
      className={`btn btn-primary ${styles.block}`}
      aria-describedby={describedBy}
      disabled={
        !eligible || preparing !== null || wallet.busy || attempt !== null
      }
      onClick={() => void prepare("claim")}
      type="button"
    >
      <LoadingIndicator label="Preparing claim" loading={preparing === "claim"}>
        Claim vested coins
      </LoadingIndicator>
    </button>
  );
}

function ManageVestingActions({ view }: Readonly<{ view: DetailView }>) {
  const { schedule, preparing, wallet, prepare } = view;
  return (
    <>
      {" "}
      {schedule.status === "active" && schedule.refund_recipient ? (
        <CancelAction view={view} />
      ) : null}
      {schedule.status === "active" &&
      schedule.refund_recipient === null &&
      BigInt(schedule.released) === BigInt(schedule.total) ? (
        <button
          className={`btn btn-ghost ${styles.secondary} ${detailStyles.secondary}`}
          disabled={wallet.viewer.sessionPending || !wallet.viewer.signedIn || wallet.walletLoading || wallet.walletError || !wallet.wallet || preparing !== null || wallet.busy || view.attempt !== null}
          onClick={() => void prepare("close")}
          type="button"
        >
          <LoadingIndicator
            label="Preparing schedule closure"
            loading={preparing === "close"}
          >
            Close empty schedule
          </LoadingIndicator>
        </button>
      ) : null}
    </>
  );
}

function cancellationExplanation({
  wallet,
  eligibility,
  read,
}: DetailView): ReactNode {
  if (wallet.viewer.sessionPending)
    return <SkeletonLine label="Checking cancellation permissions…" />;
  if (!wallet.viewer.signedIn)
    return "Sign in to check whether your wallet holds the cancellation key.";
  if (wallet.walletLoading)
    return <SkeletonLine label="Loading your wallet…" />;
  if (wallet.walletError)
    return "Your wallet could not be loaded. Retry the wallet check before canceling.";
  if (!wallet.wallet)
    return "Connect your wallet to check cancellation permissions.";
  if (read.isError)
    return "Retry the schedule refresh before preparing a cancellation.";
  if (eligibility.isPending || eligibility.isFetching)
    return <SkeletonLine label="Checking cancellation permissions…" />;
  if (eligibility.isError) return eligibility.error instanceof VestingCapabilityUnavailable ? eligibility.error.message : "Unable to check cancellation permissions.";
  if (eligibility.data === undefined)
    return "Cancellation permissions are unknown.";
  return eligibility.data
    ? null
    : "This wallet cannot cancel this vesting.";
}

function cancellationVerified({ wallet, eligibility, read }: DetailView) {
  return wallet.viewer.signedIn &&
    !wallet.viewer.sessionPending &&
    !!wallet.wallet &&
    !wallet.walletLoading &&
    !wallet.walletError &&
    !eligibility.isError &&
    !eligibility.isPending &&
    eligibility.data === true &&
    !read.isError;
}

function CancelAction({ view }: Readonly<{ view: DetailView }>) {
  const { wallet, eligibility, preparing, prepare, attempt } = view;
  return (
    <>
      {cancellationVerified(view) ? (
        <button
          className={`btn btn-ghost ${styles.secondary} ${detailStyles.destructive}`}
          aria-describedby={eligibility.isFetching ? "vesting-cancel-explanation" : undefined}
          aria-busy={eligibility.isFetching}
          disabled={
            eligibility.isFetching ||
            preparing !== null ||
            wallet.busy ||
            attempt !== null
          }
          onClick={() => void prepare("cancel")}
          type="button"
        >
          <LoadingIndicator
            label="Preparing cancellation"
            loading={preparing === "cancel"}
          >
            Cancel vesting
          </LoadingIndicator>
        </button>
      ) : null}
      {eligibility.isError && !(eligibility.error instanceof VestingCapabilityUnavailable) ? (
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => void eligibility.refetch()}
        >
          Retry authority check
        </button>
      ) : null}
    </>
  );
}
