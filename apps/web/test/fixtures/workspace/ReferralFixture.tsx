"use client";
import { useState, useSyncExternalStore } from "react";
const subscribe = () => () => {};
const clientReady = () => true;
const serverReady = () => false;
import { AppShell } from "../../../src/components/blast-ui/AppShell";
import { PendingPanel } from "../../../src/components/blast-ui/PendingPanel";
import { EmptyState } from "../../../src/components/blast-ui/EmptyState";
import { PageHeader } from "../../../src/components/blast-ui/PageHeader";
import { QueryProvider } from "../../../src/lib/query/provider";
import { makeQueryClient } from "../../../src/lib/query/client";
import { queryKeys } from "../../../src/lib/query/keys";
import { SocialViewerProvider } from "../../../src/components/social/SignInGate";
import {
  geist,
  geistMono,
  bricolage,
} from "../../../src/components/blast-ui/fonts";
import {
  ProfileInvitesCardView,
} from "../../../src/components/social/profile/ProfileInvites";
import { InvitesPage } from "../../../src/components/social/referrals/InvitesPage";
import type { ReferralStatement, ReferralSummary } from "@blast/core/modules/social/referrals/contracts.ts";
const monthly: readonly ReferralStatement[] = [
  { month: "2026-11", revenue_atoms: "3577132109", share_bps: 3429, payment: null },
  { month: "2026-10", revenue_atoms: "12500000000", share_bps: 3000,
    payment: { amount_atoms: "3750000000", digest: "4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi" } },
  { month: "2026-09", revenue_atoms: "0", share_bps: 6000, payment: null },
];

export function ReferralFixture({
  view = "invites",
  theme = "light",
  state = "ready",
}: Readonly<{ view?: string; theme?: string; state?: string }>) {
  const [client] = useState(() => {
    const client = makeQueryClient({ defaultOptions: { queries: { refetchOnMount: false } } });
    client.setQueryData(queryKeys.me.referralMonths("kaleo_on_blast"), {
      months: state === "empty" ? [] : monthly,
    });
    return client;
  });
  const hydrated = useSyncExternalStore(subscribe, clientReady, serverReady);
  const accounting = {
    assets: [
      {
        coin_type: "0x2::sui::SUI",
        symbol: "SUI",
        decimals: 9,
        volume_atoms: "100000000000",
        revenue_atoms: "1000000000",
        earnings_atoms: "300000000",
      },
    ],
    share_bps: 3000 as const,
    as_of_ms: 1790000000000,
    pending_events: 0,
  };
  if (state === "empty") accounting.assets = [];
  const summary: ReferralSummary = {
    invited: state === "empty" ? 0 : 2,
    volume_usd: "0.00",
    unvalued_trades: 0,
    referral_code: "cryptokaleo",
    accounting,
  };
  const unavailable = state === "loading" || state === "error";
  return (
    <div
      className={`${geist.variable} ${geistMono.variable} ${bricolage.variable}`}
      data-fixture-hydrated={hydrated}
      data-fixture-view={view}
      data-fixture-state={state}
      data-blast-ui=""
      data-theme={theme}
    >
      <QueryProvider client={client}>
        <AppShell
          signedIn={false}
          viewer={null}
          portfolio={{ status: "unavailable" }}
          signInHref="/sign-in"
        >
          {view === "profile" || unavailable ? <PageHeader title={view === "profile" ? "Your profile" : "Invites"} /> : null}
          {view === "profile" ? (
            <div style={{ maxWidth: "18.75rem" }}>
              <ProfileInvitesCardView
                callsign="kaleo_on_blast"
                loading={state === "loading"}
                summary={unavailable ? undefined : summary}
              />
            </div>
          ) : state === "loading" ? (
            <PendingPanel framed label="Loading referral payments" />
          ) : state === "error" ? (
            <EmptyState framed role="alert" title="Referral payments couldn’t load" />
          ) : (
            <SocialViewerProvider callsign="kaleo_on_blast" signedIn>
              <InvitesPage />
            </SocialViewerProvider>
          )}
        </AppShell>
      </QueryProvider>
    </div>
  );
}
