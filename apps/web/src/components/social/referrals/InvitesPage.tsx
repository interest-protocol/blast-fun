"use client";

import { useAppendedRowsReveal, type LoadMoreRows } from "#web/components/blast-ui/use-appended-rows-reveal.ts";
import { ConnectionRowsLoading } from "../profile/ConnectionsLoading";
import { Disclosure } from "#web/components/blast-ui/Disclosure.tsx";
import { usePhoneLayout } from "#web/components/blast-ui/use-shell-prefs.ts";
import { Button, ButtonLink } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { useRef } from "react";
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { useInfiniteQuery } from "@tanstack/react-query";
import { referralInviteesSchema, REFERRAL_INVITEES_PATH, type ReferralInvitee } from "@blast/core/modules/social/referrals/contracts.ts";
import { IntentLink } from "#web/components/blast-ui/NavigationLink.tsx";
import { XLogo } from "#web/components/blast-ui/Icons.tsx";
import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { profilePath } from "#web/components/blast-ui/nav.ts";
import { unwrapApiResult, VIEWER_STALE_MS } from "#web/lib/query/client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { Avatar } from "../profile/parts";
import { ProfileInvites, ProfileInvitesLoading } from "../profile/ProfileInvites";
import { BackBar } from "../profile/BackBar";
import { SignInLink, useSocialViewer } from "../SignInGate";
import { callSocialApi } from "#web/components/social/social-api.ts";
import { ReferralAccounting } from "./ReferralAccounting";
import accountingStyles from "./ReferralAccounting.module.css";
import styles from "../profile/Connections.module.css";
import profileStyles from "../profile/Profile.module.css";

const noToken = async () => null;

function Joined({ person }: Readonly<{ person: ReferralInvitee }>) {
  return person.joined_at_ms === undefined ? null : <span>Joined <DateStamp at={person.joined_at_ms} plain /></span>;
}

export function InviteesView({ invitees, pending, failed, hasMore, loadingMore, onMore, onRetry }: Readonly<{
  invitees: readonly ReferralInvitee[];
  pending: boolean;
  failed: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  onMore: LoadMoreRows;
  onRetry: () => void;
}>) {
  const phone = usePhoneLayout();
  const { listRef, more, requested } = useAppendedRowsReveal(invitees.map(person => person.id), onMore);
  return <section ref={listRef} aria-labelledby="invitees-heading" className={`card ${styles.panel} ${styles.invitesPanel}`}>
    <h2 id="invitees-heading" className={styles.inviteesHeading}>People you invited</h2>
    {pending ? <ConnectionRowsLoading tab="invites" /> : invitees.length === 0 && !failed ? <EmptyState title="No invitees yet" /> : null}
    {invitees.length > 0 ? <ul aria-label="People you invited" className={styles.list}>
      {/* The Invites board's row: the face, the name over the join date, and the X handle. */}
      {invitees.map((person) => <li className={`${styles.row} ${styles.accountingRow}`} data-row-id={person.id} key={person.id}>
        {person.callsign ? <IntentLink className={styles.person} href={profilePath(person.callsign)}>
          <Avatar seed={person.callsign} url={person.avatar_url} size={40} />
          <span className={styles.identity}><b><span>{person.display_name ?? person.callsign}</span></b><Joined person={person} /></span>
        </IntentLink> : <span className={styles.person}>
          <Avatar seed={person.id} url={person.avatar_url} size={40} />
          <span className={styles.identity}><b><span>{person.display_name ?? "Blast member"}</span></b><Joined person={person} /></span>
        </span>}
        {person.x_handle ? <a className={styles.xHandle} href={`https://x.com/${encodeURIComponent(person.x_handle)}`} rel="noopener noreferrer" target="_blank">
          <XLogo /><span>@{person.x_handle}</span><span className="sr"> on X (opens in a new tab)</span>
        </a> : null}
        {person.accounting ? <InviteeAccounting accounting={person.accounting} phone={phone} /> : null}
      </li>)}
    </ul> : null}
    {failed ? <EmptyState action={<Button onClick={onRetry}>Retry invites</Button>} role="alert" title="Invites couldn’t load">Try again to load your list.</EmptyState> : null}
    {(hasMore || requested) ? <div className={styles.more}><Button aria-disabled={!hasMore || failed} focusableDisabled loading={loadingMore} loadingLabel="Loading more invites" onClick={() => { if (hasMore && !loadingMore && !failed) void more(); }}>{hasMore ? "Load more" : "All invites loaded"}</Button></div> : null}
  </section>;
}

function InviteeAccounting({ accounting, phone }: Readonly<{ accounting: NonNullable<ReferralInvitee["accounting"]>; phone: boolean }>) {
  const detail = <ReferralAccounting accounting={accounting} compact />;
  return <div className={accountingStyles.invitee}>
    {phone ? <Disclosure title="Referral activity">{detail}</Disclosure> : detail}
  </div>;
}

export function InvitesPage() {
  const viewer = useSocialViewer();
  const callsign = viewer.callsign;
  const pageReceived = useRef<((ids: readonly string[]) => void) | null>(null);
  const list = useInfiniteQuery({
    queryKey: queryKeys.me.invitees(callsign ?? ""),
    enabled: viewer.signedIn && callsign !== null && !viewer.sessionPending,
    staleTime: VIEWER_STALE_MS,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam, signal }) => {
      const received = pageParam ? pageReceived.current : null;
      const page = unwrapApiResult(await callSocialApi(
        { getAccessToken: viewer.getAccessToken ?? noToken, signal },
        `${REFERRAL_INVITEES_PATH}${pageParam ? `?cursor=${encodeURIComponent(pageParam)}` : ""}`,
        { method: "GET" }, referralInviteesSchema,
      ));
      if (!signal.aborted) received?.(page.invitees.map(person => person.id));
      return page;
    },
    getNextPageParam: (page) => page.next_cursor,
  }, useAppQueryClient());
  const invitees = [...new Map(list.data?.pages.flatMap((page) => page.invitees).map((person) => [person.id, person])).values()];

  return <article aria-labelledby="invites-title">
    <BackBar href={callsign ? profilePath(callsign) : "/portfolio"} label={callsign ? "Profile" : "Portfolio"} pageHead={false} />
    <PageHeader title="Invites" titleId="invites-title" />
    {viewer.sessionPending ? <div className={profileStyles.page}><ProfileInvitesLoading /><div className={profileStyles.sec}><InviteesView invitees={[]} pending failed={false} hasMore={false} loadingMore={false} onMore={async () => {}} onRetry={() => {}} /></div></div>
      : !viewer.signedIn ? <EmptyState action={<SignInLink className="btn btn-primary" />} framed title="Sign in to see your invites" />
      : callsign === null ? <EmptyState action={<ButtonLink href="/sign-in?next=%2Finvites" variant="primary">Finish setup</ButtonLink>} framed title="Finish setting up your account" />
      : <div className={profileStyles.page}>
        <ProfileInvites callsign={callsign} />
        <div className={profileStyles.sec}>
          <InviteesView key={callsign} invitees={invitees} pending={list.isPending} failed={list.isError} hasMore={Boolean(list.hasNextPage)} loadingMore={list.isFetchingNextPage}
            onMore={(received) => {
              pageReceived.current = received;
              return list.fetchNextPage().finally(() => {
                if (pageReceived.current === received) pageReceived.current = null;
              });
            }} onRetry={() => void (list.isFetchNextPageError ? list.fetchNextPage() : list.refetch())} />
        </div>
      </div>}
  </article>;
}
