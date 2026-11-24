"use client";

import { PendingPanel } from "#web/components/blast-ui/PendingPanel.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { useId, useState, useSyncExternalStore } from "react";

import { referralSummarySchema, referralPath, REFERRALS_PATH, type ReferralSummary } from "@blast/core/modules/social/referrals/contracts.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { CopyButton } from "#web/components/blast-ui/CopyButton.tsx";
import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";
import { INVITES_PATH } from "#web/components/blast-ui/nav.ts";
import { FieldGroup, TextField } from "#web/components/blast-ui/TextField.tsx";
import { SITE_ORIGIN } from "#web/lib/site.ts";
import { useToast } from "#web/components/blast-ui/Toasts.tsx";
import { unwrapApiResult, VIEWER_STALE_MS } from "#web/lib/query/client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { callSocialApi } from "#web/components/social/social-api.ts";
import { useSocialViewer } from "../SignInGate";
import { ReferralAccounting } from "../referrals/ReferralAccounting";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import styles from "./Profile.module.css";

const noToken = async () => null;

export function ProfileInvitesView({ callsign, summary, failed, onRetry }: Readonly<{
  callsign: string;
  summary?: ReferralSummary;
  failed: boolean;
  onRetry: () => void;
}>) {
  const [manualLink, setManualLink] = useState<string | null>(null);

  async function invite() {
    const link = new URL(referralPath(summary?.referral_code ?? callsign), window.location.origin).href;
    try {
      await navigator.clipboard.writeText(link);
      setManualLink(null);
      return true;
    } catch {
      setManualLink(link);
      return false;
    }
  }

  return <section aria-label="Your invites" className={clsx("card", styles.invites)}>
    <div className={styles.inviteHead}>
      {summary ? <span className={styles.inviteCount}><b className="num">{summary.invited.toLocaleString("en-US")}</b> invited</span> : !failed ? <span aria-label="Loading invite count" className={styles.inviteCount} role="status"><SkeletonText>00 invited</SkeletonText></span> : <span />}
      <CopyButton className={`btn btn-primary ${styles.crewCardAction}`} label="Copy your invite link" onCopy={invite}>Invite</CopyButton>
    </div>
    <div className={styles.inviteTotals}><InviteTotals summary={summary} failed={failed} onRetry={onRetry} />{failed && summary ? <Button onClick={onRetry} size="sm" variant="ghost">Retry totals</Button> : null}</div>
    <div className={styles.inviteNotes}>
      {!summary?.accounting && summary?.unvalued_trades ? <span className={styles.inviteCount}>Trades without a USD value are excluded from this total.</span> : null}
      <span className={manualLink ? styles.inviteCount : "sr"} role="status">{manualLink ? "Select and copy your invite link below." : ""}</span>
      {manualLink ? <TextField aria-label="Your invite link" onFocus={(event) => event.currentTarget.select()} readOnly value={manualLink} /> : null}
    </div>
  </section>;
}

function InviteTotals({
  summary,
  failed,
  onRetry,
}: Readonly<{ summary?: ReferralSummary; failed: boolean; onRetry: () => void }>) {
  const volume = summary ? volumeParts(summary.volume_usd) : null;
  if (!summary && !failed) return <PendingPanel label="Loading invite activity" />;
  return summary?.accounting ? (
    <ReferralAccounting accounting={summary.accounting} />
  ) : failed && !summary ? (
    <EmptyState action={<Button onClick={onRetry} size="sm" variant="ghost">Retry totals</Button>} title="Invite totals unavailable" role="alert" />
  ) : (
    <div
      aria-busy={!summary}
      aria-label={summary ? undefined : "Loading invite totals"}
      className={styles.inviteVolume}
      role="status"
    >
      <span className={styles.inviteCount}>
        <InspectValue
          label="Total referred volume calculation"
          value="Confirmed Blast buys and sells, valued when submitted. Your invitees’ volume is visible only to you."
        >
          Total referred volume ⓘ
        </InspectValue>
      </span>
      <strong>
        {volume ? (
          <>
            {volume.whole}
            <span>{volume.cents}</span>
          </>
        ) : (
          <SkeletonText>$0,000.00</SkeletonText>
        )}
      </strong>
    </div>
  );
}

/** The volume as the board's hero figure: "$4,820" and ".00" at half size, from the exact two-place decimal. */
function volumeParts(volumeUsd: string): Readonly<{ whole: string; cents: string }> {
  const [whole = "0", cents = "00"] = volumeUsd.split(".");
  return { whole: referredVolume(whole), cents: `.${cents}` };
}

/** The owner's referral summary (the Invites page's read, shared through its query key); private queries are cleared on account changes. */
function useReferralSummary(callsign: string) {
  const viewer = useSocialViewer();
  return useQuery({
    queryKey: queryKeys.me.referrals(callsign),
    enabled: viewer.signedIn && viewer.callsign === callsign && !viewer.sessionPending,
    staleTime: VIEWER_STALE_MS,
    queryFn: async ({ signal }) => unwrapApiResult(await callSocialApi(
      { getAccessToken: viewer.getAccessToken ?? noToken, signal }, REFERRALS_PATH, { method: "GET" }, referralSummarySchema,
    )),
  }, useAppQueryClient());
}

/** Mounted on the private Invites page. */
export function ProfileInvites({ callsign }: Readonly<{ callsign: string }>) {
  const summary = useReferralSummary(callsign);
  return <ProfileInvitesView callsign={callsign} failed={summary.isError} onRetry={() => void summary.refetch()} summary={summary.data} />;
}

const noSubscription = () => () => {};
const canShare = () => typeof navigator.share === "function";
const pageHost = () => window.location.host;
const siteHost = () => new URL(SITE_ORIGIN).host;

/** "$4,820.00" from the summary's exact two-place decimal. */
function referredVolume(volumeUsd: string): string {
  return `$${volumeUsd.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

/**
 * The own profile's Invites card (the Profile board), in its right column:
 * how many joined, their volume, generated revenue and 60% lifetime earnings,
 * the invite link, and See all for the private Invites page. The figures come from the Invites
 * page's own read; they are left out while it is pending or failed, so the
 * card never shows a guess.
 */
export function ProfileInvitesCardView({ callsign, summary, loading }: Readonly<{ callsign: string; summary?: ReferralSummary; loading: boolean }>) {
  const heading = useId();
  const toast = useToast();
  const share = useSyncExternalStore(noSubscription, canShare, () => false);
  const host = useSyncExternalStore(noSubscription, pageHost, siteHost);
  const link = () => new URL(referralPath(summary?.referral_code ?? callsign), window.location.origin).href;
  async function copy() {
    if (!navigator.clipboard) throw new Error("Clipboard unavailable");
    await navigator.clipboard.writeText(link());
    return true;
  }
  async function shareLink() {
    if (!share) {
      // Without a share sheet the link is copied, as Copy does.
      try {
        await copy();
        toast("Invite link copied");
      } catch {
        toast("Copying is blocked here. Select the link instead.");
      }
      return;
    }
    try {
      await navigator.share({ url: link(), title: "Join me on Blast" });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) toast("Sharing is blocked here. Copy the link instead.");
    }
  }
  return <section aria-labelledby={heading} className={clsx("card", styles.invitesCard)} data-aside-card="">
    <div className={styles.invitesCardHead}>
      <h3 id={heading}>Invites</h3>
      <Link className={styles.invitesCardLink} href={INVITES_PATH}>See all</Link>
    </div>
    {summary || loading ? <div aria-busy={loading || undefined} className={styles.inviteTiles}>
      <div><span>Joined</span><b className="num">{summary ? summary.invited.toLocaleString("en-US") : <SkeletonText>00</SkeletonText>}</b></div>
      {!summary?.accounting ? <div><span>Referred volume</span><b className="num">{summary ? referredVolume(summary.volume_usd) : <SkeletonText>$0.00</SkeletonText>}</b></div> : null}
    </div> : null}
    {summary?.accounting ? <ReferralAccounting accounting={summary.accounting} /> : null}
    <FieldGroup className={styles.inviteLink}>
      <TextField aria-label="Your invite link" onFocus={(event) => event.currentTarget.select()} readOnly value={`${host}${referralPath(summary?.referral_code ?? callsign)}`} />
      <CopyButton label="Copy your invite link" onCopy={copy} size="sm" variant="secondary" />
    </FieldGroup>
    <Button onClick={() => void shareLink()} variant="primary">Share invite link</Button>
  </section>;
}

export function ProfileInvitesCard({ callsign }: Readonly<{ callsign: string }>) {
  const summary = useReferralSummary(callsign);
  return <ProfileInvitesCardView callsign={callsign} loading={summary.isLoading} summary={summary.data} />;
}

export function ProfileInvitesLoading() {
  return <section aria-busy="true" aria-label="Loading your invites" className={clsx("card", styles.invites)} role="status">
    <div aria-hidden="true" className={styles.inviteHead}>
      <span className={styles.inviteCount}><SkeletonText>00 invited</SkeletonText></span>
      <span className={clsx(styles.crewCardAction, styles.actionSkeleton)}><SkeletonText>Invite</SkeletonText></span>
    </div>
    <div className={styles.inviteTotals}><PendingPanel label="Loading invite activity" /></div>
    <div aria-hidden="true" className={styles.inviteNotes}><span className="sr">Invite feedback</span></div>
  </section>;
}
