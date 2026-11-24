"use client";

import { useState } from "react";
import { QueryClient } from "@tanstack/react-query";
import { QueryProvider } from "../../../src/lib/query/provider.tsx";
import { queryKeys } from "../../../src/lib/query/keys.ts";
import { SocialViewerProvider } from "../../../src/components/social/SignInGate.tsx";
import { CreateVesting } from "../../../src/components/vesting/CreateVesting.tsx";
import { PortfolioView } from "../../../src/components/social/portfolio/PortfolioView.tsx";
import { ProfileInvitesLoading } from "../../../src/components/social/profile/ProfileInvites.tsx";
import { LaunchRewardsSkeleton } from "../../../src/components/social/launch-rewards/LaunchRewardsSkeleton.tsx";
import { AppShell } from "../../../src/components/blast-ui/AppShell.tsx";
import { Button } from "../../../src/components/blast-ui/Button.tsx";
import { useShellPrefs, setShellPref } from "../../../src/components/blast-ui/use-shell-prefs.ts";
import { ShellPrefsBoot } from "../../../src/components/blast-ui/ShellPrefsBoot.tsx";
import { bricolage, geist, geistMono } from "../../../src/components/blast-ui/fonts.ts";
import { FIXTURE_COINS } from "../social/coins/coins-fixture-model.ts";
import { FIXTURE_WALLET_ADDRESS } from "../social/coins/coins-fixture-model.ts";
import { PORTFOLIO, PORTFOLIO_COINS, NOW } from "./parity-fixtures";
import { portfolioCoverage, portfolioFigures } from "../../../src/components/social/portfolio/portfolio-model.ts";

const token = async () => null;
const readyHistory = { status: "ready" as const, trend: null, first: null, last: null };
/** Production components, synthetic cache only. Browser verification rejects all external requests. */
export function AcceptanceFixture({ initial }: { initial: Record<string, string | undefined> }) {
  const [phase, setPhase] = useState(initial.phase ?? "pending");
  const [client] = useState(() => {
    const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false, refetchOnWindowFocus: false } } });
    cache.setQueryData(queryKeys.me.wallet(), { address: FIXTURE_WALLET_ADDRESS, fee: "sponsored", coins: [] });
    cache.setQueryData(["blast", "me", "vesting-coins", FIXTURE_WALLET_ADDRESS], FIXTURE_COINS);
    cache.setQueryData(["blast", "me", "vesting"], { wallet: FIXTURE_WALLET_ADDRESS, schedules: [] });
    return cache;
  });
  return <QueryProvider client={client}><div className={`${bricolage.variable} ${geist.variable} ${geistMono.variable}`} data-blast-ui="" data-theme={initial.theme ?? "dark"} suppressHydrationWarning>
    <ShellPrefsBoot nonce={null} />
    <SocialViewerProvider signedIn={phase !== "pending" && phase !== "visitor"} sessionPending={phase === "pending"} callsign={phase === "pending" ? null : "fixture-reader"} getAccessToken={token}>
      <AppShell portfolio={{ status: "unavailable" }} signInHref="/sign-in" signedIn viewer={{ accountId: "fixture-reader", callsign: "fixture-reader", displayName: "Fixture reader", avatarUrl: null, verified: false }}>
        <div data-fixture-controls=""><Button onClick={() => setPhase("ready")}>Resolve session</Button><Button onClick={() => setPhase("pending")}>Pending session</Button><Button onClick={() => setShellPref("amountsHidden", true)}>Hide amounts</Button></div>
        {initial.surface === "portfolio" ? <Portfolio /> : initial.surface === "skeletons" ? <><ProfileInvitesLoading /><LaunchRewardsSkeleton label="Loading launchpad creator fees" line="Creator fees" figures={["Earned", "Claimed", "Unclaimed"]} /></> : <CreateVesting />}
      </AppShell>
    </SocialViewerProvider>
  </div></QueryProvider>;
}
function Portfolio() {
  const hidden = useShellPrefs().amountsHidden;
  return <PortfolioView nowMs={NOW} initialTab="claims" data={{ mode: "ready", portfolio: "ready", figures: portfolioFigures(PORTFOLIO), valuation: portfolioCoverage(PORTFOLIO), today: null, history: { "1w": readyHistory, "1m": readyHistory, all: readyHistory }, isPublic: false, coins: PORTFOLIO_COINS, prices: new Map(), holdingsFailed: false, rewards: { status: "ready", coins: [], latest: [], retry: () => undefined }, holdings: { created: [], positions: [], watchlist: [], coins: [], vestings: [] }, hidden }} />;
}
