"use client";

import { pollInterval } from "#web/lib/query/polling.ts";
import { publicErrorMessage } from "#web/lib/errors.ts";
import { useNow } from "#web/components/presale-pages/presales-client.ts";

import { useQueries, useQuery } from "@tanstack/react-query";
import { useLayoutEffect } from "react";
import { ButtonLink } from "#web/components/blast-ui/Button.tsx";
import { useListRestoration } from "#web/components/blast-ui/list-restoration.ts";
import type { SocialPortfolio } from "@blast/core/web/contracts/portfolio.ts";

import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { SocialPriceHistory } from "@blast/core/web/contracts/prices.ts";

import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { priceQuery } from "../prices/price-client";
import type { HoldingCoin } from "../profile/profile-model";
import { useAmountsHidden, useHydrated, useMePresales } from "../profile/use-profile-data";
import { creatorCommitmentQuery, portfolioQuery, settingsQuery, walletQuery } from "../queries";
import { useSignInGate, useSocialViewer } from "../SignInGate";
import { useCreatorEarnings } from "../creator-earnings/use-creator-earnings";
import { usePayoutToasts, useRewards } from "../rewards/use-rewards";
import { useSocialAccount, type UseSocialAccount } from "../use-social-account";
import { portfolioCoverage, portfolioFigures, priceAskOf, pricedFigures } from "./portfolio-model";
import type { PortfolioTab } from "#web/components/blast-ui/portfolio-navigation.ts";
import { PortfolioView, type PortfolioMode, type PortfolioViewData } from "./PortfolioView";
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
  const { viewer, hydrated, status, account, getAccessToken, active, portfolioRead, settingsRead, blastWallet, commitment } = usePortfolioAccountReads(tab);
  useLayoutEffect(() => { canonicalizePortfolio(); }, [tab]);
  const restoration = useListRestoration(`portfolio:${viewer.callsign ?? "visitor"}:${tab}`, null, () => undefined);
  const me = useMePresales(active, true);
  const hidden = useAmountsHidden();
  // OA-45: the Rewards tab's read; a payout newer than this device last saw is announced.
  const rewards = useRewards();
  const creatorEarnings = useCreatorEarnings(active && tab === "claims");
  usePayoutToasts(rewards.view?.latest ?? null);

  const portfolio = portfolioRead.data ?? null;
  const holdings = me.status === "ready" ? me.value : null;
  const { coins, controls } = usePortfolioCoins(getAccessToken, active && tab === "coins");

  const { prices, salePrices } = usePortfolioPrices(coins, active && tab === "coins");
  const history = usePortfolioHistory(getAccessToken, active);
  const today = dockToday(portfolio, salePrices, prices.get("sui"));

  const state = portfolioState({ hydrated, signedIn: viewer.signedIn, status, account, portfolio, failed: portfolioRead.isError });

  return (
    <div ref={restoration}><RewardRoundsProvider meta={rewards.meta}><PortfolioView
      initialTab={initialTab}
      data={{
        ...state,
        refreshFailed: portfolio !== null && portfolioRead.isError,
        lastUpdatedMs: portfolioRead.dataUpdatedAt,
        errorMessage: publicErrorMessage(portfolioRead.error, "Your portfolio could not load. Try again."),
        holdingsErrorMessage: me.status === "error" ? me.message : undefined,
        retryPortfolio: () => { void portfolioRead.refetch(); },
        retryHoldings: me.retry,
        figures: portfolioFigures(portfolio),
        valuation: portfolioCoverage(portfolio),
        priced: pricedFigures(portfolio),
        vesting: portfolio?.vesting,
        walletSync: portfolio?.wallet_sync?.status,
        holdingsUnread: Boolean(portfolio?.unavailable.some((part) => part === "balances" || part === "coins" || part === "positions" || part === "totals")),
        today,
        history: active ? history : undefined,
        isPublic: settingsRead.data ? settingsRead.data.public_portfolio : null,
        coins,
        coinPage: controls,
        prices,
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
  const portfolioRead = useQuery({
    ...portfolioQuery(getAccessToken), enabled: active,
    refetchInterval: (query) => pollInterval(query.state.data?.wallet_sync?.status === "syncing" ? 5_000 : 60_000, query),
  }, client);
  const settingsRead = useQuery({ ...settingsQuery(getAccessToken, account?.account_id), enabled: active }, client);
  // The Blast wallet the claim path signs with: its launchpad creator fees are claimable in place.
  const blastWallet = useQuery({ ...walletQuery(getAccessToken), enabled: active && tab === "claims" }, client);
  // The account's creator commitment (LP-16): the launches naming it can be claimed in place (LP-17).
  const commitment = useQuery({ ...creatorCommitmentQuery(getAccessToken), enabled: active && tab === "claims" }, client);
  return { viewer, hydrated, status, account, getAccessToken, active, portfolioRead, settingsRead, blastWallet, commitment };
}
