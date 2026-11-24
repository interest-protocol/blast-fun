"use client";
import { invalidateAfter } from "#web/lib/query/invalidate.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { TextField } from "#web/components/blast-ui/TextField.tsx";
import { Checkbox } from "#web/components/blast-ui/Checkbox.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";

import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { useEffect, useId } from "react";
import { useQueries, useQuery, type UseQueryResult } from "@tanstack/react-query";
import { isValidStructTag, normalizeStructTag } from "@mysten/sui/utils";
import type { CostBasisFigures, PortfolioCoinPage, SocialPortfolio } from "@blast/core/web/contracts/portfolio.ts";
import { exactDecimal, atLeastPow10 } from "@blast/core/web/exact-amount.ts";
import { HIDDEN_AMOUNT } from "@blast/core/web/format.ts";
import { SkeletonBox, SkeletonRegion, SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { HoldingRowsSkeleton } from "./HoldingRowsSkeleton";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { AccessTokenSource } from "../../social-fetch";
import { portfolioCoinsQuery, portfolioQuery } from "../../queries";
import { fetchTradeCoins } from "../../coins/swap-client";
import { useAmountsHidden } from "../../profile/use-profile-data";
import { compactFigure } from "#web/lib/market-format.ts";
import { terminalUsd } from "./panels/coin-facts";
import { walletAmount } from "../../portfolio/portfolio-model";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { useWorkspace } from "./workspace-context";
import { PanelAddButton, RefreshButton } from "./CoinsRows";
import { LoadFailed, RefreshFailed } from "./DataStates";
import { assetOnScreen } from "./coin-row-model";
import styles from "./CoinsData.module.css";
import portfolioStyles from "./PortfolioData.module.css";
import { PortfolioRows } from "./PortfolioRows";
import type { PanelInput } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { compactPnl, currentPnl } from "./panels/coin-pnl";

export type PortfolioTradeAction = (input: PanelInput, side: "buy" | "sell") => void;

type Holding = PortfolioCoinPage["coins"][number];

export function PortfolioCoins({ scope, getAccessToken, onTrade }: Readonly<{ scope: string; getAccessToken: AccessTokenSource; onTrade?: PortfolioTradeAction }>) {
  const searchId = useId();
  const client = useAppQueryClient();
  const { snapshot, dispatch } = useWorkspace();
  const controls = snapshot.data.controls.Portfolio;
  const coins = controls.coins;
  const options = portfolioCoinsQuery(getAccessToken, coins.page, coins.search.trim(), coins.hide_small, scope);
  const read = useQuery({ ...options,  retry: false, gcTime: 0, staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: false }, client);
  useEffect(() => {
    if (read.data && coins.page !== read.data.page)
      dispatch.patchDataControls("Portfolio", { ...controls, coins: { ...coins, page: read.data.page } });
  }, [coins, controls, dispatch, read.data]);
  const pnl = useQuery({ ...portfolioQuery(getAccessToken, scope, false), enabled: !!onTrade, retry: false, gcTime: 0, staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: false }, client);
  const refresh = () => {
    void read.refetch();
    if (onTrade) void pnl.refetch();
    void invalidateAfter(client, { kind: "portfolio-capability" });
  };
  const change = (patch: Partial<typeof coins>) => dispatch.patchDataControls("Portfolio", { ...controls, coins: { ...coins, ...patch }, navigation: { ...controls.navigation, scroll_top: 0, anchor: null } });
  return <>
    <div className={portfolioStyles.tools}>
      <label className={portfolioStyles.searchField} htmlFor={searchId}><span className={styles.visuallyHidden}>Search coins</span><TextField id={searchId} size="sm" aria-label="Search portfolio coins" placeholder="Search coins" type="search" maxLength={200} value={coins.search} onChange={event => change({ search: event.currentTarget.value, page: 1 })} /></label>
      <label className={portfolioStyles.check}><Checkbox  checked={coins.hide_small} onChange={event => change({ hide_small: event.currentTarget.checked, page: 1 })} /> Hide small</label>
      <RefreshButton busy={read.isFetching || (!!onTrade && pnl.isFetching)} label="Refresh coins" onRefresh={refresh} title="Refresh coins" />
    </div>
    {onTrade && <PortfolioPnlStatus read={pnl} />}
    <PortfolioCoinResults read={read} pnl={pnl} onTrade={onTrade} search={coins.search} hiddenSmall={coins.hide_small} clearSearch={() => change({ search: "", page: 1 })} showSmall={() => change({ hide_small: false, page: 1 })} refresh={refresh} changePage={page => change({ page })} />
  </>;
}

function PortfolioPnlStatus({ read }: Readonly<{ read: UseQueryResult<SocialPortfolio, Error> }>) {
  if (read.isError) return <LoadFailed onRetry={() => void read.refetch()} retryLabel="Retry PnL" title="PnL could not load" />;
  if (read.data?.wallet_sync?.status === "syncing") return <p role="status">Wallet balances are syncing.</p>;
  if (read.data?.wallet_sync?.status === "stale") return <p role="status">Wallet balances are delayed.</p>;
  return null;
}

function PortfolioCoinResults({ read, pnl, onTrade, search, hiddenSmall, clearSearch, showSmall, refresh, changePage }: Readonly<{
  read: UseQueryResult<PortfolioCoinPage, Error>;
  pnl: UseQueryResult<SocialPortfolio, Error>;
  onTrade?: PortfolioTradeAction;
  search: string;
  hiddenSmall: boolean;
  clearSearch: () => void;
  showSmall: () => void;
  refresh: () => void;
  changePage: (page: number) => void;
}>) {
  if (!read.data) {
    if (read.isError) return <LoadFailed onRetry={refresh} retryLabel="Retry coins" title="Your coins could not load" />;
    return <HoldingRowsSkeleton quickTrade={!!onTrade} />;
  }
  const data = read.data;
  if (data.coins.length === 0 && !read.isError) {
    return <EmptyPortfolioCoins search={search} balancesHidden={hiddenSmall && data.wallet_has_coins === true} clearSearch={clearSearch} showSmall={showSmall} />;
  }
  const pnlRows = !pnl.isError && !pnl.isFetching && pnl.data?.wallet_sync?.status === "ready" ? pnl.data.coins : [];
  return <>
    {read.isError && <RefreshFailed onRetry={refresh} retryLabel="Retry coins" title="Your coins could not refresh" />}
    <PortfolioCoinList coins={data.coins} onTrade={onTrade} pnlRows={pnlRows} pnlLoading={pnl.isFetching} />
    <PortfolioCoinPagination data={data} pending={read.isFetching} changePage={changePage} />
  </>;
}

function PortfolioCoinPagination({ data, pending, changePage }: Readonly<{ data: PortfolioCoinPage; pending: boolean; changePage: (page: number) => void }>) {
  if (data.total === 0) return null;
  if (data.total <= data.page_size) return <p className={portfolioStyles.holdingCount}>{data.total} {data.total === 1 ? "holding" : "holdings"}</p>;
  return <div className={portfolioStyles.pager}>
    <Button variant="secondary" size="sm" type="button" disabled={data.page <= 1 || pending} onClick={() => changePage(data.page - 1)} aria-label="Previous coin page">Previous</Button>
    <span>Page {data.page} of {Math.max(1, Math.ceil(data.total / data.page_size))} · {data.total} coins</span>
    <Button variant="secondary" size="sm" type="button" disabled={data.page * data.page_size >= data.total || pending} onClick={() => changePage(data.page + 1)} aria-label="Next coin page">Next</Button>
  </div>;
}

function EmptyPortfolioCoins({ search, balancesHidden, clearSearch, showSmall }: Readonly<{ search: string; balancesHidden: boolean; clearSearch: () => void; showSmall: () => void }>) {
  if (search.trim()) return <EmptyState action={<Button onClick={clearSearch} size="sm">Clear search</Button>} compact role="status" title="No matching coins" />;
  if (balancesHidden) return <EmptyState action={<Button onClick={showSmall} size="sm">Show small balances</Button>} compact title="Small balances are hidden" />;
  return <EmptyState compact title="No coins in your linked wallets" />;
}

function PortfolioCoinList({ coins, onTrade, pnlRows, pnlLoading }: Readonly<{
  coins: PortfolioCoinPage["coins"];
  onTrade?: PortfolioTradeAction;
  pnlRows: SocialPortfolio["coins"];
  pnlLoading: boolean;
}>) {
  const reads = useQueries({ queries: coins.map(coin => capabilityQuery(canonicalType(coin.coin_type))) }, useAppQueryClient());
  if (coins.length === 0) return null;
  const failed = reads.filter(read => read.isError && !read.isFetching);
  // Audit, Portfolio overlay: several checks failing together share a cause, so they get one line and one Retry, not one per row.
  const grouped = failed.length > 1;
  return <>
    {grouped && <RefreshFailed onRetry={() => { for (const read of failed) void read.refetch(); }} retryLabel="Retry checks" title={`Couldn't check trading for ${failed.length} coins`}>Buy and Sell show once a check succeeds.</RefreshFailed>}
    <PortfolioRows label="Portfolio coins">{coins.map((coin, index) => <PortfolioCoin key={coin.coin_type} coin={coin} read={reads[index]!} grouped={grouped} onTrade={onTrade} pnlLoading={pnlLoading} pnl={pnlRows?.find(row => row.coin_type === coin.coin_type)} />)}</PortfolioRows>
  </>;
}

function canonicalType(coinType: string): string | null {
  return isValidStructTag(coinType) ? normalizeStructTag(coinType) : null;
}

function capabilityQuery(canonical: string | null) {
  return {
    queryKey: queryKeys.workspace.portfolioCapability(canonical),
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchTradeCoins({ q: canonical }, signal),
    enabled: !!canonical,
    retry: false, staleTime: 0, refetchOnMount: "always" as const, refetchOnWindowFocus: false,
  };
}

function PortfolioCoin({ coin, read, grouped, onTrade, pnl, pnlLoading }: Readonly<{ coin: Holding; read: UseQueryResult<Awaited<ReturnType<typeof fetchTradeCoins>>, Error>; grouped: boolean; onTrade?: PortfolioTradeAction; pnl?: CostBasisFigures | null; pnlLoading: boolean }>) {
  const { snapshot } = useWorkspace();
  const canonical = canonicalType(coin.coin_type);
  const supported = read.isError ? undefined : read.data?.coins.find(row => row.coin_type === canonical && !row.in_presale);
  const pending = !!canonical && (read.isPending || (read.isFetching && !supported));
  const failed = read.isError && !pending;
  const input = canonical ? { chain: "sui" as const, network: "mainnet" as const, coin_type: canonical, presale_id: coin.presale_id ?? supported?.presale_id ?? null } : null;
  const open = assetOnScreen(snapshot, canonical);
  const reason = failed && grouped ? null : tradeReason(!!onTrade, coin.balance, !!supported, pending, failed);
  return <li className={`${styles.row} ${portfolioStyles.holding} ${onTrade ? portfolioStyles.quickHolding : ""}`} data-on-screen={open} data-quick-trade={!!onTrade} data-workspace-portfolio={coin.coin_type}>
    <div className={styles.head} data-cols="holding">
      <PortfolioCoinFigures coin={coin} canonical={canonical} quickTrade={!!onTrade} pnl={pnl} pnlLoading={pnlLoading} />
      <PortfolioCoinActions coin={coin} input={input} supported={!!supported} pending={pending} open={open} onTrade={onTrade} reason={reason} retry={failed && !!reason ? () => void read.refetch() : undefined} />
    </div>
  </li>;
}

function PortfolioCoinFigures({ coin, canonical, quickTrade, pnl, pnlLoading }: Readonly<{
  coin: Holding;
  canonical: string | null;
  quickTrade: boolean;
  pnl?: CostBasisFigures | null;
  pnlLoading: boolean;
}>) {
  const hidden = useAmountsHidden();
  const amount = `${walletAmount(coin.balance, coin.decimals)} ${coin.decimals == null ? "" : coin.symbol}`.trim();
  const coinType = canonical ?? coin.coin_type;
  return <>
    <span className={styles.tile}><CoinMark coin={{ key: coinType, coinType, symbol: coin.symbol, iconUrl: coin.icon_url ?? null, round: true }} size={28} /></span>
    <span className={`${styles.text} ${portfolioStyles.holdingText}`}>
      <span className={styles.t1}><InspectValue label={`${coin.symbol} coin type`} value={coin.coin_type}><strong className={`ticker ${portfolioStyles.holdingTicker}`}>{coin.symbol}</strong></InspectValue>{coin.verified_team ? <CoinVerifiedMark size="sm" /> : null}</span>
      <span className={`${styles.t2} ${portfolioStyles.balance}`}>{hidden ? HIDDEN_AMOUNT : <InspectValue label={`${coin.symbol} balance`} value={amount}>{(coin.decimals == null ? null : compactFigure(coin.balance, coin.decimals)) ?? walletAmount(coin.balance, coin.decimals)}</InspectValue>}</span>
    </span>
    <span className={`${styles.figs} ${portfolioStyles.holdingFigures}`}>
      <span className={styles.figTop}><PortfolioCoinValue coin={coin} hidden={hidden} /></span>
      {quickTrade && <PortfolioPnl value={pnl ?? null} hidden={hidden} loading={pnlLoading} />}
    </span>
  </>;
}

/** Buy, Sell or the reason they are missing, folded into the row's last cell so a holding stays one line. */
function PortfolioCoinActions({ coin, input, supported, pending, open, onTrade, reason, retry }: Readonly<{
  coin: Holding;
  input: Omit<PanelInput, "panel_id"> | null;
  supported: boolean;
  pending: boolean;
  open: boolean;
  onTrade?: PortfolioTradeAction;
  reason: string | null;
  retry?: () => void;
}>) {
  const { dispatch } = useWorkspace();
  const trade = (side: "buy" | "sell") => {
    if (!input) return;
    const asset = { ...input, panel_id: crypto.randomUUID() };
    if (onTrade) onTrade(asset, side);
    else dispatch.openOnSell(asset);
  };
  return <span className={portfolioStyles.actions}>
    {pending && <SkeletonRegion className={portfolioStyles.actions} inline label={`Checking ${coin.symbol} trading availability`}>
      {onTrade && <SkeletonBox className={portfolioStyles.buySkeleton} />}
      <SkeletonBox className={portfolioStyles.sellSkeleton} />
    </SkeletonRegion>}
    {onTrade && input && supported && <Button variant="secondary" size="sm" type="button" className={portfolioStyles.buy} aria-label={`Buy ${coin.symbol}`} onClick={() => trade("buy")}>Buy</Button>}
    {input && supported && <Button variant="secondary" size="sm" type="button" disabled={BigInt(coin.balance) === BigInt(0)} className={portfolioStyles.sell} aria-label={`Sell ${coin.symbol}`} onClick={() => trade("sell")}>Sell</Button>}
    {reason && <span className={portfolioStyles.reason}>{reason}</span>}
    {retry && <Button variant="secondary" size="sm" type="button" className={portfolioStyles.retry} aria-label={`Retry ${coin.symbol} availability`} onClick={retry}>Retry</Button>}
    {!onTrade && (input ? <PanelAddButton open={open} symbol={coin.symbol} onAdd={() => dispatch.add({ ...input, panel_id: crypto.randomUUID() })} /> : <span className={styles.slot} />)}
  </span>;
}

function tradeReason(quickTrade: boolean, balance: string, supported: boolean, pending: boolean, failed: boolean): string | null {
  if (supported || pending || (!quickTrade && balance === "0")) return null;
  return failed ? "Couldn't check trading." : "Not available on Blast.";
}

function PortfolioCoinValue({ coin, hidden }: Readonly<{ coin: Holding; hidden: boolean }>) {
  if (hidden) return HIDDEN_AMOUNT;
  if (coin.value_usd === null) return <span className={portfolioStyles.unpriced}>No price</span>;
  const exact = coin.value_usd_exact ?? coin.value_usd;
  const display = holdingValueLabel(exact);
  return <InspectValue label={`${coin.symbol} USD value`} value={`$${exact}`}>{display}</InspectValue>;
}

function holdingValueLabel(exact: string): string {
  const precise = exactDecimal(exact);
  if (precise?.n === 0n) return "$0.00";
  if (precise && precise.n > 0n && !atLeastPow10(precise, -2)) return "<$0.01";
  return terminalUsd(exact);
}

function PortfolioPnl({ value, hidden, loading }: Readonly<{ value: CostBasisFigures | null; hidden: boolean; loading: boolean }>) {
  const exact = currentPnl(value);
  const pnl = compactPnl(value);
  if (loading) return <span className={portfolioStyles.pnl}><span>PnL </span><span className={portfolioStyles.pnlUnavailable}><SkeletonText>Loading PnL</SkeletonText></span></span>;
  if (hidden) return <span className={portfolioStyles.pnl}><span>PnL </span><span className={portfolioStyles.pnlUnavailable}>{HIDDEN_AMOUNT}</span></span>;
  if (!pnl || !exact) return null;
  return <span className={portfolioStyles.pnl}><span>PnL </span>
    <span className={portfolioStyles.pnlAmount} data-tone={pnl.tone}><InspectValue label="unrealized PnL amount" value={exact.amount}>{pnl.amount}</InspectValue></span>
    {pnl.percent && exact.percent && <span className={portfolioStyles.pnlPercent} data-tone={pnl.tone}><InspectValue label="unrealized PnL return" value={exact.percent}>{pnl.percent}</InspectValue></span>}
  </span>;
}
