"use client";

import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import { PARTIAL_BALANCE_NOTE } from "#web/components/blast-ui/account-balance-model.ts";
import { Button, ButtonLink, DisclosureSummary, IconButton } from "#web/components/blast-ui/Button.tsx";
import { Checkbox } from "#web/components/blast-ui/Checkbox.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { Pager } from "#web/components/blast-ui/Pager.tsx";
import { Segmented, SegmentedLinks } from "#web/components/blast-ui/Segmented.tsx";
import { FieldGroup, TextField } from "#web/components/blast-ui/TextField.tsx";
import { diagnosticMessage } from "#web/lib/errors.ts";

import { instantFeedback, useFeedbackReveal } from "#web/components/blast-ui/feedback-motion.ts";

import { useQuery } from "@tanstack/react-query";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import clsx from "clsx";
import Link from "next/link";
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { usePortfolioState } from "./use-portfolio-state";

import { Sparkline } from "#web/components/charts/Sparkline.tsx";
import { EyeIcon, EyeOffIcon, SearchIcon, ArrowDownIcon, ArrowUpIcon, BridgeIcon, COIN_VERIFIED_LABEL, CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { SETTINGS_PATH } from "#web/components/blast-ui/nav.ts";
import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { RowSkeletons } from "./HoldingsSkeleton";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { useBridge } from "../bridge/bridge-context.tsx";
import { setShellPref, usePhoneLayout } from "#web/components/blast-ui/use-shell-prefs.ts";
import type { PortfolioVesting } from "@blast/core/web/contracts/portfolio.ts";
import type { SocialPriceHistory } from "@blast/core/web/contracts/prices.ts";
import type { SocialMePresales } from "@blast/core/web/contracts/profile-page.ts";

import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { CreatorEarnings } from "../creator-earnings/CreatorEarnings";
import type { CreatorEarningsRead } from "../creator-earnings/use-creator-earnings";
import { RewardsSection } from "../rewards/RewardsPage";
import { VestingOverview } from "#web/components/vesting/VestingOverview.tsx";
import type { RewardCoinView, RewardPayoutView } from "../rewards/rewards-model";
import { sparkOf } from "../prices/price-client";
import { ChevIcon, GlobeIcon, LockIcon } from "../profile/icons";
import { positionView, vestingView, type HoldingCoin } from "../profile/profile-model";
import { IntentLink } from "#web/components/blast-ui/NavigationLink.tsx";
import { useToastedClaims } from "#web/components/social/claim/ClaimButton.tsx";
import { projectClaimPosition } from "../claim/claim-projection";
import { splitShades } from "../create/create-colors.ts";
import { useShellClaimPath } from "../feed-ui/shell-bridge";
import { WalletLaunches } from "../../launchpad/discovery/WalletLaunches";
import { LaunchRewards, type CreatorAccountRead, type CreatorWalletRead } from "../launch-rewards/LaunchRewards";
import { presaleListQuery } from "../queries";
import { PositionsList, VestingsList } from "./HoldingsLists";
import { ClientOnly } from "#web/components/ui-libraries/use-hydrated.tsx";
import PortfolioValuePlot from "./PortfolioValuePlot";
import { PERIOD_WORDS, PORTFOLIO_PERIODS, periodHasLine, rangeChange, type PortfolioHistoryReads, type PortfolioPeriod } from "./portfolio-history";
import styles from "./Portfolio.module.css";
import {
  allocationShares,
  coinRow,
  coinRowTarget,
  heroFigures,
  todayChange,
  totalParts,
  type PortfolioFigureKey,
  type PortfolioFigures,
} from "./portfolio-model";
import { portfolioPath, portfolioTabs, type PortfolioTab } from "#web/components/blast-ui/portfolio-navigation.ts";
import { setPortfolioTab, usePortfolioTab } from "./portfolio-tab";

/**
 * What the Portfolio page shows (R3-74): `visitor` is the gate's signed-out
 * card, `no-account` a session without a Blast Account yet, `loading` the
 * moment before the session is known, `ready` the page.
 */
export type PortfolioMode = "loading" | "visitor" | "no-account" | "ready";

export type PortfolioCoinControls = Readonly<{
  search: string;
  hideSmall?: boolean;
  walletHasCoins?: boolean;
  onHideSmall?: (value: boolean) => void;
  page: number;
  total: number;
  pageSize: number;
  loading: boolean;
  failed: boolean;
  onSearch: (search: string) => void;
  onPage: (page: number) => void;
  retry: () => void;
}>;

export type PortfolioViewData = Readonly<{
  mode: PortfolioMode;
  walletSync?: "ready" | "syncing" | "stale";
  /** The server could not read balances, coins or positions (`unavailable`): the total waits for them. */
  holdingsUnread?: boolean;
  /** The portfolio read (`/me/portfolio`). */
  portfolio: "loading" | "ready" | "error";
  refreshFailed?: boolean;
  lastUpdatedMs?: number;
  errorMessage?: string;
  holdingsErrorMessage?: string;
  retryPortfolio?: () => void;
  retryHoldings?: () => void;
  figures: PortfolioFigures;
  valuation?: Readonly<{ knownUsd: number }> | null;
  /** Each figure's priced part while the total is incomplete (`pricedFigures`): the tiles and the bar under "Priced subtotal". */
  priced?: PortfolioFigures | null;
  vesting?: PortfolioVesting | null;
  /** Today's move from the shared today model (`dockToday`); null when unknown (no line). */
  today: Readonly<{ usd: number; pct: number }> | null;
  /** The value chart's ranges (`/me/portfolio/history`); without it the hero draws no period switch and no line. */
  history?: PortfolioHistoryReads;
  /** The account's public-portfolio setting (OA-10); null until Settings' read answers (no chip yet). */
  isPublic: boolean | null;
  coinPage?: PortfolioCoinControls;
  /** The visible page in global USD order. */
  coins: readonly HoldingCoin[];
  /** R3-20's 24 h prices by coin key; a key with null has no history (an empty slot), undefined is still reading. */
  prices: ReadonlyMap<string, SocialPriceHistory | null>;
  /** `/me/presales`; null while it loads or when it failed (`holdingsFailed`). */
  holdings: SocialMePresales | null;
  holdingsFailed: boolean;
  hidden: boolean;
  /** OA-45: the rewards read (`/me/rewards`): the coins that paid, the latest payouts, and a retry for its failed state. */
  rewards: PortfolioRewards;
  creatorEarnings?: CreatorEarningsRead;
  /** The viewer's linked wallets, whose launches the Launches tab lists. */
  launchWallets?: readonly string[];
  /** The Blast wallet, which signs claims (`/me/wallet`): its launchpad creator fees can be claimed in place. */
  claimWallet?: string | null;
  /** The account's creator commitment (`/me/creator-commitment`): launches naming it, or the Blast wallet, offer their creator rights. */
  creatorAccount?: CreatorAccountRead;
  /** The Blast wallet's read state, so a pending or failed `/me/wallet` is not shown as no creator rights. */
  creatorWallet?: CreatorWalletRead;
}>;

export type PortfolioRewards = Readonly<{
  errorMessage?: string;
  status: "off" | "loading" | "ready" | "error";
  coins: readonly RewardCoinView[];
  latest: readonly RewardPayoutView[];
  retry: () => void;
}>;

const TITLE_ID = "portfolio-title";

/**
 * The Portfolio page (the gate's `viewPortfolio`): the header with Withdraw
 * and Deposit, the hero (Total value, the privacy chip linking to Settings,
 * the eye, the total, today's move and the three figures) and the holdings
 * card. Presentational; `PortfolioScreen` (or a fixture) gives it the reads.
 */
export function PortfolioView({
  data,
  nowMs,
  signIn,
  initialTab = "coins",
}: Readonly<{ data: PortfolioViewData; nowMs: number; signIn?: ReactNode; initialTab?: PortfolioTab }>) {
  if (data.mode === "visitor" || data.mode === "no-account") data = { ...data, figures: NO_FIGURES, today: null, isPublic: null, coins: [], holdings: null };
  const run = useShellActions();
  const bridge = useBridge() !== null;
  const claims = useToastedClaims(useShellClaimPath(), { toastRefusals: true });
  const { tab, select, card, body } = useHoldingsSwitch(initialTab);
  useFeedbackReveal(`${tab}:${data.mode}:${data.portfolio}`, body);

  return (
    <article aria-labelledby={TITLE_ID} className={styles.page}>
      <PageHeader
        actions={
          (
            // The primary sits at the trailing edge, so the row reads Deposit, Withdraw, Bridge from it.
            data.mode === "ready" || data.mode === "loading" ? <div className={styles.actsD}>
              {bridge ? <Button disabled={data.mode === "loading"} onClick={() => run("openBridge")}>
                <BridgeIcon />
                Bridge
              </Button> : null}
              <Button disabled={data.mode === "loading"} onClick={() => run("openWithdraw")}>
                <ArrowUpIcon />
                Withdraw
              </Button>
              <Button disabled={data.mode === "loading"} onClick={() => run("openDeposit")} variant="primary">
                <ArrowDownIcon />
                Deposit
              </Button>
            </div> : null
          )
        }
        title="Portfolio"
        titleId={TITLE_ID}
      />
      <Hero
        compact={tab !== "coins"}
        data={data}
        signIn={signIn}
      />
      <div className={styles.secs}>
        <Holdings bodyRef={body} cardRef={card} data={data} nowMs={nowMs} onSelect={select} tab={tab} claims={claims} />
      </div>
    </article>
  );
}

function PortfolioPrivacy({ isPublic }: Readonly<{ isPublic: PortfolioViewData["isPublic"] }>) {
  if (isPublic === null) return <span aria-hidden="true" className={styles.priv}><LockIcon /><SkeletonText>Only you</SkeletonText></span>;
  return (
    <Link className={styles.priv} href={SETTINGS_PATH}>
      {isPublic ? <GlobeIcon /> : <LockIcon />}
      {isPublic ? "Public" : "Only you"}
    </Link>
  );
}

function Welcome({ data, signIn }: Readonly<{ data: PortfolioViewData; signIn?: ReactNode }>) {
  const run = useShellActions();
  return (
    <section aria-label="Your portfolio" className={clsx("card", styles.welcome)} id="pfHero">
      <h2>{data.mode === "visitor" ? "Your coins, presales and unlocks" : "Set up your Blast account"}</h2>

      {data.mode === "visitor" ? signIn : null}
      {data.mode === "no-account" ? <ButtonLink href="/sign-in" onClick={event => { if (run("openSignIn")) event.preventDefault(); }} variant="primary">Continue setup</ButtonLink> : null}
      <Link className={styles.publicLink} href={portfolioPath("claims")}>Look up a public vesting schedule <span aria-hidden="true">↗</span></Link>
    </section>
  );
}

/** The values included in a partial total. */
function pricedParts(data: PortfolioViewData, subtotal: number | null): PortfolioFigures | null {
  return subtotal !== null && data.priced ? data.priced : null;
}

function portfolioValueLabel(busy: boolean, subtotal: number | null, hidden: boolean, total: number | null) {
  if (busy) return "Portfolio value";
  if (subtotal !== null) return "Portfolio value";
  return hidden || total !== null ? "Total value" : null;
}

function Hero({ compact, data, signIn }: Readonly<{ compact: boolean; data: PortfolioViewData; signIn?: ReactNode }>) {
  const run = useShellActions();
  const bridge = useBridge() !== null;
  // Opens on 1W (owner, 2026-10-27): 1D has no line yet (one snapshot a day), so it would open on an empty chart.
  const [period, setPeriod] = usePortfolioState<PortfolioPeriod>("history-period", "1w");
  const { hidden, busy, figures, subtotal, figureRows, shares } = portfolioHeroFigures(data);
  if (data.mode === "visitor" || data.mode === "no-account") return <Welcome data={data} signIn={signIn} />;
  const partial = !hidden && subtotal !== null;
  const history = data.history;
  // The range and the chart wait for history: a frame around "no history yet" would be the page's largest element.
  const showHistory = busy || hasHistory(history, period);
  return (
    <section aria-busy={busy || undefined} aria-label="Your portfolio" className={clsx("card", styles.hero)} data-compact={compact || undefined} id="pfHero">
      <div className={styles.head}>
        <div className={styles.sum}>
          <HeroLabel hidden={hidden} isPublic={data.isPublic} label={portfolioValueLabel(busy, subtotal, hidden, figures.total)} />
          <HeroTotal data={data} busy={busy} subtotal={subtotal} />
          {partial ? <p className={styles.note}>{PARTIAL_BALANCE_NOTE}</p> : null}
          <HeroChange data={data} partial={partial} period={showHistory ? period : "1d"} />
        </div>
        {showHistory ? (
          <Segmented
            className={styles.period}
            label="Range"
            onChange={setPeriod}
            options={PORTFOLIO_PERIODS}
            size="sm"
            value={period}
          />
        ) : null}
      </div>
      {showHistory && !hidden ? (
        period === "1d" ? <div className={clsx(styles.chart, styles.chartEmpty)}><EmptyState
          action={<Button onClick={() => setPeriod("1w")} size="sm" variant="ghost">View 1 week</Button>}
          compact
          title="Value history is recorded daily"
        /></div> : <HeroChart data={data} history={history} period={period} />
      ) : null}
      <HeroAllocation shares={shares} figureRows={figureRows} busy={busy} hidden={hidden} />
      <div aria-label="Funding" className={styles.actsM} data-three={bridge || undefined} role="group">
        <Button disabled={busy} onClick={() => run("openDeposit")} size="lg" variant="primary">
          <ArrowDownIcon />
          Deposit
        </Button>
        <Button disabled={busy} onClick={() => run("openWithdraw")} size="lg">
          <ArrowUpIcon />
          Withdraw
        </Button>
        {bridge ? <Button disabled={busy} onClick={() => run("openBridge")} size="lg">
          <BridgeIcon />
          Bridge
        </Button> : null}
      </div>
    </section>
  );
}

/** The range's line, coloured by its move; a failed read offers a retry in its place, a pending one keeps the height. */
function HeroChart({ data, history, period }: Readonly<{ data: PortfolioViewData; history: PortfolioHistoryReads | undefined; period: Exclude<PortfolioPeriod, "1d"> }>) {
  const read = history?.[period];
  if (!read || read.status === "loading") return <div aria-busy="true" aria-label="Loading the value history" className={styles.chart} role="status" />;
  if (read.status === "error") return <div className={clsx(styles.chart, styles.chartEmpty)}>
    <EmptyState action={<Button size="sm" variant="ghost" onClick={read.retry}>Try again</Button>} compact role="alert" title="Couldn’t load value history" />
  </div>;
  if (!read.trend) {
    const all = history?.all;
    const title = read.first !== null ? "Not enough observations yet" : all?.status === "ready" && all.first === null ? "No value history yet" : "No value history in this range";
    return <div className={clsx(styles.chart, styles.chartEmpty)}><EmptyState compact title={title} /></div>;
  }
  const change = rangeChange(read, data.hidden);
  return (
    <div aria-label={`Portfolio value, ${PERIOD_WORDS[period]}${change ? `, ${change.tone === "down" ? "down" : "up"} ${change.text}` : ""}`} className={clsx(styles.chart, change?.tone === "down" ? styles.down : styles.up)} role="img">
      <ClientOnly><PortfolioValuePlot trend={read.trend} /></ClientOnly>
    </div>
  );
}

/** A share's width goes through the DOM: the page's CSP allows no inline style attribute (as `UnlockBar`). */
function AllocationShare({ figure, share, shade }: Readonly<{ figure: PortfolioFigureKey; share: number; shade: string }>) {
  const segment = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (segment.current) segment.current.style.flexGrow = String(share);
  }, [share]);
  return <i className="cr-color" data-cr-color={shade} data-k={figure} ref={segment} />;
}

/** "Total value", the eye and the privacy chip on one line (the Portfolio board). */
function HeroLabel({ hidden, isPublic, label }: Readonly<{ hidden: boolean; isPublic: PortfolioViewData["isPublic"]; label: string | null }>) {
  return (
    <span className={styles.lbl}>
      {label}
      <IconButton
        aria-label={hidden ? "Show amounts" : "Hide amounts"}
        aria-pressed={hidden}
        className={styles.eye}
        onClick={() => setShellPref("amountsHidden", !hidden)}
        size="xs"
      >
        {hidden ? <EyeOffIcon /> : <EyeIcon />}
      </IconButton>
      <PortfolioPrivacy isPublic={isPublic} />
    </span>
  );
}

/** Why the value slot is empty, at body size: a wallet sync, holdings the server could not read (with a retry), or no prices. */
function HeroValueNote({ data }: Readonly<{ data: PortfolioViewData }>) {
  const unread = data.walletSync !== "syncing" && data.walletSync !== "stale" && data.holdingsUnread === true;
  const message = data.walletSync === "syncing" ? "Wallet balances are syncing. Amounts appear in a moment."
    : data.walletSync === "stale" ? "Wallet balances are late. Showing the last known amounts."
      : unread ? "Some balances couldn’t load."
        : "These coins have no USD price yet.";
  return <div className={styles.valueNote}>
    <p role="status">{message}</p>
    {unread && data.retryPortfolio ? <Button onClick={data.retryPortfolio} size="sm" variant="ghost">Try again</Button> : null}
  </div>;
}

function HeroTotal({
  data,
  busy,
  subtotal,
}: Readonly<{ data: PortfolioViewData; busy: boolean; subtotal: number | null }>) {
  const total = totalParts(
    data.portfolio === "ready" ? data.figures.total ?? subtotal : null,
    data.hidden,
  );
  // The 36 px slot holds the value or nothing: a missing value is said once, at body size, with what it means.
  // A failed portfolio read is said by the change line, with its retry.
  if (total === null && !busy) return data.portfolio === "error" ? null : <HeroValueNote data={data} />;
  return (
    <div className={clsx(styles.val, "num")} data-long={total !== null && total.whole.length > 11 || undefined}>
      {total === null ? <SkeletonText>Amount</SkeletonText> : (
        <>
          {total.whole}
          {total.cents ? <span className={styles.c}>{total.cents}</span> : null}
        </>
      )}
    </div>
  );
}

function HeroChange({ data, partial, period }: Readonly<{ data: PortfolioViewData; partial: boolean; period: PortfolioPeriod }>) {
  if (data.mode === "loading" || data.portfolio === "loading") return <div className={styles.chg}><SkeletonText>Valuation coverage</SkeletonText></div>;
  if (data.portfolio === "error") return <div className={clsx(styles.chg, "num")}>
    <span className={styles.note}>{data.errorMessage ?? diagnosticMessage("Your portfolio could not load. Try again later.")}</span>
    {data.retryPortfolio ? <Button size="sm" onClick={data.retryPortfolio}>Try again</Button> : null}
  </div>;
  if (data.refreshFailed) return <PortfolioRefreshFailure data={data} />;
  if (partial) return null;
  const change = period === "1d" ? todayChange(data.today, data.hidden, true) : rangeChange(data.history?.[period], data.hidden);
  if (!change) return <div className={styles.chg} />;
  return <div className={clsx(styles.chg, "num")}>
    <span className={change.tone ? styles[change.tone] : undefined}>{change.text}</span>{" "}<em>{PERIOD_WORDS[period]}</em>
  </div>;
}

function PortfolioRefreshFailure({ data }: Readonly<{ data: PortfolioViewData }>) {
  return <div className={styles.chg} role="alert">
    <span className={styles.note}>Refresh failed. Showing previous values{data.lastUpdatedMs ? <> from <DateStamp at={data.lastUpdatedMs} label="portfolio update time" /></> : null}.</span>
    {data.retryPortfolio ? <Button size="sm" onClick={data.retryPortfolio}>Try again</Button> : null}
  </div>;
}

type HoldingsSwitch = Readonly<{
  tab: PortfolioTab;
  /** `reveal`: then bring the card's top into view (a hero figure), once the new list is drawn. */
  select: (next: PortfolioTab, reveal?: boolean) => void;
  card: RefObject<HTMLElement | null>;
  body: RefObject<HTMLDivElement | null>;
}>;

/** Keep the selected peer section in the URL and reveal it beneath the shell header. */
function useHoldingsSwitch(initialTab: PortfolioTab): HoldingsSwitch {
  const tab = usePortfolioTab(initialTab);
  const card = useRef<HTMLElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const from = useRef<Readonly<{ reveal: boolean }> | null>(null);

  const select = (next: PortfolioTab, reveal = false) => {
    if (next === tab) {
      if (reveal) revealCard(card.current);
      return;
    }
    from.current = { reveal };
    setPortfolioTab(next);
  };

  useLayoutEffect(() => {
    const start = from.current;
    from.current = null;
    const el = body.current;
    if (start === null || !el) return;
    // Scrolled once the new list is in, so a longer list is already there to scroll to (the gate redraws first, then scrolls).
    if (start.reveal || (card.current && card.current.getBoundingClientRect().top < 0)) revealCard(card.current);
  }, [tab]);

  return { tab, select, card, body };
}

/** The holdings card's top into view (`scroll-margin-top` keeps it off the edge); instant under reduced motion. */
function revealCard(card: HTMLElement | null): void {
  card?.scrollIntoView({ behavior: instantFeedback() ? "auto" : "smooth", block: "start" });
}

const NO_FIGURES: PortfolioFigures = { total: null, coins: null, committed: null, claimable: null };

/**
 * The holdings card (the gate's `pfSecsHTML`): the shared tablist of Coins,
 * Presales, Launches, Vestings and Rewards (OA-45; roving focus with ←/→/Home/End),
 * pinned under the top edge while a long list scrolls. The URL keeps the
 * selection. The hero's tiles already carry each tab's sum, so it is not
 * repeated here.
 */
function Holdings({
  data,
  nowMs,
  tab,
  onSelect: select,
  cardRef,
  bodyRef,
  claims,
}: Readonly<{
  data: PortfolioViewData;
  nowMs: number;
  tab: PortfolioTab;
  onSelect: HoldingsSwitch["select"];
  cardRef: HoldingsSwitch["card"];
  bodyRef: HoldingsSwitch["body"];
  claims: ReturnType<typeof useToastedClaims>;
}>) {
  const tabs = portfolioTabs();
  return (
    <section aria-label="Your holdings" className={clsx("card", styles.hold)} id="pfHold" ref={cardRef}>
      <div className={styles.tabs}>
        <SegmentedLinks id="pfTabs" items={tabs.map(([key, text]) => ({ href: portfolioPath(key), label: text, current: key === tab, id: `pft-${key}`, controls: "pfBody2" }))} label="Holdings" onNavigate={(index) => select(tabs[index]![0])} tabs />
        {tab === "coins" && data.coinPage && data.mode !== "visitor" && data.mode !== "no-account" ? <CoinSearch page={data.coinPage} /> : null}
      </div>
      <div aria-labelledby={`pft-${tab}`} className={styles.body} id="pfBody2" ref={bodyRef} role="tabpanel">
        <HoldingsBody data={data} nowMs={nowMs} tab={tab} claims={claims} />
      </div>
    </section>
  );
}

function HoldingsBody({ data, nowMs, tab, claims }: Readonly<{
  data: PortfolioViewData;
  nowMs: number;
  tab: PortfolioTab;
  claims: ReturnType<typeof useToastedClaims>;
}>) {
  if (tab === "claims") return <ClaimsBody data={data} nowMs={nowMs} claims={claims} />;
  if (data.mode === "visitor" || data.mode === "no-account") {
    return <EmptyState title={data.mode === "visitor" ? "Sign in to see your holdings" : "Finish setting up your account"} />;
  }
  if (tab === "coins") return <Coins data={data} />;
  if (!data.holdings) return <PendingHoldings failed={data.holdingsFailed} message={data.holdingsErrorMessage} tab={tab} retry={data.retryHoldings} />;
  if (data.holdings.positions.length === 0) return <NoBackedPresales />;
  return <div><PositionsList claims={claims} classes={{ list: styles.pfList, row: `${styles.posRow} ${styles.presRow}` }} hidden={data.hidden} nowMs={nowMs} positions={data.holdings.positions} /></div>;
}

function NoBackedPresales() {
  const { data, isError } = useQuery(presaleListQuery({ status: "live", limit: 1 }), useAppQueryClient());
  const browse = !isError && data
    ? data.presales.length > 0 ? "/presale" : data.status_counts?.upcoming ? "/presale?status=upcoming" : undefined
    : undefined;
  return <EmptyState
    action={browse ? <ButtonLink href={browse} size="sm" variant="ghost">Browse presales</ButtonLink> : null}
    title="Presales you back appear here"
  />;
}

/** The reader's linked wallets, null until the portfolio has loaded them: their lists are pending until then. */
function launchWalletsOf(data: PortfolioViewData): readonly string[] | null {
  return data.launchWallets ?? (data.mode === "loading" ? null : []);
}

function LaunchesBody({ data }: Readonly<{ data: PortfolioViewData }>) {
  const wallets = launchWalletsOf(data);
  if (data.portfolio === "error" && data.launchWallets === undefined) {
    return <EmptyState action={data.retryHoldings ? <Button onClick={data.retryHoldings} size="sm">Try again</Button> : null} role="alert" title="Couldn’t load your launches" />;
  }
  return wallets === null ? <RowSkeletons kind="presales" label="Loading your launches" /> : <WalletLaunches addresses={wallets} />;
}

/**
 * Claims (the hero's "To claim"): vesting unlocks first, then holder rewards,
 * creator earnings and launch rewards, then the launches you created. One tab
 * instead of Vestings, Rewards and Launches (TS-5, 2026-11-14). A visitor sees
 * the vesting part alone, which keeps the public schedule lookup.
 */
function ClaimsBody({ data, nowMs, claims }: Readonly<{ data: PortfolioViewData; nowMs: number; claims: ReturnType<typeof useToastedClaims> }>) {
  const wallets = launchWalletsOf(data);
  const organize = data.mode === "ready";
  const vestings = <PortfolioVestingOverview claims={claims} data={data} nowMs={nowMs} organize={organize} />;
  if (data.mode === "visitor" || data.mode === "no-account") return vestings;
  const launches = wallets === null || wallets.length > 0;
  const earnings = data.creatorEarnings;
  return <div className={styles.claims}>
    <section aria-labelledby={organize ? undefined : "pf-vesting"} className={styles.claimsPart}>
      {organize ? null : <h3 className={styles.claimsH} id="pf-vesting">Vesting</h3>}
      {vestings}
    </section>
    <ClaimsSection fold={organize} title="Holder rewards" count={data.rewards.status === "ready" ? data.rewards.coins.length : undefined} heading="pf-rewards">
      <RewardsSection data={{ ...data.rewards, mode: data.mode }} nowMs={nowMs} hidden={data.hidden} />
    </ClaimsSection>
    {earnings ? <ClaimsSection fold={organize} title="Creator earnings" count={earnings.status === "ready" && !earnings.more ? earnings.earnings.length + earnings.vestings.length : undefined}>
      <CreatorEarnings read={earnings} claims={claims} hidden={data.hidden} />
    </ClaimsSection> : null}
    {launches ? (
      <ClaimsSection fold={organize} title="Launch fees and rights">
        <LaunchRewards addresses={wallets} active={data.mode === "ready"} hidden={data.hidden} claims={claims} claimWallet={data.claimWallet ?? null} creatorAccount={data.creatorAccount} creatorWallet={data.creatorWallet} />
      </ClaimsSection>
    ) : null}
    {launches ? (
      <ClaimsSection fold={organize} title="Your launches" heading="pf-launches">
        <LaunchesBody data={data} />
      </ClaimsSection>
    ) : null}
  </div>;
}

function PortfolioVestingOverview({ data, nowMs, claims, organize }: Readonly<{ data: PortfolioViewData; nowMs: number; claims: ReturnType<typeof useToastedClaims>; organize: boolean }>) {
  const phone = usePhoneLayout();
  const holdings = organize ? data.holdings : null;
  const positions = holdings?.positions.filter(position =>
    positionView(projectClaimPosition(position, claims), data.hidden, nowMs).right.kind === "claim",
  ) ?? [];
  const ready = holdings?.vestings.filter(row => vestingView(row, data.hidden, nowMs, claims).right.kind === "claim") ?? [];
  const readyIds = new Set(ready.map(row => row.schedule_id));
  const allocations = data.holdings?.vestings ?? [];
  return <VestingOverview embedded
    nowMs={nowMs}
    hidden={data.hidden}
    allocationIds={allocations.map(row => row.schedule_id)}
    allocations={presaleAllocations(data, nowMs, claims, allocations.filter(row => !readyIds.has(row.schedule_id)))}
    claimableHoldings={organize ? {
      known: holdings !== null && !data.holdingsFailed,
      content: <>
        {positions.length ? <PositionsList claims={claims} classes={{ list: styles.pfList, row: styles.posRow }} compact={phone} hidden={data.hidden} nowMs={nowMs} positions={positions} /> : null}
        {ready.length ? <VestingsList claims={claims} classes={{ list: styles.pfList, row: styles.posRow }} compact={phone} hidden={data.hidden} nowMs={nowMs} vestings={ready} /> : null}
      </>,
      hasRows: positions.length > 0 || ready.length > 0,
    } : undefined}
  />;
}

function ClaimsSection({ fold, title, count, heading, children }: Readonly<{ fold: boolean; title: string; count?: number; heading?: string; children: ReactNode }>) {
  if (fold) {
    return <details className={styles.claimsGroup}>
      <DisclosureSummary>{title}{count == null ? null : <span className={styles.claimsCount}> · {count}</span>}</DisclosureSummary>
      {children}
    </details>;
  }
  if (!heading) return children;
  return <section aria-labelledby={heading} className={styles.claimsPart}>
    <h3 className={styles.claimsH} id={heading}>{title}</h3>
    {children}
  </section>;
}

function presaleAllocations(data: PortfolioViewData, nowMs: number, claims: ReturnType<typeof useToastedClaims>, allocations: NonNullable<PortfolioViewData["holdings"]>["vestings"]) {
  if (data.mode === "visitor" || data.mode === "no-account") return null;
  if (!data.holdings) return data.holdingsFailed ? <PendingHoldings failed message={data.holdingsErrorMessage} tab="claims" retry={data.retryHoldings} /> : null;
  if (!allocations.length) return null;
  return <VestingsList claims={claims} classes={{ list: styles.pfList, row: styles.posRow }} hidden={data.hidden} nowMs={nowMs} vestings={allocations} />;
}

function PendingHoldings({ failed, tab, message, retry }: Readonly<{ failed: boolean; tab: PortfolioTab; message?: string; retry?: () => void }>) {
  return failed ? (
    <EmptyState action={retry ? <Button onClick={retry}>Try again</Button> : null} role="alert" title="Your holdings could not load">
      {message ?? diagnosticMessage("Nothing changed. Try again in a moment.")}
    </EmptyState>
  ) : <RowSkeletons kind={tab === "claims" ? "vestings" : "presales"} />;
}

function coinRange(page: PortfolioCoinControls): string {
  if (page.failed) return "Coins unavailable";
  if (page.total === 0) return "0 coins";
  const start = (page.page - 1) * page.pageSize + 1;
  const end = Math.min(page.page * page.pageSize, page.total);
  return `${start}–${end} of ${page.total} ${page.search.trim() ? "matches" : "coins"}`;
}

/** The search beside the switch (Coins only): it filters every holding before paging. */
function CoinSearch({ page }: Readonly<{ page: PortfolioCoinControls }>) {
  return (
    <FieldGroup className={styles.coinSearch}>
      <SearchIcon />
      <TextField aria-label="Search your coins" autoComplete="off" maxLength={200} onChange={(event) => page.onSearch(event.target.value)} placeholder="Search coins" type="search" value={page.search} />
    </FieldGroup>
  );
}

/** "1–20 of 23 coins" and the small-balance switch, above the rows. */
function CoinMeta({ page, range, meta }: Readonly<{ page: PortfolioCoinControls; range: RefObject<HTMLSpanElement | null>; meta: RefObject<HTMLDivElement | null> }>) {
  return (
    <div className={styles.coinMeta} ref={meta}>
      <span className={!page.loading && page.total === 0 ? "sr" : undefined} aria-label={page.loading ? "Finding your coins" : undefined} aria-busy={page.loading || undefined} aria-live="polite" ref={range} role="status" tabIndex={-1}>
        {page.loading ? <SkeletonText>1–20 of 100 coins</SkeletonText> : coinRange(page)}
      </span>
      {page.onHideSmall ? <label className={styles.smallBalances} title="Under 1 token, except core coins and balances without units."><Checkbox checked={page.hideSmall ?? true} onChange={event => page.onHideSmall?.(event.target.checked)} />{HIDE_SMALL}</label> : null}
    </div>
  );
}

const HIDE_SMALL = "Hide small balances";

function coinEmptyTitle(page: PortfolioCoinControls | undefined) {
  if (page?.search.trim()) return "No matching coins";
  if (page?.hideSmall && page.walletHasCoins) return "Small balances are hidden";
  return "No coins in your linked wallets";
}

function CoinRows({ data, busy }: Readonly<{ data: PortfolioViewData; busy: boolean }>) {
  const run = useShellActions();
  const page = data.coinPage;
  if (page?.failed) return <EmptyState action={<Button onClick={page.retry}>Try again</Button>} role="alert" title="Your coins could not load" />;
  if (busy) return <RowSkeletons />;
  const clear = page?.search.trim() ? <Button onClick={() => page.onSearch("")} size="sm">Clear search</Button> : null;
  const showBalances = page?.hideSmall && page.walletHasCoins && page.onHideSmall
    ? <Button onClick={() => page.onHideSmall?.(false)} size="sm">Show small balances</Button>
    : null;
  if (data.coins.length === 0) return <EmptyState action={clear ?? showBalances} title={coinEmptyTitle(page)} />;
  return data.coins.map((coin) => <CoinRow coin={coin} hidden={data.hidden} key={coin.key} onOpen={() => run("openCoin", coin.key)} price={data.prices.get(coin.key)} />);
}

function Coins({ data }: Readonly<{ data: PortfolioViewData }>) {
  const meta = useRef<HTMLDivElement>(null);
  const range = useRef<HTMLSpanElement>(null);
  const page = data.coinPage;
  const busy = data.mode === "loading" || (data.mode === "ready" && data.portfolio === "loading") || page?.loading === true;
  const changePage = (next: number) => {
    page?.onPage(next);
    meta.current?.scrollIntoView({ block: "start", behavior: "auto" });
    range.current?.focus({ preventScroll: true });
  };
  return <>
    {page ? <CoinMeta meta={meta} page={page} range={range} /> : null}
    <div aria-busy={busy || undefined} className={styles.list}>
      <CoinWalletSync status={data.walletSync} />
      <CoinRows busy={busy} data={data} />
    </div>
    {page && page.total > page.pageSize ? <Pager className={styles.coinPager} onPage={changePage} page={page.page} pages={Math.max(1, Math.ceil(page.total / page.pageSize))} pending={page.loading} what="coins" /> : null}
  </>;
}

// A stale wallet is said once, in the hero's value slot; the list marks only a sync in progress.
function CoinWalletSync({ status }: Readonly<{ status: PortfolioViewData["walletSync"] }>) {
  if (status !== "syncing") return null;
  return <p aria-label="Syncing your wallet coins" aria-busy role="status"><SkeletonText>Wallet balances</SkeletonText></p>;
}

function CoinRow({ coin, price, hidden, onOpen }: Readonly<{ coin: HoldingCoin; price: SocialPriceHistory | null | undefined; hidden: boolean; onOpen: () => void }>) {
  const row = coinRow(coin, price, hidden);
  const change = row.change;
  const target = coinRowTarget(coin);
  const amount = !hidden && coin.compactQuantityText ? `${coin.compactQuantityText} ${coin.symbol}` : row.amount;
  const content = (
    <>
      <CoinMark coin={{ key: coin.key, coinType: coin.coinType, symbol: coin.symbol, iconUrl: coin.icon, round: coin.round }} size={40} />
      <span className={styles.t}>
        {coin.verifiedTeam ? <span className={styles.named}><b>{row.name}</b><CoinVerifiedMark /></span> : <b>{row.name}</b>}
        <span className="num">{!target && amount !== row.amount
          ? <InspectValue label="balance" value={row.amount}>{amount}</InspectValue>
          : amount}</span>
      </span>
      <CoinTrend coin={coin} price={price} change={change} />
      <span className={styles.v}>
        {row.value ? <b className="num">{row.value}</b> : null}
        <CoinChange change={change} />
      </span>
      {target ? <ChevIcon className={styles.chev} /> : null}
    </>
  );
  const label = coin.verifiedTeam ? `${row.label}, ${COIN_VERIFIED_LABEL}` : row.label;
  // A page is a real link (new tab, long-press); the sheet is a dialog button; an unpriced, uncurated coin opens nothing.
  if (target?.kind === "page") return <IntentLink aria-label={label} className={styles.row} data-list-row={coin.key} data-k={coin.key} href={target.href}>{content}</IntentLink>;
  if (target) return <button aria-haspopup="dialog" aria-label={label} className={styles.row} data-list-row={coin.key} data-k={coin.key} onClick={onOpen} type="button">{content}</button>;
  return <div className={styles.row} data-list-row={coin.key} data-k={coin.key}>{content}</div>;
}

function CoinTrend({ coin, price, change }: Readonly<{ coin: HoldingCoin; price: SocialPriceHistory | null | undefined; change: ReturnType<typeof coinRow>["change"] }>) {
  return <span className={styles.sp}><Sparkline className={styles.spark} height={28} points={coin.key === "usdc" ? null : sparkOf(price)} slot="portfolio-coin-sparkline" up={change !== null && change !== "cash" ? change.tone === "up" : undefined} width={96} /></span>;
}

function CoinChange({ change }: Readonly<{ change: ReturnType<typeof coinRow>["change"] }>) {
  if (change === "cash") return null;
  if (change) return <span className={clsx("num", styles[change.tone])}>{change.text}</span>;
  return null;
}

function HeroAllocation({ shares, figureRows, busy, hidden }: Readonly<{ shares: ReturnType<typeof allocationShares>; figureRows: ReturnType<typeof heroFigures>; busy: boolean; hidden: boolean }>) {
  const shades = splitShades(shares.map(({ share }) => share));
  const segments = shares.map(({ key, share }, index) => ({ key, share, shade: shades[index]! }));
  return (
    <details className={styles.mix}>
      <DisclosureSummary>Value breakdown</DisclosureSummary>
      {/* The tiles carry the amounts. While loading or masked, draw only the track. */}
      {busy || hidden || segments.length > 0 ? (
        <div aria-hidden="true" className={styles.alloc}>
          {segments.map(({ key, share, shade }) => <AllocationShare key={key} figure={key} share={share} shade={shade} />)}
        </div>
      ) : null}
      <div className={styles.split} data-wide={figureRows.some(figure => figure.value.length > 10) || undefined}>
        {figureRows.map((figure) => {
          const segment = segments.find(({ key }) => key === figure.key);
          return (
            <div className={styles.st} data-figure={figure.key} key={figure.key}>
              <span>{segment ? <i aria-hidden="true" className={clsx(styles.key, "cr-color")} data-cr-color={segment.shade} data-k={figure.key} /> : null}{figure.label}</span>
              <b className="num">{busy ? <SkeletonText>Amount</SkeletonText> : figure.value}</b>
            </div>
          );
        })}
      </div>
    </details>
);
}

/** Whether the chart slot has a job: the chosen range still loading or failed (its retry), or a line in some range. */
function hasHistory(history: PortfolioHistoryReads | undefined, period: PortfolioPeriod): boolean {
  if (!history) return false;
  if (period !== "1d" && history[period].status !== "ready") return true;
  return HISTORY_PERIODS.some((range) => periodHasLine(range, history));
}

const HISTORY_PERIODS = ["1w", "1m", "all"] as const;

function portfolioHeroFigures(data: PortfolioViewData) {
  const { hidden } = data;
  const busy = data.mode === "loading" || (data.mode === "ready" && data.portfolio === "loading");
  const figures = data.portfolio === "ready" ? data.figures : NO_FIGURES;
  // An incomplete valuation is still the page's main figure, named for what it is.
  const subtotal = !busy && data.portfolio === "ready" && figures.total === null && data.valuation ? data.valuation.knownUsd : null;
  const priced = pricedParts(data, subtotal);
  const figureRows = heroFigures(figures, busy || hidden, true, priced);
  // The bar is the tiles' picture: shares only, never amounts, and nothing while the amounts are masked.
  const shares = busy || hidden ? [] : allocationShares(priced ?? figures);
  return { hidden, busy, figures, subtotal, figureRows, shares };
}
