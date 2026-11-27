"use client";

import { DateStamp } from "#web/components/blast-ui/DateStamp.tsx";
import type { AsOf } from "@blast/core/web/contracts/items.ts";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { Button } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { Pager } from "#web/components/blast-ui/Pager.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";
import { formatAmountShort } from "#web/components/launchpad/coin/coin-format.ts";
import { poolPrices } from "#web/components/charts/candle-data.ts";
import { fetchCoinMarket } from "#web/components/social/blast-mode/workspace/panels/coin-market-reads.ts";
import { coinsByIdsQuery } from "#web/components/social/coin-home/home-client.ts";
import { shortTicker } from "#web/components/social/coins/coin-display.ts";
import { actorName, amountShort, volumeText } from "#web/components/social/coin-home/home-model.ts";
import { Avatar } from "#web/components/social/post/PostMedia.tsx";
import { readableUsd, subscriptZeros } from "#web/lib/market-format.ts";
import { PUBLIC_STALE_MS } from "#web/lib/query/client.ts";
import { queryKeys } from "#web/lib/query/keys.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { MIGRATOR_POOL_KEY } from "@blast/core/modules/launchpad-contract/venues.ts";
import type { HomeCoinMarket } from "@blast/core/web/contracts/coin-market.ts";
import {
  HOME_MAX_HOLDERS,
  type HomeAmount,
  type HomeCoin,
  type HomeHolder,
} from "@blast/core/web/contracts/home.ts";
import type {
  SocialPresaleDetail,
  SocialPresaleShare,
} from "@blast/core/web/contracts/presales.ts";

import type { PriceWindow } from "@blast/core/web/contracts/prices.ts";

import { SalePriceChart, type MarketExtras } from "./SalePriceChart";
import { formatMove, presaleHolderShare, priceDirection, type PriceMove } from "./sale-market-format";
import { useChartPrice } from "#web/components/launchpad/chart/chart-live-price.ts";
import { PoolChart } from "#web/components/social/coins/PoolChart.tsx";
import { PresaleHolderSummary } from "./PresaleHolderSummary";
import { ChartCard, CoinPriceFigure, MarketOverview, MarketPriceRow, useLastPrice } from "#web/components/social/bonding/CoinPageParts.tsx";
import coinStyles from "#web/components/social/bonding/bonding-coin.module.css";
import { ChartLastTrade } from "#web/components/launchpad/chart/ChartLastTrade.tsx";
import { CoinPriceCurrencyProvider, useCoinPriceCurrency } from "#web/components/launchpad/chart/CoinPriceCurrency.tsx";
import { useLiveListening, useLiveScreen, useReportListening } from "#web/components/launchpad/coin/LiveScreen.tsx";
import { statsAfterRead, useLiveCoin, type LiveCoinStats } from "#web/components/launchpad/coin/live-coin.ts";
import { cx } from "./cx";
import { marketPoll } from "./sale-market-poll";
import { createQuoteOf } from "@blast/core/web/contracts/create.ts";
import { atomsText, NO_VALUE } from "@blast/core/web/format.ts";
import { atLeastPow10, exactAtoms, shortFloorExact } from "@blast/core/web/exact-amount.ts";
import { bpsPercent } from "@blast/core/lib/bps.ts";

const PAGE_SIZE = 10;

function TokenAmount({
  atoms,
  decimals,
  symbol,
  label,
  assetType,
}: Readonly<{
  atoms: string;
  decimals: number | null;
  symbol: string;
  label: string;
  assetType?: string;
}>) {
  const scale = decimals ?? (assetType ? createQuoteOf(assetType)?.decimals : null);
  if (scale == null) return <>{NO_VALUE}</>;
  const value = BigInt(atoms);
  const exact = `${atomsText(value, scale)} ${symbol}`;
  const short = `${formatAmountShort(value, scale)} ${symbol}`;
  return (
    <InspectValue value={exact} label={label}>
      {short}
    </InspectValue>
  );
}

function HolderIdentity({ holder }: Readonly<{ holder: HomeHolder }>) {
  const actor = holder.actor;
  if (actor.type === "address") {
    return (
      <InspectValue value={actor.address} label="holder wallet address">
        {actor.short}
      </InspectValue>
    );
  }
  return (
    <Link className={cx("sale-holder-account")} href={actor.path}>
      <Avatar callsign={actor.callsign} src={actor.avatar_url} size={30} />
      <span>
        <b>{actorName(actor)}</b>
        <span>@{actor.callsign}</span>
      </span>
    </Link>
  );
}

function HolderTable({ coin }: Readonly<{ coin: HomeCoin }>) {
  const [page, setPage] = useState(1);
  const holders = coin.top_holders.holders.slice(0, HOME_MAX_HOLDERS);
  const pages = Math.max(1, Math.ceil(holders.length / PAGE_SIZE));
  const current = Math.min(page, pages);
  if (page > pages) setPage(pages);
  const start = (current - 1) * PAGE_SIZE;
  const rows = holders.slice(start, start + PAGE_SIZE);
  if (rows.length === 0) {
    return (
      <EmptyState
        title={
          coin.holders === 0
            ? "No holder wallets yet"
            : "Holder balances are not available yet"
        }
      />
    );
  }
  return (
    <>
      <p className={cx("trading-chart-caption")}>
        Linked wallets grouped · excludes pool and presale balances.
      </p>
      <table
        className={cx("sale-holders-table")}
        aria-label="Top 100 holders by token balance"
      >
        <thead>
          <tr className={cx("sale-holder-head")}>
            <th scope="col">Holder</th>
            <th scope="col">Balance</th>
            <th scope="col">% of total supply</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((holder, index) => (
            <tr
              className={cx("sale-holder-row")}
              key={
                holder.actor.type === "account"
                  ? holder.actor.callsign
                  : holder.actor.address
              }
            >
              <td className={cx("sale-holder-identity")}>
                <span className={cx("sale-holder-rank", "num")}>
                  {start + index + 1}
                </span>
                <HolderIdentity holder={holder} />
              </td>
              <td className={cx("sale-holder-balance", "num")}>
                <span
                  className={cx("sale-holder-mobile-label")}
                  aria-hidden="true"
                >
                  Balance
                </span>
                <TokenAmount
                  atoms={holder.balance}
                  assetType={coin.coin_type}
                  decimals={coin.decimals}
                  symbol={coin.symbol}
                  label={`token balance for ${actorName(holder.actor)}`}
                />
              </td>
              <td className={cx("sale-holder-share", "num")}>
                <span
                  className={cx("sale-holder-mobile-label")}
                  aria-hidden="true"
                >
                  % of total supply
                </span>
                {presaleHolderShare(holder)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className={cx("sale-holder-pagination")}>
        <p role="status">
          {start + 1}–{Math.min(start + PAGE_SIZE, holders.length)} of{" "}
          {holders.length} top holders
        </p>
        <Pager onPage={setPage} page={current} pages={pages} what="holders" />
      </div>
    </>
  );
}

function volumeFigure(coin: HomeCoin | null, volume: readonly HomeAmount[] | null, loading: boolean): ReactNode {
  if (!coin || !volume) return !coin && loading ? <SkeletonText>0000</SkeletonText> : null;
  const dollars = volumeText({ bought: volume, sold: [], committed: [] });
  if (dollars !== null) return <>{dollars}{dollars.endsWith("+") && <span className="sr-only"> partial total</span>}</>;
  const named = volume.filter((amount) => amount.quote_symbol !== null && amount.quote_decimals !== null);
  return named.length ? named.map((amount) => (
    <i className={cx("sale-volume-amount")} key={amount.quote_type}>{amountShort(amount)}</i>
  )) : null;
}

function poolBalance(atoms: string, decimals: number, symbol: string | null, label: string) {
  const units = BigInt(atoms);
  const amount = exactAtoms(units, decimals)!;
  const figure = atLeastPow10(amount, 3)
    ? shortFloorExact(amount)
    : subscriptZeros(formatAmountShort(units, decimals));
  const ticker = shortTicker(symbol);
  const exact = atomsText(units, decimals);
  return {
    short: ticker ? `${figure} ${ticker}` : `${label}: ${figure}`,
    exact: symbol?.trim() ? `${exact} ${symbol}` : `${label}: ${exact}`,
  };
}

function PoolLiquidity({ usd, market, symbol }: Readonly<{ usd: string; market: HomeCoinMarket; symbol: string | null }>) {
  const value = readableUsd(usd);
  const pool = market.pool;
  const balances = pool ? [
    poolBalance(pool.coin_atoms, market.decimals, symbol, "Token"),
    poolBalance(pool.quote_atoms, market.quote.decimals, market.quote.symbol, "Quote"),
  ] : [];
  return <dl className={cx("kv")}><div>
    <dt>Liquidity</dt>
    <dd><InspectValue
      value={value}
      label="liquidity"
      triggerLabel={`Inspect liquidity: ${value}`}
      description={balances.map((balance) => balance.short).join(", ") || undefined}
      copyValue={[`$${usd}`, ...balances.map((balance) => balance.exact)].join("\n")}
    >{value}</InspectValue></dd>
  </div></dl>;
}

/** The day's move for the price line: the market read's 24-hour window, when it has both its dollar change and its percentage. */
function dayMove(market: HomeCoinMarket | null): PriceMove | null {
  const day = market?.windows["24h"];
  return day?.change_usd != null && day.change_bps != null ? { usd: day.change_usd, bps: day.change_bps } : null;
}

/**
 * A notice only when the market read is behind: routine freshness is not narrated. While the
 * live screen hears the coin, the read's age says nothing: it rests on purpose.
 */
function delayNote(coin: HomeCoin | null, failed: boolean, asOf: AsOf | null, nowMs: number, listening: boolean): ReactNode {
  if (!coin || !asOf) return null;
  const stale = failed || (!listening && (asOf.lag_ms > 60_000 || nowMs - asOf.timestamp_ms > 60_000));
  if (!stale) return null;
  return (
    <p className={cx("trading-chart-caption")}>
      Updates delayed · <DateStamp at={asOf.timestamp_ms} label="market update time" />
    </p>
  );
}

export function SaleMarketView({
  coin,
  market = null,
  marketLoading = false,
  venue,
  liquidity,
  loading,
  failed,
  asOf,
  volume,
  nowMs,
  onRetry,
  chart,
  activity,
  live = null,
  listening = false,
  children,
}: Readonly<{
  /** The Coin board's Activity card, handed the holders' content for its Holders tab; without it the holders keep a card of their own. */
  activity?: (holders: ReactNode) => ReactNode;
  coin: HomeCoin | null;
  /** The coin market read (`GET /api/social/home/market`): the FDV and liquidity tiles and the price's dollar move. */
  market?: HomeCoinMarket | null;
  marketLoading?: boolean;
  venue?: string | null;
  liquidity: (SocialPresaleShare & Pick<HomeCoin, "symbol" | "decimals"> & Partial<Pick<HomeCoin, "coin_type">>) | null;
  loading: boolean;
  failed: boolean;
  asOf: AsOf | null;
  volume: readonly HomeAmount[] | null;
  nowMs: number;
  onRetry: () => void;
  chart?: (extras: MarketExtras) => ReactNode;
  /** The coin's stats from the tab's market stream, newer than the reads: they replace FDV, holders and the day's volume. */
  live?: LiveCoinStats | null;
  /** The live screen hears the coin (`useLiveListening`), so the reads rest and their age is no delay. */
  listening?: boolean;
  children?: ReactNode;
}>) {
  const fdv = live?.fdvUsd ?? market?.fdv_usd;
  const tradeId = market?.price_as_of_ms == null ? null : String(market.price_as_of_ms);
  const overview = <MarketOverview
    fdv={fdv}
    fdvFigure={fdv != null
      ? <InspectValue value={`$${fdv}`} label="FDV in USD">{readableUsd(fdv)}</InspectValue>
      : marketLoading ? <SkeletonText>0000</SkeletonText> : null}
    holders={live?.holders ?? coin?.holders}
    holdersFigure={loading ? <SkeletonText>0000</SkeletonText> : null}
    volumeFigure={live?.volumeUsd != null ? readableUsd(live.volumeUsd) : volumeFigure(coin, volume, loading)}
    venue={venue ?? market?.pool?.venue}
    tradeId={tradeId}
  />;
  const poolLiquidity = market?.liquidity_usd == null ? null
    : <PoolLiquidity usd={market.liquidity_usd} market={market} symbol={coin?.symbol ?? null} />;
  const note = delayNote(coin, failed, asOf, nowMs, listening);
  const holders = <SaleHolders coin={coin} liquidity={liquidity} loading={loading} failed={failed} summary={!!activity} onRetry={onRetry} />;
  return (
    <>
      {chart ? chart({ note, move: dayMove(market) }) : note}
      {overview}
      {activity?.(holders)}
      {children}
      {!activity && (
        <section className={cx("card sale-sec")} aria-label="Token holders">
          <div className={cx("sec-title")}>
            <h2>Top holders</h2>
          </div>
          {holders}
        </section>
      )}
      {poolLiquidity}
    </>
  );
}

function SaleHolders({ coin, liquidity, loading, failed, summary, onRetry }: Readonly<{
  coin: HomeCoin | null;
  liquidity: Parameters<typeof SaleMarketView>[0]["liquidity"];
  loading: boolean;
  failed: boolean;
  summary: boolean;
  onRetry: () => void;
}>) {
  const retry = <Button onClick={onRetry} size="sm" variant="ghost">Retry market data</Button>;
  const table = coin ? <HolderTable key={coin.coin_type} coin={coin} /> : null;
  return <>
    {coin ? (
      <>
        {summary && coin.top_holders.holders.length ? <PresaleHolderSummary coin={coin}>{table}</PresaleHolderSummary> : table}
        {failed ? retry : null}
      </>
    ) : loading ? (
      <div className={cx("sale-holders-table")} aria-busy="true" aria-label="Loading holders" role="status">
        <SkeletonText>Holder balances</SkeletonText>
      </div>
    ) : (
      <EmptyState action={retry} role="alert" title="Holder data is unavailable">Try again in a moment.</EmptyState>
    )}
    {liquidity ? (
      <dl className={cx("sale-liquidity-allocation")}>
        <div>
          <dt>Pool allocation at launch</dt>
          <dd className={cx("num")}>
            <strong>{bpsPercent(BigInt(liquidity.bps))} of supply</strong>
            <TokenAmount
              atoms={liquidity.amount}
              assetType={liquidity.coin_type}
              decimals={liquidity.decimals}
              symbol={liquidity.symbol}
              label="liquidity allocation at launch"
            />
          </dd>
        </div>
      </dl>
    ) : null}
  </>;
}

export function SaleMarket({
  sale,
  terms,
  nowMs,
  windows,
  activity,
  children,
}: Readonly<{
  sale: SocialPresaleDetail["presale"];
  terms: SocialPresaleDetail["terms"];
  nowMs: number;
  /** The range switch's windows, as the page names them. */
  windows?: readonly (readonly [PriceWindow, string])[];
  activity?: (holders: ReactNode) => ReactNode;
  children?: ReactNode;
}>) {
  const client = useAppQueryClient();
  const listening = useLiveListening();
  const refetchInterval = marketPoll(listening);
  const query = useQuery(
    {
      ...coinsByIdsQuery([sale.presale_id], "24h", HOME_MAX_HOLDERS),
      refetchInterval,
    },
    client,
  );
  // The coin's FDV and its day's move in dollars (interest-protocol/blast-v2#534), on Home's public root.
  const marketQuery = useQuery(
    {
      queryKey: [...queryKeys.home.all, "market", sale.sale_token],
      queryFn: ({ signal }) => fetchCoinMarket(sale.sale_token, signal),
      staleTime: PUBLIC_STALE_MS,
      refetchInterval,
    },
    client,
  );
  const liveScreen = useLiveScreen();
  const market = marketQuery.data?.coin_type === sale.sale_token ? marketQuery.data : null;
  const poolKey = market?.pool ? `${market.pool.venue}:${market.pool.id}` : null;
  // The chart's own pool, so the tab's stream does not widen; a pool the stream cannot key is never joined.
  const streamed = poolKey !== null && MIGRATOR_POOL_KEY.test(poolKey);
  const live = useLiveCoin({ coin: sale.sale_token, pools: streamed ? [poolKey] : [], expected: null, enabled: liveScreen && streamed });
  useReportListening(live.live);
  const coin =
    query.data?.coins.find(
      (item) =>
        item.presale_id === sale.presale_id &&
        item.coin_type === sale.sale_token &&
        item.lifecycle === "migrated",
    ) ?? null;
  return (
    <SaleMarketView
      coin={coin}
      market={market}
      marketLoading={marketQuery.isPending}
      venue={sale.venue}
      liquidity={
        terms
          ? {
              ...terms.supply.liquidity,
              coin_type: sale.sale_token,
              symbol: sale.symbol,
              decimals: sale.sale_decimals ?? null,
            }
          : null
      }
      loading={query.isPending}
      failed={query.isError}
      asOf={query.data?.as_of ?? null}
      volume={
        coin ? (query.data?.pool_volumes?.[coin.coin_type] ?? null) : null
      }
      nowMs={nowMs}
      onRetry={() => void query.refetch()}
      activity={activity}
      live={statsAfterRead(live.stats, query.data?.as_of.checkpoint ?? null)}
      listening={listening}
      chart={(extras) => market?.pool ? (
        <CoinPriceCurrencyProvider quoteType={market.quote.type} quoteSymbol={market.quote.symbol}>
          <div className={coinStyles.market} data-sale-market="">
            <ChartCard head={<PresaleMarketPrice market={market} move={extras.move} />}><SalePoolChart sale={sale} market={market} pool={market.pool} /></ChartCard>
          </div>
          {extras.note}
        </CoinPriceCurrencyProvider>
      ) : <SalePriceChart sale={sale} trade={null} enabled={!marketQuery.isPending} windows={windows} note={extras.note} />}
    >
      {children}
    </SaleMarketView>
  );
}

const POOL_CHART_CONTROLS = { range: "24h", interval: "5m" } as const;

/**
 * A graduated sale's pool on the chart and market feed every coin uses. Only swaps of the verified pool are
 * candles: contributions, claims and refunds stay in the sale's own record. A pool the market read does not
 * know shows the empty state.
 */
function SalePoolChart({ sale, market, pool }: Readonly<{
  sale: SocialPresaleDetail["presale"];
  market: HomeCoinMarket;
  pool: NonNullable<HomeCoinMarket["pool"]>;
}>) {
  const poolKey = `${pool.venue}:${pool.id}`;
  // The headline's rule, so the chart never shows a price the headline hides, or the reverse.
  const price = usePresalePoolPrice(pool);
  const uncharted = <EmptyState title="No price history for this pool yet" />;
  // The shared feed keys pools by the venues it indexes: a pool on any other venue has no chart.
  if (!MIGRATOR_POOL_KEY.test(poolKey)) return uncharted;
  return <PoolChart
    key={pool.id}
    poolKey={poolKey}
    coinType={sale.sale_token}
    symbol={sale.symbol}
    decimals={market.decimals}
    quote={market.quote}
    initialControls={POOL_CHART_CONTROLS}
    live
    price={price}
    uncovered={uncharted}
  />;
}

/** The pool's price from its chart, once it is newer than the pool's last change the market read saw. */
function usePresalePoolPrice(pool: HomeCoinMarket["pool"]) {
  const price = useChartPrice(pool ? `${pool.venue}:${pool.id}` : null);
  const confirmedAt = price?.provenance.timestampMs;
  // Consecutive checkpoints can share a timestamp. Require proof past the last pool mutation.
  return pool && confirmedAt != null && confirmedAt > pool.as_of_ms ? price : null;
}

function PresaleMarketPrice({ market, move }: Readonly<{ market: HomeCoinMarket; move?: PriceMove | null }>) {
  const currency = useCoinPriceCurrency();
  const live = usePresalePoolPrice(market.pool);
  const last = useLastPrice(live?.price);
  const prices = poolPrices(market.decimals, market.quote.decimals, currency?.quoteUsd);
  const quoteSymbol = prices.usd ? undefined : market.quote.symbol;
  return <MarketPriceRow showCurrency={currency?.rate != null} priceNamesUnit={live != null}
    activity={<ChartLastTrade placement="headline" playSound />}
    price={live ? <CoinPriceFigure price={prices.price(live.price)} quoteSymbol={quoteSymbol} tradeId={live.cursor} /> : NO_VALUE}
    reserve={!live && last != null ? <CoinPriceFigure price={prices.price(last)} quoteSymbol={quoteSymbol} tradeId={null} /> : null}
    change={move && last != null && prices.usd ? { value: <>{formatMove(move)} <span>24h</span></>, direction: priceDirection(move.bps) } : null} />;
}
