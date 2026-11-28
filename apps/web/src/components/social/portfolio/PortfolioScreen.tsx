"use client";

import { pollInterval } from "#web/lib/query/polling.ts";
import { diagnosticMessage, PublicError, publicErrorMessage } from "#web/lib/errors.ts";
import { useNow } from "#web/components/presale-pages/presales-client.ts";

import { useQueries, useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useState } from "react";
import { ButtonLink } from "#web/components/blast-ui/Button.tsx";
import { useListRestoration } from "#web/components/blast-ui/list-restoration.ts";
import type { SocialPortfolio } from "@blast/core/web/contracts/portfolio.ts";

import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { SocialPriceHistory } from "@blast/core/web/contracts/prices.ts";

import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { priceQuery } from "../prices/price-client";
import type { HoldingCoin } from "../profile/profile-model";
import { useAmountsHidden, useHydrated, useMePresales } from "../profile/use-profile-data";
import { creatorCommitmentQuery, portfolioQuery, settingsQuery, walletIdentityQuery, walletQuery } from "../queries";
import { useAccountWallets, useWalletSuiName, walletSessionName } from "../account-wallets";
import type { AccountSession } from "../account-selection";
import { useSignInGate, useSocialViewer } from "../SignInGate";
import { useCreatorEarnings } from "../creator-earnings/use-creator-earnings";
import { usePayoutToasts, useRewards } from "../rewards/use-rewards";
import { useSocialAccount, type UseSocialAccount } from "../use-social-account";
import { combinedPricedFigures, combinePortfolioFigures, portfolioFigures, priceAskOf, pricedFigures } from "./portfolio-model";
import type { PortfolioTab } from "#web/components/blast-ui/portfolio-navigation.ts";
import { PortfolioView, WALLET_UNAVAILABLE, type PortfolioMode, type PortfolioViewData, type PortfolioWalletSelection } from "./PortfolioView";
import type { CreatorAccountRead, CreatorWalletRead } from "../launch-rewards/LaunchRewards";
import { dockToday } from "./today-model";
import { canonicalizePortfolio } from "./portfolio-tab";
import { RewardRoundsProvider } from "../rewards/RewardsPage";

import { usePortfolioCoins } from "./use-portfolio-coins";
import { usePortfolioHistory } from "./portfolio-history";
import { usePortfolioTab } from "./portfolio-tab";

const noToken = async () => null;

function portfolioState({ hydrated, signedIn, status, account, portfolio, failed }: Readonly<{
  hydrated: boolean;
  signedIn: boolean;
  status: UseSocialAccount["status"];
  account: UseSocialAccount["account"];
  portfolio: SocialPortfolio | null;
  failed: boolean;
}>): Pick<PortfolioViewData, "mode" | "portfolio"> {
  let mode: PortfolioMode;
  if ((!hydrated && !portfolio) || status === "loading") mode = "loading";
  else if (!signedIn || status === "signed_out") mode = "visitor";
  else if (!account && status !== "error") mode = "no-account";
  else mode = "ready";
  // An account or portfolio read failure must not leave the page waiting forever.
  return { mode, portfolio: status === "error" || (failed && !portfolio) ? "error" : portfolio ? "ready" : "loading" };
}

function usePortfolioPrices(coins: readonly HoldingCoin[], active: boolean) {
  const client = useAppQueryClient();
  const asks = coins.flatMap((coin) => {
    const ask = priceAskOf(coin, SUI_COIN_TYPE);
    return ask ? [{ key: coin.key, ask }] : [];
  });
  const priceReads = useQueries(
    {
      queries: asks.map(({ ask }) => ({
        ...priceQuery({ kind: ask.presaleId ? ("presale" as const) : ("coin" as const), id: ask.presaleId ?? ask.coin ?? "", window: "24h" }),
        enabled: active,
      })),
    },
    client,
  );
  const prices = new Map<string, SocialPriceHistory | null>();
  asks.forEach(({ key }, index) => {
    const read = priceReads[index];
    if (read?.data !== undefined) prices.set(key, read.data);
    else if (read?.isError) prices.set(key, null);
  });
  // Full responses use these figures too; summaries carry today’s all-wallet move.
  const salePrices = asks.flatMap(({ key, ask }) => (ask.presaleId ? [prices.get(key)].filter((price): price is SocialPriceHistory => !!price) : []));
  return { prices, salePrices };
}

/** Owner summary and one page of wallet holdings; transactions invalidate both shared reads. */
export function PortfolioScreen({ nowMs, initialTab = "coins" }: Readonly<{ nowMs: number; initialTab?: PortfolioTab }>) {
  const currentTime = useNow(nowMs, 30_000);
  const tab = usePortfolioTab(initialTab);
  const { viewer, hydrated, status, account, getAccessToken, active, settingsRead, blastWallet, commitment } = usePortfolioAccountReads(tab);
  const wallets = useWalletPortfolios(active);
  useLayoutEffect(() => { canonicalizePortfolio(); }, [tab]);
  const restoration = useListRestoration(`portfolio:${viewer.callsign ?? "visitor"}:${tab}`, null, () => undefined);
  const me = useMePresales(active, true);
  const hidden = useAmountsHidden();
  // OA-45: the Rewards tab's read; a payout newer than this device last saw is announced.
  const rewards = useRewards();
  const creatorEarnings = useCreatorEarnings(active && tab === "claims");
  usePayoutToasts(rewards.view?.latest ?? null);

  const balance = usePortfolioHoldings(tab, active, getAccessToken, wallets);
  const holdings = me.status === "ready" ? me.value : null;
  const state = portfolioState({ hydrated, signedIn: viewer.signedIn, status, account, portfolio: balance.visiblePortfolio, failed: balance.failed });

  return (
    <div ref={restoration}><RewardRoundsProvider meta={rewards.meta}><PortfolioView
      initialTab={initialTab}
      data={{
        ...state,
        ...balance.data,
        holdingsErrorMessage: me.status === "error" ? me.message : undefined,
        retryHoldings: me.retry,
        isPublic: wallets.combined ? undefined : settingsRead.data?.public_portfolio ?? null,
        walletUnavailable: wallets.unavailable,
        holdings,
        holdingsFailed: me.status === "error",
        hidden,
        creatorEarnings,
        launchWallets: account?.wallets.map((wallet) => wallet.address),
        claimWallet: blastWallet.data?.address ?? null,
        creatorWallet: walletRead(blastWallet),
        creatorAccount: commitmentRead(commitment),
        rewards: rewardSectionData(rewards),
      }}
      nowMs={currentTime}
      signIn={<SignIn />}
    /></RewardRoundsProvider></div>
  );
}

type PortfolioWalletReads = ReturnType<typeof useWalletPortfolios>;

function walletSelectionData(
  wallets: PortfolioWalletReads, first: ReturnType<typeof usePortfolioCoins>, second: ReturnType<typeof usePortfolioCoins>,
): PortfolioViewData["walletSelection"] {
  if (!wallets.combined) return undefined;
  const { portfolioRead, otherRead, walletCards, selection, setSelection, showingOther, showingBoth, activeSession } = wallets;
  const firstCard = { ...walletCards[0], total: portfolioFigures(portfolioRead.data ?? null).total };
  const secondCard = { ...walletCards[1], total: portfolioFigures(otherRead.data ?? null).total };
  const groups = [
    { ...firstCard, coins: first.coins, page: first.controls, sync: portfolioRead.data?.wallet_sync?.status },
    { ...secondCard, coins: second.coins, page: { ...second.controls, onSearch: first.controls.onSearch, ...(showingBoth ? { onHideSmall: undefined } : {}) }, sync: otherRead.data?.wallet_sync?.status },
  ];
  return { value: selection, select: setSelection, wallets: [firstCard, secondCard], groups: showingBoth ? groups : groups.filter(group => group.session === (showingOther ? wallets.otherSession : activeSession)) };
}

function displayedPortfolio(wallets: PortfolioWalletReads) {
  const { portfolioRead, otherRead, showingOther, showingBoth, combined } = wallets;
  const active = portfolioRead.data ?? null;
  const other = combined ? otherRead.data ?? null : null;
  const read = showingOther ? otherRead : portfolioRead;
  const portfolio = showingOther ? other : active;
  const failed = read.isError || (showingBoth && otherRead.isError);
  const visiblePortfolio = wallets.resolving || (showingBoth && !other) ? null : portfolio;
  return {
    active, other, portfolio, visiblePortfolio, failed,
    refreshFailed: visiblePortfolio !== null && failed,
    lastUpdatedMs: showingBoth ? Math.min(portfolioRead.dataUpdatedAt, otherRead.dataUpdatedAt) : read.dataUpdatedAt,
    errorMessage: publicErrorMessage(read.error ?? otherRead.error, "Your portfolio could not load. Try again."),
    retryPortfolio: () => {
      void read.refetch();
      if (showingBoth) void otherRead.refetch();
    },
  };
}

function usePortfolioHoldings(tab: PortfolioTab, active: boolean, getAccessToken: () => Promise<string | null>, wallets: PortfolioWalletReads) {
  const { selection, showingBoth, showingOther, combined } = wallets;
  const shown = displayedPortfolio(wallets);
  const readingCoins = active && tab === "coins";
  const first = usePortfolioCoins(getAccessToken, readingCoins && !showingOther && !wallets.resolving, combined ? wallets.activeAddress : undefined);
  const second = usePortfolioCoins(wallets.otherToken, readingCoins && combined && selection !== wallets.activeSession, wallets.otherAddress, first.controls.search);

  const visibleCoins = [...new Map([...first.coins, ...second.coins].map(coin => [coin.key, coin])).values()];
  const { prices, salePrices } = usePortfolioPrices(visibleCoins, readingCoins);
  const canReadHistory = active && !combined && !wallets.resolving;
  const history = usePortfolioHistory(getAccessToken, canReadHistory);
  const totals = portfolioTotals(shown, showingBoth, salePrices, prices.get("sui"));
  return {
    visiblePortfolio: shown.visiblePortfolio,
    failed: shown.failed,
    data: {
      refreshFailed: shown.refreshFailed,
      lastUpdatedMs: shown.lastUpdatedMs,
      errorMessage: shown.errorMessage,
      retryPortfolio: shown.retryPortfolio,
      ...totals,
      history: canReadHistory ? history : undefined,
      coins: showingOther ? second.coins : first.coins,
      coinPage: first.controls,
      walletSelection: walletSelectionData(wallets, first, second),
      prices,
    },
  };
}

function portfolioTotals(shown: ReturnType<typeof displayedPortfolio>, showingBoth: boolean,
  salePrices: readonly SocialPriceHistory[], suiPrice: SocialPriceHistory | null | undefined) {
  const { portfolio, active } = shown;
  const both = showingBoth ? shown.other : null;
  const figures = showingBoth
    ? combinePortfolioFigures(portfolioFigures(active), portfolioFigures(both))
    : portfolioFigures(portfolio);
  const priced = showingBoth ? combinedPricedFigures(active, both) : pricedFigures(portfolio);
  return {
    figures,
    priced,
    valuation: priced && { knownUsd: priced.total },
    vesting: portfolio?.vesting,
    walletSync: portfolioSync(portfolio, both),
    holdingsUnread: portfolioUnread(portfolio) || portfolioUnread(both),
    today: showingBoth ? combinedToday(active, both) : dockToday(portfolio, salePrices, suiPrice),
  };
}

function portfolioSync(portfolio: SocialPortfolio | null, other: SocialPortfolio | null) {
  const status = other?.wallet_sync?.status;
  return status && status !== "ready" ? status : portfolio?.wallet_sync?.status;
}

function portfolioUnread(portfolio: SocialPortfolio | null) {
  return Boolean(portfolio?.unavailable.some((part) => part === "balances" || part === "coins" || part === "positions" || part === "totals"));
}

function combinedToday(first: SocialPortfolio | null, second: SocialPortfolio | null) {
  const a = first?.coin_summary?.today;
  const b = second?.coin_summary?.today;
  const total = combinePortfolioFigures(portfolioFigures(first), portfolioFigures(second)).total;
  if (!a || !b || total === null) return null;
  const usd = a.usd + b.usd;
  const base = total - usd;
  return { usd, pct: base > 0 ? (usd / base) * 100 : 0 };
}

function portfolioWalletAddress(read: Read<Readonly<{ address: string | null }>>) {
  return read.isError ? undefined : read.data?.address ?? undefined;
}

function usePortfolioWalletIdentities(wallets: ReturnType<typeof useAccountWallets>, enabled: boolean) {
  const client = useAppQueryClient();
  const dual = enabled && wallets.hasOther;
  const identity = useQuery({ ...walletIdentityQuery(wallets.activeScope, wallets.activeToken), enabled: dual }, client);
  const otherIdentity = useQuery({ ...walletIdentityQuery(wallets.otherScope, wallets.otherToken), enabled: dual }, client);
  const activeAddress = portfolioWalletAddress(identity);
  const otherAddress = portfolioWalletAddress(otherIdentity);
  const resolving = dual && (identity.isPending || otherIdentity.isPending);
  const bothReady = Boolean(activeAddress && otherAddress);
  const combined = dual && bothReady && activeAddress !== otherAddress;
  const error = otherIdentity.error ?? identity.error;
  const unavailable = dual && !resolving && !bothReady ? {
    message: diagnosticMessage(WALLET_UNAVAILABLE, error instanceof PublicError ? error : { code: "wallet_missing" }),
    retry: () => { void identity.refetch(); void otherIdentity.refetch(); },
  } : undefined;
  return { activeAddress, otherAddress, resolving, combined, unavailable };
}

function useWalletPortfolios(enabled: boolean) {
  const client = useAppQueryClient();
  const wallets = useAccountWallets();
  const [selection, setSelection] = useState<PortfolioWalletSelection>("all");
  const { activeAddress, otherAddress, resolving, combined, unavailable } = usePortfolioWalletIdentities(wallets, enabled);
  const showingBoth = combined && selection === "all";
  const showingOther = combined && selection === wallets.otherSession;
  const portfolioRead = useQuery({
    ...portfolioQuery(wallets.activeToken, undefined, true, combined ? activeAddress : undefined),
    enabled: enabled && !resolving && !showingOther,
    refetchInterval: (query) => pollInterval(query.state.data?.wallet_sync?.status === "syncing" ? 5_000 : 60_000, query),
  }, client);
  const otherRead = useQuery({
    ...portfolioQuery(wallets.otherToken, undefined, true, otherAddress),
    enabled: combined && selection !== wallets.activeSession,
    refetchInterval: (query) => pollInterval(query.state.data?.wallet_sync?.status === "syncing" ? 15_000 : 60_000, query),
  }, client);
  const activeSuiName = useWalletSuiName(combined ? activeAddress : undefined);
  const otherSuiName = useWalletSuiName(combined ? otherAddress : undefined);
  const card = (session: AccountSession, address: string | undefined, suiName: string | null) => {
    const method = session === "privy" ? wallets.oauthName : walletSessionName(address);
    return { session, address, name: suiName ?? method, method, active: session === wallets.activeSession };
  };
  const walletCards = [card(wallets.activeSession, activeAddress, activeSuiName), card(wallets.otherSession, otherAddress, otherSuiName)] as const;
  return { ...wallets, portfolioRead, otherRead, activeAddress, otherAddress, walletCards, selection, setSelection, combined, showingBoth, showingOther, unavailable, resolving };
}

/** A visitor's sign-in, returning here; nothing while signed in or while the session is pending. */
function SignIn() {
  const gate = useSignInGate();
  if (gate.signedIn || gate.sessionPending) return null;
  return <ButtonLink href={gate.signInHref} onClick={gate.openSignIn} prefetch={false} variant="primary">Sign in</ButtonLink>;
}

type Read<Data> = Readonly<{ data: Data | undefined; isError: boolean; refetch: () => Promise<unknown> }>;

/** The account's creator commitment read as Rewards shows it (LP-17): pending, ready or failed with a retry. */
function commitmentRead(read: Read<string>): CreatorAccountRead {
  if (read.data !== undefined) return { status: "ready", commitment: read.data };
  return read.isError ? { status: "failed", retry: () => void read.refetch() } : { status: "loading" };
}

/** The Blast wallet read the same way: a pending or failed read is never "no creator rights". */
function walletRead(read: Read<Readonly<{ address: string | null }>>): CreatorWalletRead {
  if (read.data !== undefined) return { status: "ready", address: read.data.address };
  return read.isError ? { status: "failed", retry: () => void read.refetch() } : { status: "loading" };
}

function rewardSectionData(rewards: ReturnType<typeof useRewards>) {
  return { errorMessage: rewards.errorMessage, status: rewards.status, coins: rewards.view?.coins ?? [], latest: rewards.view?.latest ?? [], retry: rewards.retry };
}

function usePortfolioAccountReads(tab: PortfolioTab) {
  const viewer = useSocialViewer();
  const hydrated = useHydrated();
  const { status, account: liveAccount } = useSocialAccount();
  const account = viewer.signedIn ? liveAccount : null;
  const client = useAppQueryClient();
  const getAccessToken = viewer.getAccessToken ?? noToken;
  const active = hydrated && account !== null;
  const settingsRead = useQuery({ ...settingsQuery(getAccessToken, account?.account_id), enabled: active }, client);
  // The Blast wallet the claim path signs with: its launchpad creator fees are claimable in place.
  const blastWallet = useQuery({ ...walletQuery(getAccessToken), enabled: active && tab === "claims" }, client);
  // The account's creator commitment (LP-16): the launches naming it can be claimed in place (LP-17).
  const commitment = useQuery({ ...creatorCommitmentQuery(getAccessToken), enabled: active && tab === "claims" }, client);
  return { viewer, hydrated, status, account, getAccessToken, active, settingsRead, blastWallet, commitment };
}
