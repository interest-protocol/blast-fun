"use client";
import { RefreshButton } from "./CoinsRows";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";

import type { SocialPortfolio } from "@blast/core/web/contracts/portfolio.ts";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { useQuery } from "@tanstack/react-query";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { AccessTokenSource } from "../../social-fetch";
import { portfolioQuery } from "../../queries";
import { useAmountsHidden } from "../../profile/use-profile-data";
import { PARTIAL_BALANCE_NOTE } from "#web/components/blast-ui/account-balance-model.ts";
import { heroFigures, pricedFigures, portfolioFigures, totalParts, todayChange } from "../../portfolio/portfolio-model";
import { dockToday } from "../../portfolio/today-model";
import { SignInLink } from "../../SignInGate";
import { HelmetMark } from "#web/components/blast-ui/Icons.tsx";
import { useCurrentBlastAccount } from "./BlastActionProvider";
import { ActorAvatar } from "./ActorCell";
import { useWorkspace } from "./workspace-context";
import { PortfolioCoins, type PortfolioTradeAction } from "./PortfolioCoins";
import { PortfolioPresales } from "./PortfolioPresales";
import { PortfolioPending } from "./PortfolioPending";
import { LoadFailed, RefreshFailed } from "./DataStates";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import styles from "./CoinsData.module.css";
import portfolioStyles from "./PortfolioData.module.css";

export function PortfolioData() {
  const { snapshot, presentation } = useWorkspace();
  return presentation.mode_open && presentation.document_visible &&
    !snapshot.data.collapsed && snapshot.data.enabled_views.includes("Portfolio") &&
    snapshot.data.selected_view === "Portfolio" ? <PortfolioIdentity /> : null;
}

export function PortfolioIdentity({ onTrade }: Readonly<{ onTrade?: PortfolioTradeAction }> = {}) {
  const { accountState, getAccessToken } = useCurrentBlastAccount();
  const { entry_generation } = useWorkspace();
  if (!accountState || accountState.status === "loading" || accountState.sessionStatus === "pending")
    return <PortfolioPending label="Checking portfolio account" quickTrade={!!onTrade} />;
  if (accountState.status === "error" || accountState.sessionStatus === "refused")
    return <EmptyState action={<SignInLink variant="secondary" />} compact role="alert" title="Your account could not be checked">Sign in again to see your portfolio.</EmptyState>;
  if (accountState.sessionStatus === "signed_out" || accountState.status === "signed_out")
    return <EmptyState action={<SignInLink variant="secondary" />} compact title="Sign in to see your portfolio" />;
  if (!accountState.account)
    return <EmptyState action={<SignInLink variant="secondary" />} compact title="Finish setting up your account">Then your portfolio shows here.</EmptyState>;
  const scope = `${accountState.account.account_id}:${accountState.sessionIdentity ?? ""}:${entry_generation}`;
  return onTrade ? <PortfolioCoins key={scope} scope={scope} getAccessToken={getAccessToken} onTrade={onTrade} /> : <PortfolioContent key={scope} scope={scope} getAccessToken={getAccessToken} />;
}

const PORTFOLIO_SECTIONS = [["summary", "Summary"], ["coins", "Coins"], ["presales", "Presales"]] as const;

function PortfolioContent({ scope, getAccessToken }: Readonly<{ scope: string; getAccessToken: AccessTokenSource }>) {
  const { snapshot, dispatch } = useWorkspace();
  const controls = snapshot.data.controls.Portfolio;
  const select = (tab: typeof controls.tab) => dispatch.patchDataControls("Portfolio", { ...controls, tab, navigation: { ...controls.navigation, scroll_top: 0, anchor: null } });
  return <>
    <div className={`${styles.controls} ${portfolioStyles.tabs}`}>
      <Segmented tabs stretch size="sm" label="Portfolio sections" options={PORTFOLIO_SECTIONS} value={controls.tab} onChange={select} />
    </div>
    {controls.tab === "summary" && <PortfolioSummary getAccessToken={getAccessToken} />}
    {controls.tab === "coins" && <PortfolioCoins scope={scope} getAccessToken={getAccessToken} />}
    {controls.tab === "presales" && <PortfolioPresales scope={scope} getAccessToken={getAccessToken} />}
  </>;
}

/** The shell's own portfolio read (the top bar's balance), so the card and the bar show one total, never two reads apart in time. */
function PortfolioSummary({ getAccessToken }: Readonly<{ getAccessToken: AccessTokenSource }>) {
  const options = portfolioQuery(getAccessToken);
  const read = useQuery({
    ...options,

    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: false,
  }, useAppQueryClient());
  const hidden = useAmountsHidden();
  if (!read.data) return read.isError ? <LoadFailed onRetry={() => void read.refetch()} retryLabel="Retry portfolio" title="Your portfolio could not load" /> : <div aria-label="Loading portfolio summary" role="status" aria-busy="true"><SkeletonText>Portfolio value and holdings</SkeletonText></div>;
  return (
    <PortfolioSummaryDetails
      data={read.data}
      hidden={hidden}
      refreshing={read.isFetching}
      failed={read.isError}
      refresh={() => void read.refetch()}
    />
  );
}

function PortfolioSummaryDetails({ data, hidden, refreshing, failed, refresh }: Readonly<{
  data: SocialPortfolio;
  hidden: boolean;
  refreshing: boolean;
  failed: boolean;
  refresh: () => void;
}>) {
  const { accountState } = useCurrentBlastAccount();
  const figures = portfolioFigures(data);
  const priced = pricedFigures(data);
  const total = totalParts(figures.total ?? priced?.total ?? null, hidden);
  const account = accountState?.account ?? null;
  const name = account ? (account.display_name ?? "").trim() || account.callsign : null;
  return <section aria-label="Portfolio summary" className={portfolioStyles.summary}>
    <div className={portfolioStyles.card}>
      <HelmetMark className={portfolioStyles.watermark} />
      <div className={portfolioStyles.who}>
        {account && <ActorAvatar identity={{ kind: "account", callsign: account.callsign, name: name!, avatarUrl: account.avatar_url, verified: account.verified }} size={28} />}
        <span className={portfolioStyles.owner}>{name}</span>
        <span className={portfolioStyles.private}>Only you</span>
      </div>
      {total !== null && <div>
        <p className={portfolioStyles.label}>Portfolio value</p>
        <p className={`${portfolioStyles.total} num`}><TotalFigure whole={total.whole} cents={total.cents} /></p>
      </div>}
      {total === null && <p className={portfolioStyles.label} role="status">USD value unavailable</p>}
      {priced && !hidden && <p className={portfolioStyles.label}>{PARTIAL_BALANCE_NOTE}</p>}
      <PortfolioDayChange data={data} hidden={hidden} />
    </div>
    <dl className={portfolioStyles.figures}>
      {heroFigures(figures, hidden, true, priced).map(figure => <div key={figure.key}><dt>{figure.label}</dt><dd className="num">{figure.value}</dd></div>)}
    </dl>
    <PortfolioSummaryStatus data={data} refreshing={refreshing} failed={failed} refresh={refresh} />
  </section>;
}

function PortfolioDayChange({ data, hidden }: Readonly<{ data: SocialPortfolio; hidden: boolean }>) {
  const change = todayChange(dockToday(data, [], null), hidden);
  if (!change) return null;
  return <span className={`${portfolioStyles.day} num`} data-tone={change.tone ?? undefined}>
    {change.tone ? <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.4" viewBox="0 0 24 24"><path d={change.tone === "up" ? "m6 15 6-6 6 6" : "m6 9 6 6 6-6"} /></svg> : null}
    {change.text} today
  </span>;
}

/** The total at display size: the currency sign and cents quieter, every digit kept. */
function TotalFigure({ whole, cents }: Readonly<{ whole: string; cents: string }>) {
  const sign = whole.startsWith("$") ? "$" : "";
  return <><span className={portfolioStyles.pre}>{sign}</span>{whole.slice(sign.length)}<span className={portfolioStyles.cents}>{cents}</span></>;
}

function PortfolioSummaryStatus({ data, refreshing, failed, refresh }: Readonly<{ data: SocialPortfolio; refreshing: boolean; failed: boolean; refresh: () => void }>) {
  return (
    <div className={portfolioStyles.status}>
      {data.wallet_sync?.status === "syncing" && <p role="status">Wallet balances are syncing.</p>}
      {data.wallet_sync?.status === "stale" && <p role="status">Wallet balances are delayed.</p>}
      {failed && <RefreshFailed title="Your portfolio could not refresh" />}
      <RefreshButton busy={refreshing} label="Refresh portfolio" onRefresh={refresh} title="Refresh portfolio" />
    </div>
  );
}
