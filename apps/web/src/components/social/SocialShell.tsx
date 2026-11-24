"use client";

import { NOTIFICATIONS_PATH, isHomePath } from "#web/components/blast-ui/nav.ts";
import { TrendingCoinStrip } from "./happening/TrendingCoinStrip";
import { usePathname } from "next/navigation";
import { useMemo, type ReactNode } from "react";

import { AppShell } from "#web/components/blast-ui/AppShell.tsx";
import { useListTraversal } from "#web/components/blast-ui/list-restoration.ts";
import { ToastProvider } from "#web/components/blast-ui/Toasts.tsx";
import { shellViewerOf } from "#web/components/blast-ui/shell-viewer.ts";
import { PORTFOLIO_LOADING } from "#web/components/blast-ui/portfolio.ts";
import { SignInSheet } from "#web/components/sign-in/SignIn.tsx";

import { AccountAvatar } from "./AccountAvatar";
import type { RenderAvatar } from "#web/components/blast-ui/ShellAvatar.tsx";
import { useClaimHost } from "./claim/ClaimHost";
import { useCommitHost } from "./commit/CommitHost";
import { useTradeHost } from "./trade/TradeHost";
import { FeedOverlaysProvider } from "./feed-ui/shell-bridge";
import { CelebrationHost } from "./celebration/CelebrationHost";
import { LiveQueries } from "./LiveQueries";
import { ShellPortfolioProvider } from "./shell-portfolio-context";
import { signInHref } from "./sign-in-gate";
import { useAccountSettingsSync } from "./settings/use-account-settings-sync";
import { useSocialViewer } from "./SignInGate";
import { useSocialAccount } from "./use-social-account";
import { useHeaderSession, type HeaderSession } from "./use-header-session";
import { BalancesProvider, useBalances } from "./coins/balances";
import { CoinsHost } from "./coins/CoinsHost";
import { UnreadNotificationsProvider, useUnreadNotificationsState } from "./notifications/use-unread-notifications";
import { useNotificationArrivals } from "./notifications/use-notification-arrivals";
import { SearchSheet } from "./search/SearchSheet";
import { WatchlistProvider } from "./watchlist/Watchlist";
import { LaunchpadFlagProvider } from "#web/components/blast-ui/launchpad-flag.tsx";
import { useShellPortfolio } from "./use-shell-portfolio";

const renderAccountAvatar: RenderAvatar = (props) => <AccountAvatar {...props} />;

/**
 * The frame of every social page (`src/app/(app)/layout.tsx`) and, while
 * the social feed is on, of `/settings` and `/sign-in`: the canonical UI's
 * app shell (`AppShell`, FEATURE-MAP §1) fed by the social session. Visitors
 * read every page; the rail and top bar offer "Sign in", which opens the
 * sign-in sheet over the page (`/sign-in?next=<this page>` is the link
 * underneath). The shell's overlays hold that sheet. A
 * signed-in viewer gets Portfolio's figures (their total and today's move, T-019 and R3-20; OA-41), the
 * account avatar and its menu (profile, Settings, appearance, log out). Search (§12) is one more
 * overlay, and the watchlist (UI-12) is shared by every star and card below.
 * The commit and sale dialogs (§4, §11) are one more overlay, handed to every
 * post below through `FeedOverlaysProvider`, so "Blast" and "View presale"
 * open a dialog instead of navigating. `presaleDeployed` is the layout's
 * server-side `PRESALE_DEPLOYMENT_MANIFEST` read: while it is false the dialog
 * still opens and quotes, and blasting is off with a published reason, exactly
 * as Create's publishing is. The claim transaction (R3-63) rides along on the
 * same provider and the same gate: no mainnet deployment, no claim button.
 * `rail` fills the right column on every page but the coin Home, whose ledger takes the width; it
 * column and `banner` sits above the page; both may be empty.
 */
type SocialShellProps = Readonly<{ banner?: ReactNode; initialSession?: HeaderSession | null; rail?: ReactNode; presaleDeployed?: boolean; launchpad?: boolean; children: ReactNode }>;

export function SocialShell(props: SocialShellProps) {
  return <ToastProvider><SocialShellContent {...props} /></ToastProvider>;
}

function SocialShellContent({
  banner,
  initialSession = null,
  rail,
  presaleDeployed = false,
  launchpad = false,
  children,
}: SocialShellProps) {
  const pathname = usePathname();
  useListTraversal(isHomePath);
  const viewer = useSocialViewer();
  const { account, status, refresh: refreshAccount } = useSocialAccount();
  const shellViewer = viewer.signedIn && account ? shellViewerOf(account) : null;
  const headerSession = useHeaderSession(initialSession, {
    signedIn: viewer.signedIn,
    viewer: shellViewer,
    viewerLoading: status === "loading",
    viewerError: status === "error",
  }, viewer.signOut);
  useAccountSettingsSync(shellViewer?.accountId ?? null, viewer.getAccessToken);
  const portfolio = useShellPortfolio({
    enabled: viewer.signedIn,
    accountId: shellViewer?.accountId ?? null,
    getAccessToken: viewer.getAccessToken,
  });
  const shared = useMemo(
    () => ({ state: portfolio.state, portfolio: portfolio.portfolio, refresh: portfolio.refresh }),
    [portfolio.state, portfolio.portfolio, portfolio.refresh],
  );
  const unread = useUnreadNotificationsState({ accountId: shellViewer?.accountId ?? null, getAccessToken: viewer.getAccessToken });
  const subscribeNotificationArrivals = useNotificationArrivals(shellViewer?.accountId ?? null, viewer.getAccessToken, unread.set);
  // UI-14: a deposit landing or a withdrawal going out makes every balance read again ("balances move").
  const balances = useBalances(portfolio.refresh);
  // The balances go in: this hook runs above the BalancesProvider it would otherwise read.
  const commit = useCommitHost({ presaleDeployed, balances });
  // R3-63: the claim transaction, beside the commit and gated the same way.
  const claim = useClaimHost({ presaleDeployed });
  // R3-55: the one trade path (quote and swap) every trading surface runs. Not gated on the presale
  // deployment: the route builds, and the wallet pays when Blast cannot sponsor.
  const trade = useTradeHost({ balances });
  const overlays = useMemo(
    () => ({ ...commit.overlays, claimPath: claim.claimPath, tradeKit: trade.tradeKit }),
    [claim.claimPath, commit.overlays, trade.tradeKit],
  );
  return (
    <LaunchpadFlagProvider value={launchpad}>
    <BalancesProvider value={balances}>
    <ShellPortfolioProvider value={shared}>
    <UnreadNotificationsProvider value={unread}>
    <WatchlistProvider getAccessToken={viewer.getAccessToken} signedIn={viewer.signedIn && viewer.callsign !== null} viewerKey={viewer.callsign ?? ""}>
    <FeedOverlaysProvider value={overlays}>
    <AppShell
      renderAvatar={renderAccountAvatar}
      aside={isHomePath(pathname) ? null : rail}
      asideMini={<TrendingCoinStrip />}
      banner={banner}
      onRetryAccount={refreshAccount}
      onRetryPortfolio={portfolio.refresh}
      overlays={
        <>
          <SignInSheet />
          <SearchSheet />
          <CoinsHost />
          <CelebrationHost />
          <LiveQueries />
          {commit.node}
          {claim.node}
          {trade.node}
        </>
      }
      portfolio={status === "loading" ? PORTFOLIO_LOADING : portfolio.state}
      signInHref={signInHref(pathname)}
      notificationsHref={NOTIFICATIONS_PATH}
      unreadCount={unread.count}
      subscribeNotificationArrivals={subscribeNotificationArrivals}
      {...headerSession}
    >
      {children}
    </AppShell>
    </FeedOverlaysProvider>
    </WatchlistProvider>
    </UnreadNotificationsProvider>
    </ShellPortfolioProvider>
    </BalancesProvider>
    </LaunchpadFlagProvider>
  );
}
