"use client";
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { pollInterval } from "#web/lib/query/polling.ts";
import { walletVestingSchedulesSchema } from "@blast/core/modules/vesting/responses.ts";

import { VestingCapabilityUnavailable, retryVestingRead } from "./read-availability";
import Link from "next/link";
import { RowSkeletons } from "#web/components/social/portfolio/HoldingsSkeleton.tsx";
import { rememberListOrigin } from "#web/components/blast-ui/list-restoration.ts";
import { useId, useRef, useState, type ReactNode } from "react";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { usePortfolioState } from "#web/components/social/portfolio/use-portfolio-state.ts";
import { useHoldingSearch } from "#web/components/social/portfolio/holding-search.tsx";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  useSocialViewer,
  useSignInGate,
} from "#web/components/social/SignInGate.tsx";
import { callSocialApi } from "#web/components/social/social-api.ts";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { Button, ButtonLink, DisclosureSummary } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import { TextField } from "#web/components/blast-ui/TextField.tsx";
import { MobileToastTarget } from "#web/components/blast-ui/Toasts.tsx";
import { HIDDEN_AMOUNT } from "@blast/core/lib/format.ts";
import { vestingFeedbackId } from "#web/components/social/portfolio/portfolio-model.ts";
import {
  vestingPath,
  type PublicVesting,
} from "@blast/core/modules/vesting/model.ts";
import { VestingShare } from "./parts";
import { MAX_DATE_MS, vestingScheduleLabel } from "./schedule-display";
import { readableDate } from "./detail-format";
import { overviewSchedule } from "./overview-model";
import { TokenAmount } from "./DetailValues";
import { useOverviewClaim } from "./use-overview-claim";
import { Sheet, SheetClose, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { CopyButton } from "#web/components/blast-ui/CopyButton.tsx";
import styles from "./Vesting.module.css";
import overviewStyles from "./VestingOverview.module.css";
type WalletSchedules = {
  wallet: string | null;
  schedules: readonly PublicVesting[];
};
type InspectRecipient = (schedule: PublicVesting, trigger: HTMLButtonElement) => void;
type RecipientInspection = Readonly<{ value: string; trigger: HTMLButtonElement }>;
const FILTERS = [["Receiving", "Receiving"], ["Created", "Created"], ["History", "History"]] as const;
type ClaimableHoldings = Readonly<{ content: ReactNode; hasRows: boolean; known: boolean }>;

export function VestingOverview({ nowMs, embedded = false, hidden = false, allocations, allocationIds = [], claimableHoldings }: Readonly<{
  nowMs: number;
  embedded?: boolean;
  hidden?: boolean;
  allocations?: ReactNode;
  allocationIds?: readonly string[];
  claimableHoldings?: ClaimableHoldings;
}>) {
  const viewer = useSocialViewer();
  const [tab, setTab] = usePortfolioState<"Receiving" | "Created" | "History">("vesting-filter", "Receiving");
  const [recipient, setRecipient] = useState<RecipientInspection | null>(null);
  const [recipientOpen, setRecipientOpen] = useState(false);
  const recipientHeading = useId();
  const filters = useRef<HTMLDivElement>(null);
  const read = useWalletSchedules(viewer);
  function restoreListFocus() {
    const summary = filters.current?.closest("details:not([open])")?.querySelector("summary");
    (summary ?? filters.current?.querySelector<HTMLButtonElement>('[aria-pressed="true"]'))?.focus({ preventScroll: true });
  }
  const claim = useOverviewClaim(nowMs, read.refetch, restoreListFocus, !claimableHoldings);
  const allocated = new Set(allocationIds);
  const receiving = walletRows(read.data, "Receiving").filter(row => !allocated.has(row.schedule_id));
  const fresh = read.isSuccess && !claim.wallet.walletError;
  const available = claimableHoldings && fresh ? receiving.filter(row => isClaimable(row, nowMs, claim.wallet.wallet)) : [];
  const availableIds = new Set(available.map(row => row.schedule_id));
  const rows = tab === "Receiving" ? receiving.filter(row => !availableIds.has(row.schedule_id)) : walletRows(read.data, tab);
  const list = useHoldingSearch(rows, row => `${row.coin_name ?? ""} ${row.coin_symbol ?? ""} ${row.coin_type} ${row.schedule_id}`, "public-vestings");
  const inspectRecipient: InspectRecipient = (schedule, trigger) => {
    setRecipient({ value: schedule.beneficiary, trigger });
    setRecipientOpen(true);
  };
  function recipientClosed() {
    if (recipient && !recipient.trigger.isConnected && !document.querySelector('[aria-modal="true"]')) {
      restoreListFocus();
    }
    setRecipient(null);
  }
  const scheduleList = <>
    <div className={overviewStyles.filters} ref={filters}>
      <Segmented label="Filter vesting schedules" onChange={setTab} options={FILTERS} value={tab} />
    </div>
    {tab === "Receiving" && allocations ? <section aria-label="Presale allocations" className={`${styles.allocations} ${overviewStyles.allocations}`}><h3>Presale allocations</h3>{allocations}</section> : null}
    {list.search}
    {claim.wallet.walletError ? <p role="alert">Unable to check your claim wallet. <Button onClick={() => void claim.wallet.retryWallet()} size="sm" variant="ghost">Retry wallet check</Button></p> : null}
    <WalletScheduleList nowMs={nowMs} hidden={hidden} viewer={viewer} read={read} rows={list.rows} searching={list.searching} tab={tab} hasAllocations={tab === "Receiving" && (!!allocations || available.length > 0)} onInspectRecipient={inspectRecipient} showSignIn={!embedded} claim={claim} />
    {list.pager}
  </>;
  return <div className={`${embedded ? styles.embedded : styles.page} ${overviewStyles.overview}`}>
    {claimableHoldings ? <AvailableClaims claim={claim} fresh={fresh} hidden={hidden} holdings={claimableHoldings} nowMs={nowMs} schedules={available} /> : null}
    <div className={`${styles.heading} ${overviewStyles.heading}`}>
      {!embedded ? <h1>Vesting</h1> : null}
      <ButtonLink href="/vesting/new" size="sm">Create vesting</ButtonLink>
    </div>
    <ScheduleHistory grouped={Boolean(claimableHoldings)} loadError={read.isError || claim.wallet.walletError} holdingsKnown={claimableHoldings?.known}>{scheduleList}</ScheduleHistory>
    {claim.node}
    <PublicScheduleLookup />
    <Sheet open={recipientOpen} onRequestClose={() => setRecipientOpen(false)} onRequestOpen={() => setRecipientOpen(true)} onClosed={recipientClosed} labelledBy={recipientHeading}>
      <SheetClose onClick={() => setRecipientOpen(false)} />
      <SheetHeading id={recipientHeading} title="Recipient" />
      <div className={overviewStyles.inspection}>
        <code>{recipient?.value}</code>
        <CopyButton size="md" variant="secondary" label="Copy full recipient address" onCopy={async () => { if (!recipient) return false; await navigator.clipboard.writeText(recipient.value); return true; }} />
      </div>
    </Sheet>
  </div>;
}

function ScheduleHistory({ grouped, loadError, holdingsKnown, children }: Readonly<{
  grouped: boolean; loadError: boolean; holdingsKnown?: boolean; children: ReactNode;
}>) {
  if (!grouped) return children;
  return <details className={overviewStyles.scheduleGroup} open={loadError || !holdingsKnown || undefined}>
    <DisclosureSummary>Vesting schedules and history</DisclosureSummary>
    {children}
  </details>;
}

function PublicScheduleLookup() {
  const router = useRouter();
  const [lookup, setLookup] = usePortfolioState("vesting-lookup", "");
  const [error, setError] = useState<string | null>(null);
  const lookupId = useId();
  function openSchedule() {
    try {
      const href = vestingPath(lookup);
      rememberListOrigin(href);
      router.push(href);
      setError(null);
    } catch {
      setError("Enter a complete Sui schedule object ID.");
    }
  }
  return <details className={overviewStyles.lookup}>
    <DisclosureSummary>Open a public schedule by ID</DisclosureSummary>
    <form className={styles.form} onSubmit={event => { event.preventDefault(); openSchedule(); }}>
      <label htmlFor={lookupId}>Schedule ID<TextField id={lookupId} autoComplete="off" aria-label="Schedule ID" onChange={event => setLookup(event.target.value)} placeholder="0x…" required value={lookup} /></label>
      <Button type="submit">Open schedule</Button>
      {error ? <p className={styles.error} role="alert">{error}</p> : null}
    </form>
  </details>;
}

function isClaimable(schedule: PublicVesting, nowMs: number, wallet: string | null) {
  return schedule.beneficiary === wallet && (overviewSchedule(schedule, nowMs, false).balances.available ?? 0n) > 0n;
}

function AvailableClaims({ claim, fresh, hidden, holdings, nowMs, schedules }: Readonly<{ claim: ReturnType<typeof useOverviewClaim>; fresh: boolean; hidden: boolean; holdings: ClaimableHoldings; nowMs: number; schedules: readonly PublicVesting[] }>) {
  const heading = useId();
  const list = useHoldingSearch(schedules, row => `${row.coin_name ?? ""} ${row.coin_symbol ?? ""} ${row.coin_type} ${row.schedule_id}`, "claimable-public-vestings");
  const empty = holdings.known && !holdings.hasRows && schedules.length === 0 && fresh && !claim.wallet.walletLoading;
  return <section aria-labelledby={heading} className={overviewStyles.availableClaims}>
    <h3 id={heading}>Available to claim</h3>
    {holdings.content}
    {schedules.length > 0 ? <>{list.search}
      {list.rows.map(schedule => <ScheduleRow claim={claim} compact hidden={hidden} key={schedule.schedule_id} nowMs={nowMs} receivingWallet={claim.wallet.wallet} schedule={schedule} stale={false} />)}
      {list.pager}
    </> : null}
    {empty ? <EmptyState compact heading={3} title="No presale positions or received vesting schedules ready to claim" /> : null}
  </section>;
}

function ScheduleRow({ schedule, hidden, nowMs, onInspectRecipient, claim, receivingWallet, stale, compact = false }: Readonly<{ compact?: boolean; schedule: PublicVesting; hidden: boolean; nowMs: number; onInspectRecipient?: InspectRecipient; claim: ReturnType<typeof useOverviewClaim>; receivingWallet: string | null; stale: boolean }>) {
  const view = overviewSchedule(schedule, nowMs, hidden);
  const href = vestingPath(schedule.schedule_id);
  const receiving = receivingWallet === schedule.beneficiary;
  const balance = (value: bigint | undefined, label: string) => <ScheduleBalance value={value} label={label} schedule={schedule} hidden={hidden} symbol={view.symbol} />;
  return (
    <article aria-label={`${view.name} vesting schedule`} className={overviewStyles.row} data-compact={compact || undefined} data-list-row={schedule.schedule_id}>
      <Link className={overviewStyles.identity} href={href}>
        <span className={styles.coinMark}><CoinMark
          coin={{ key: schedule.coin_type, coinType: schedule.coin_type, iconUrl: schedule.coin_icon_url, symbol: view.symbol, round: false }}
          size={40}
        /></span>
        <span className={overviewStyles.summaryCopy}>
          <b>{view.name}</b>
          <span className={overviewStyles.inlineFacts}>
            {compact ? <span className={overviewStyles.available}>{view.available} {view.symbol}</span> : <span className={overviewStyles.timing}><ScheduleTiming view={view} /></span>}
          </span>
        </span>
      </Link>
      {compact ? null : <dl className={overviewStyles.balances} aria-label={`${view.symbol} vesting balances`}>
        <div><dt>Claimed</dt><dd>{balance(view.balances.claimed, "claimed")}</dd></div>
        <div><dt>Unclaimed</dt><dd>{balance(view.balances.remaining, "remaining")}</dd></div>
        <div><dt>Available to claim</dt><dd>{balance(view.balances.available, "available")}</dd></div>
      </dl>}

      <div className={overviewStyles.actions}>
        {onInspectRecipient ? <button aria-haspopup="dialog" aria-label={`Inspect recipient for ${view.name}`} className={overviewStyles.recipient} onClick={event => onInspectRecipient(schedule, event.currentTarget)} type="button">Recipient <span>{schedule.beneficiary.slice(0, 8)}…{schedule.beneficiary.slice(-6)}</span></button> : null}
        {receiving && schedule.status === "active" ? <ScheduleClaimAction schedule={schedule} claim={claim} stale={stale} available={view.balances.available} compact={compact} /> : null}
      </div>
      {stale ? <p className={overviewStyles.balanceNote}>Balances could not refresh. Retry the schedule list before claiming.</p> : null}
      <MobileToastTarget className={overviewStyles.feedback} id={vestingFeedbackId(schedule.schedule_id)} />
      {compact ? null : <ScheduleRowDetails balance={balance} schedule={schedule} view={view} />}
    </article>
  );
}

function ScheduleRowDetails({ balance, schedule, view }: Readonly<{ balance: (value: bigint | undefined, label: string) => ReactNode; schedule: PublicVesting; view: ReturnType<typeof overviewSchedule> }>) {
  const state = view.state === "Fully unlocked · claim available" ? "Fully unlocked" : view.state;
  const timingLabel = view.timing.label === "Next release" ? "Next unlock" : view.timing.label === "First release" ? "First unlock" : view.timing.label;
  return <details className={overviewStyles.disclosure}>
        <DisclosureSummary>Details<span className={overviewStyles.visuallyHidden}> for {view.name}</span></DisclosureSummary>
        <div className={overviewStyles.secondary}>
          <p className={overviewStyles.state}>{vestingScheduleLabel(schedule.terms)} · {state}</p>
          <dl className={overviewStyles.facts}>
            <div><dt>Allocated</dt><dd>{balance(BigInt(schedule.total), "allocated")}</dd></div>
            <div><dt>Unlocked</dt><dd>{schedule.status === "active" && view.balances.available !== undefined ? balance(view.balances.available + view.balances.claimed, "unlocked") : "—"}</dd></div>
          </dl>
          {view.progress !== null ? <div className={overviewStyles.progress}>
            <progress aria-label={`Unlocked share of ${view.name}`} aria-valuetext={view.progressText} max={100} value={view.progress} />
            <span>{view.progressText}</span>
          </div> : null}
          {view.timing.at !== null ? <p className={overviewStyles.timing}>{view.timing.label === "Unlocking continuously" ? "Fully unlocked" : timingLabel} <ScheduleDate value={view.timing.at} /></p> : null}
          <div className={overviewStyles.actions}>
            <VestingShare id={schedule.schedule_id} />
          </div>
        </div>
      </details>;
}

function ScheduleBalance({ value, label, schedule, hidden, symbol }: Readonly<{ value: bigint | undefined; label: string; schedule: PublicVesting; hidden: boolean; symbol: string }>) {
  if (hidden) return <>{HIDDEN_AMOUNT} {symbol}</>;
  if (value === undefined) return <>—</>;
  return <TokenAmount value={value} decimals={schedule.coin_decimals} symbol={symbol} label={`${label} ${symbol}`} />;
}

function ScheduleTiming({ view }: Readonly<{ view: ReturnType<typeof overviewSchedule> }>) {
  if (view.timing.label === "Unlocking continuously") return <>{view.timing.label}</>;
  if (view.timing.at === null) return <>{view.state === "Fully unlocked · claim available" ? "Fully unlocked" : view.state}</>;
  const label = view.timing.label === "Next release" ? "Next unlock" : "First unlock";
  return <>{label} <ScheduleDate value={view.timing.at} plain /></>;
}

function ScheduleClaimAction({ schedule, claim, stale, available, compact }: Readonly<{ schedule: PublicVesting; claim: ReturnType<typeof useOverviewClaim>; stale: boolean; available: bigint | undefined; compact: boolean }>) {

  const ownReview = claim.scheduleId === schedule.schedule_id;
  const pending = ownReview && claim.pending;
  const syncing = claim.awaitingIndex(schedule);
  const hasBalance = available !== undefined && available > BigInt(0);
  const otherReview = !!claim.scheduleId && !ownReview;
  const disabled = [claim.wallet.wallet !== schedule.beneficiary, claim.wallet.walletLoading, claim.wallet.walletError, stale, !hasBalance && !pending, syncing, claim.active, claim.busy, otherReview].some(Boolean);
  const remaining = BigInt(schedule.total) - BigInt(schedule.released) - BigInt(schedule.refunded);
  const label = scheduleClaimLabel(pending, syncing, available, remaining, compact);
  return <button className="btn btn-primary btn-sm" disabled={disabled} aria-haspopup="dialog" onClick={event => claim.start(schedule, event.currentTarget)} type="button">
    <LoadingIndicator label={claim.wallet.walletLoading ? "Checking claim wallet" : "Preparing claim"} loading={ownReview && claim.busy || claim.wallet.walletLoading}>{label}</LoadingIndicator>
  </button>;
}

function scheduleClaimLabel(pending: boolean, syncing: boolean, available: bigint | undefined, remaining: bigint, compact: boolean) {
  if (pending) return "Check claim status";
  if (syncing) return "Updating balances";
  if (available === undefined) return "Schedule unavailable";
  if (remaining === BigInt(0)) return "Fully claimed";
  if (available <= BigInt(0)) return "Nothing to claim yet";
  return compact ? "Claim" : "Claim vested coins";
}

function ScheduleDate({ value, plain }: Readonly<{ value: bigint; plain?: boolean }>) {
  return value > MAX_DATE_MS ? <>{readableDate(value)}</> : <DateStamp at={value} label="vesting time" plain={plain} />;
}

function walletRows(
  data: WalletSchedules | undefined,
  tab: "Receiving" | "Created" | "History",
) {
  return (
    data?.schedules.filter((schedule) => {
      if (tab === "History") return schedule.status !== "active";
      if (tab === "Created") return schedule.creator === data.wallet;
      return (
        schedule.beneficiary === data.wallet && schedule.status === "active"
      );
    }) ?? []
  );
}

function useWalletSchedules(viewer: ReturnType<typeof useSocialViewer>) {
  const client = useAppQueryClient();
  return useQuery({
    queryKey: ["blast", "me", "vesting"],
    enabled: viewer.signedIn && !viewer.sessionPending,
    queryFn: async () => {
      const result = await callSocialApi(
        { getAccessToken: viewer.getAccessToken ?? (async () => null) },
        "/api/social/me/vesting",
        { method: "GET" },
        walletVestingSchedulesSchema,
      );
      if (result.status === "refused" && result.reasons?.includes("vesting_index_unavailable"))
        throw new VestingCapabilityUnavailable("Vesting history is not indexed yet. Your wallet list is unavailable; public schedule links still work.");
      if (result.status !== "ok")
        throw new Error("Your schedules are temporarily unavailable. You can still open a public schedule by ID below.");
      return result.body;
    },
    retry: retryVestingRead,
    refetchInterval: (query) => query.state.error instanceof VestingCapabilityUnavailable ? false : pollInterval(30_000, query),
    refetchOnWindowFocus: (query) => !(query.state.error instanceof VestingCapabilityUnavailable),
  }, client);
}

type ScheduleListProps = Readonly<{
  nowMs: number;
  hidden: boolean;
  viewer: ReturnType<typeof useSocialViewer>;
  read: ReturnType<typeof useWalletSchedules>;
  rows: readonly PublicVesting[];
  hasAllocations: boolean;
  searching: boolean;
  tab: "Receiving" | "Created" | "History";
  onInspectRecipient: InspectRecipient;
  showSignIn: boolean;
  claim: ReturnType<typeof useOverviewClaim>;
}>;

function WalletScheduleList(props: ScheduleListProps) {
  return <section aria-label="Public schedules" aria-busy={props.viewer.sessionPending || props.viewer.signedIn && props.read.isPending || undefined} className={styles.scheduleList}>
    <ScheduleListContent {...props} />
    {props.read.data?.schedules.length === 200 ? <p>200 most recent schedules</p> : null}
  </section>;
}

function ScheduleListContent({ nowMs, hidden, viewer, read, rows, tab, hasAllocations, searching, onInspectRecipient, showSignIn, claim }: ScheduleListProps) {
  if (viewer.sessionPending || viewer.signedIn && read.isPending) return <RowSkeletons kind="vestings" count={2} label="Loading vesting schedules" />;
  if (!viewer.signedIn) return <EmptyState action={showSignIn ? <SignInAction /> : null} heading={2} title="Sign in to see your vestings" />;
  if (read.isError && !read.data) return <VestingReadError error={read.error} retry={() => void read.refetch()} />;
  if (rows.length === 0 && !read.isError) return <NoSchedules tab={tab} suppressed={hasAllocations || searching} />;
  return <>
    {read.isError ? <EmptyState action={<Button onClick={() => void read.refetch()} size="sm">Retry</Button>} compact role="alert" title="Couldn’t refresh vesting schedules" /> : null}
    <div className={overviewStyles.list}>{rows.map(schedule => <ScheduleRow nowMs={nowMs} hidden={hidden} key={schedule.schedule_id} schedule={schedule} onInspectRecipient={onInspectRecipient} claim={claim} receivingWallet={read.data?.wallet ?? null} stale={read.isError} />)}</div>
  </>;
}

function VestingReadError({ error, retry }: Readonly<{ error: Error; retry: () => void }>) {
  const unavailable = error instanceof VestingCapabilityUnavailable;
  return <EmptyState action={unavailable ? null : <Button onClick={retry}>Retry</Button>} role="alert" title={unavailable ? "Wallet history unavailable" : "Your vesting schedules couldn’t load"}>
    {error.message}
  </EmptyState>;
}

/** A visitor's sign-in, returning here (the gate's link as the shared control). */
function SignInAction() {
  const gate = useSignInGate();
  return <ButtonLink data-gated="sign-in" href={gate.signInHref} onClick={gate.openSignIn} prefetch={false} variant="primary">Sign in</ButtonLink>;
}

function NoSchedules({
  tab, suppressed,
}: Readonly<{ tab: "Receiving" | "Created" | "History"; suppressed: boolean }>) {
  if (suppressed) return null;
  if (tab === "Receiving") return <EmptyState heading={2} title="No incoming vesting schedules" />;
  if (tab === "Created") return <EmptyState heading={2} title="No vesting schedules created" />;
  return <EmptyState heading={2} title="No completed or cancelled schedules" />;
}
