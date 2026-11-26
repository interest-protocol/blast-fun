"use client";

import { useQuery } from "@tanstack/react-query";
import { referralMonthsSchema, REFERRAL_MONTHS_PATH } from "@blast/core/modules/social/referrals/contracts.ts";
import { callSocialApi } from "#web/components/social/social-api.ts";
import { unwrapApiResult, VIEWER_STALE_MS } from "#web/lib/query/client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { Button, ButtonLink } from "#web/components/blast-ui/Button.tsx";
import { DiagnosticCode } from "#web/components/blast-ui/DiagnosticText.tsx";
import { publicErrorMessage } from "#web/lib/errors.ts";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { PendingPanel } from "#web/components/blast-ui/PendingPanel.tsx";
import { profilePath } from "#web/components/blast-ui/nav.ts";
import { BackBar } from "../profile/BackBar.tsx";
import { SignInLink, useSocialViewer } from "../SignInGate";
import { MonthlyReferrals } from "./MonthlyReferrals.tsx";
const UNAVAILABLE = "Referral payments couldn’t load";
const noToken = async () => null;

export function InvitesPage() {
  const { callsign, sessionPending, signedIn, getAccessToken } = useSocialViewer();
  let content;
  if (sessionPending) {
    content = <PendingPanel framed label="Loading referral payments" />;
  } else if (!signedIn) {
    content = <EmptyState action={<SignInLink variant="primary" />} framed title="Sign in to see your invites" />;
  } else if (callsign === null) {
    content = <EmptyState action={<ButtonLink href="/sign-in?next=%2Finvites" variant="primary">Finish setup</ButtonLink>} framed title="Finish setting up your account" />;
  } else {
    content = <ReferralStatementView callsign={callsign} getAccessToken={getAccessToken ?? noToken} />;
  }

  return (
    <article aria-labelledby="invites-title">
      <BackBar href={callsign ? profilePath(callsign) : "/portfolio"} label={callsign ? "Profile" : "Portfolio"} pageHead={false} />
      <PageHeader title="Invites" titleId="invites-title" />
      {content}
    </article>
  );
}

function ReferralStatementView({ callsign, getAccessToken }: Readonly<{
  callsign: string;
  getAccessToken: () => Promise<string | null>;
}>) {
  const summary = useQuery({
    queryKey: queryKeys.me.referralMonths(callsign),
    staleTime: VIEWER_STALE_MS,
    queryFn: async ({ signal }) => unwrapApiResult(await callSocialApi(
      { getAccessToken, signal },
      REFERRAL_MONTHS_PATH,
      { method: "GET" },
      referralMonthsSchema,
    )),
  }, useAppQueryClient());

  if (summary.data) return <MonthlyReferrals months={summary.data.months} />;
  if (summary.isError) {
    return (
      <EmptyState
        action={<Button onClick={() => void summary.refetch()}>Try again</Button>}
        framed
        role="alert"
        title={UNAVAILABLE}
      >
        <DiagnosticCode generic={UNAVAILABLE} message={publicErrorMessage(summary.error, UNAVAILABLE)} />
      </EmptyState>
    );
  }
  return <PendingPanel framed label="Loading referral payments" />;
}
