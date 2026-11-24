"use client";
import { useSyncExternalStore } from "react";
const subscribe = () => () => {};
const clientReady = () => true;
const serverReady = () => false;
import { AppShell } from "../../../src/components/blast-ui/AppShell";
import { PageHeader } from "../../../src/components/blast-ui/PageHeader";
import { QueryProvider } from "../../../src/lib/query/provider";
import {
  geist,
  geistMono,
  bricolage,
} from "../../../src/components/blast-ui/fonts";
import {
  ProfileInvitesView,
  ProfileInvitesCardView,
} from "../../../src/components/social/profile/ProfileInvites";
import { InviteesView } from "../../../src/components/social/referrals/InvitesPage";
import type { ReferralSummary } from "@blast/core/modules/social/referrals/contracts.ts";
import profileStyles from "../../../src/components/social/profile/Profile.module.css";
export function ReferralFixture({
  view = "invites",
  theme = "light",
  state = "ready",
}: Readonly<{ view?: string; theme?: string; state?: string }>) {
  const hydrated = useSyncExternalStore(subscribe, clientReady, serverReady);
  const accounting = {
    assets: [
      {
        coin_type: "0x2::sui::SUI",
        symbol: "SUI",
        decimals: 9,
        volume_atoms: "100000000000",
        revenue_atoms: "1000000000",
        earnings_atoms: "600000000",
      },
    ],
    share_bps: 6000 as const,
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
      <QueryProvider>
        <AppShell
          signedIn={false}
          viewer={null}
          portfolio={{ status: "unavailable" }}
          signInHref="/sign-in"
        >
          <p>Test fixture · Simulated referral data · No payments</p>
          <PageHeader title={view === "profile" ? "Your profile" : "Invites"} />
          {view === "profile" ? (
            <div style={{ maxWidth: "18.75rem" }}>
              <ProfileInvitesCardView
                callsign="kaleo_on_blast"
                loading={state === "loading"}
                summary={unavailable ? undefined : summary}
              />
            </div>
          ) : (
            <div className={profileStyles.page}>
              <ProfileInvitesView
                callsign="kaleo_on_blast"
                failed={state === "error"}
                onRetry={() => {}}
                summary={unavailable ? undefined : summary}
              />
              <InviteesView
                invitees={
                  state === "empty" || unavailable
                    ? []
                    : [
                        {
                          id: "00000000-0000-4000-8000-000000000001",
                          callsign: "first_follower",
                          display_name: "First follower",
                          avatar_url: null,
                          x_handle: "first_follower",
                          joined_at_ms: 1790000000000,
                          accounting,
                        },
                        {
                          id: "00000000-0000-4000-8000-000000000002",
                          callsign: "long_name",
                          display_name:
                            "A very long follower name with emoji 🌏🌈",
                          avatar_url: null,
                          x_handle: "a_long_x_handle",
                          joined_at_ms: 1790000000000,
                          accounting: {
                            ...accounting,
                            assets: [
                              {
                                ...accounting.assets[0],
                                volume_atoms: "999999999999999999999",
                                revenue_atoms: "3",
                                earnings_atoms: "1",
                              },
                            ],
                            pending_events: 1,
                          },
                        },
                      ]
                }
                pending={state === "loading"}
                failed={state === "error"}
                hasMore={false}
                loadingMore={false}
                onMore={async () => {}}
                onRetry={() => {}}
              />
            </div>
          )}
        </AppShell>
      </QueryProvider>
    </div>
  );
}
