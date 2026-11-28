"use client";

import { WalletTradesProvider } from "#web/components/launchpad/activity/wallet-trades.tsx";
import { exactDecimal, exactText, multiplyExact } from "@blast/core/web/exact-amount.ts";
import { SUI_COIN_TYPE, USDC_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import { SUI_POOL_QUOTE, type PoolQuote } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { fdvInQuote } from "@blast/core/modules/social/prices/valuation.ts";
import { NO_VALUE, shortAddress as shortId } from "@blast/core/web/format.ts";
import { MEME_TOTAL_SUPPLY_WHOLE_TOKENS } from "@interest-protocol/blast-sdk/launchpad";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { createPortal } from "react-dom";
import type { VenuePoolKey } from "#web/components/launchpad/activity/activity-live.ts";
import { IndexedPoolTrades } from "#web/components/social/coins/IndexedPoolTrades.tsx";
import { CoinTradeVisibility } from "#web/components/social/coins/coin-trade-visibility.ts";
import { listOriginHistoryState, useListOrigin } from "#web/components/blast-ui/list-restoration.ts";

import { usePhoneLayout } from "#web/components/blast-ui/use-shell-prefs.ts";
import { poolPrices } from "#web/components/charts/candle-data.ts";
import { CoinPriceCurrencyProvider, useCoinPriceCurrency } from "#web/components/launchpad/chart/CoinPriceCurrency.tsx";
import { Button, ButtonLink, DisclosureSummary } from "#web/components/blast-ui/Button.tsx";
import { CoinTypeTag } from "#web/components/blast-ui/CoinTypeTag.tsx";
import { CopyAddress } from "#web/components/blast-ui/CopyAddress.tsx";
import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { Disclosure } from "#web/components/blast-ui/Disclosure.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { Sheet, SheetClose, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { useHydrated } from "#web/components/ui-libraries/use-hydrated.tsx";
import { SectionBoundary } from "#web/components/launchpad/primitives/SectionBoundary.tsx";
import type { TerminalSlots } from "#web/components/launchpad/LaunchpadTerminal.tsx";
import { formatAmountShort } from "#web/components/launchpad/coin/coin-format.ts";
import { readableUsd } from "#web/lib/market-format.ts";
import { allocationRows, coinIdentity, coinMarketOffline, feeRouteLabel, pageLifecycle, sectionData, venueMarketCatchingUp, venueRoute } from "#web/components/launchpad/coin/coin-view.ts";
import { coinCreatorAddress, witnessVenue, type CoinPage } from "@blast/core/modules/launchpad-coin/contracts.ts";
import { poolCoinMetadata } from "@blast/core/modules/launchpad-coin/pool-coin-metadata.ts";
import type { LaunchPageDetails } from "@blast/core/modules/launchpad-coin/transfer.ts";
import type { LegacyCoinMarket } from "@blast/core/modules/launchpad-discovery/rows.ts";
import { createQuoteOf } from "@blast/core/web/contracts/create.ts";

import { CoinPageWallet } from "#web/components/blast-ui/CoinPageWallet.tsx";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { CoinLegacyMark, CoinVerifiedMark, PreviousIcon, TelegramIcon } from "#web/components/blast-ui/Icons.tsx";
import { useCoinTrade } from "./use-coin-trade.ts";
import { ChartPriceLaunch, useChartPrice } from "#web/components/launchpad/chart/chart-live-price.ts";
import { ChartLastTrade } from "#web/components/launchpad/chart/ChartLastTrade.tsx";
import { ChartTradeContext } from "#web/components/launchpad/chart/chart-trade-context.ts";
import { LiveFigureCue } from "#web/components/blast-ui/LiveFigureCue.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { pollInterval } from "#web/lib/query/polling.ts";
import { legacyCoinMarketQuery } from "./bonding-client.ts";
import { useLiveListening, useLiveScreen, useReportListening } from "#web/components/launchpad/coin/LiveScreen.tsx";
import { statsAfterRead, useLiveCoin, type LiveCoin, type LiveCoinStats } from "#web/components/launchpad/coin/live-coin.ts";
import type { ExpectedDeployment } from "@blast/core/modules/launchpad-contract/provenance.ts";
import styles from "./bonding-coin.module.css";
import { ChartCard, CoinCover, CoinIdentityHeader, CoinPriceFigure, CoinTradingActivity, Fact, MarketOverview, MarketPriceRow, useLastPrice } from "./CoinPageParts.tsx";
import { bpsPercent } from "@blast/core/lib/bps.ts";

const ZERO = BigInt(0);
const ALL_BPS = BigInt(10_000);
const creatorShare = (protocolBps: string) => bpsPercent(ALL_BPS - BigInt(protocolBps));

function Card({ title, children }: Readonly<{ title: string; children: ReactNode }>) {
  return <section className={styles.card}><h2>{title}</h2>{children}</section>;
}
function coinView(page: CoinPage, tick: ReturnType<typeof useCoinTrade>["tick"] = null) {
  const identity = coinIdentity(page);
  const curve = sectionData(page.curve);
  const coin = sectionData(page.coin);
  const fresh = page.fresh.status === "read" ? page.fresh.launch : null;
  const lifecycle = pageLifecycle(page);
  const pool = sectionData(page.venue);
  const quoteType = curve?.launch.quoteType ?? fresh?.quoteType ?? "";
  const quote = createQuoteOf(quoteType);
  const quoteKey = quote?.symbol === "SUI" ? "sui" : quote?.symbol === "USDC" ? "usdc" : quoteType;
  const quoteMark = <QuoteMark coinType={quoteType} coinKey={quoteKey} symbol={identity.quoteSymbol} markSymbol={quote?.symbol === "TEST_SUI" ? "TSUI" : quote?.symbol} />;
  const venue = venueRoute(page)?.venue ?? (curve ? witnessVenue(curve.launch.launch.migrationWitness) : null);
  const inputs = tick?.economics?.inputs ?? curve?.launch.economics.inputs;
  const economics = lifecycle === "migrated" || page.source.kind === "venue" ? pool?.economics : tick?.economics ?? curve?.launch.economics;
  const memeDecimals = economics ? Number(economics.inputs.memeDecimals) : identity.memeDecimals;
  const quoteDecimals = economics?.inputs.quoteDecimals != null ? Number(economics.inputs.quoteDecimals) : identity.quoteDecimals;
  const amount = (value: bigint, decimals = quoteDecimals) => <span className={styles.amount}>{decimals === null ? NO_VALUE : <>{formatAmountShort(value, decimals)}{quoteMark}</>}</span>;
  const progress = tick?.progress ?? (curve?.progressBps == null ? null : Math.min(100, Math.max(0, Number(curve.progressBps) / 100)));
  return { identity, curve, coin, fresh, quoteMark, amount, lifecycle, venue, inputs, economics, progress, pool, memeDecimals, quoteDecimals };

}
type View = ReturnType<typeof coinView>;

function statusLabel(lifecycle: View["lifecycle"], confirmed: boolean) {
  switch (lifecycle) {
    case "migrated": return "Graduated";
    case "migration_ready": return "Graduating";
    case "opening_round": return "Opening round";
    default: return confirmed ? "Bonding" : "Unconfirmed";
  }
}

function CreatorByline({ page }: Readonly<{ page: CoinPage }>) {
  const creator = coinCreatorAddress(page);
  if (!creator) {
    return page.fresh.status === "read" && page.fresh.launch.creatorRecipient?.kind === "account"
      ? <span className={styles.creator}>Created by a Blast account</span>
      : null;
  }
  return (
    <span className={styles.creator}>
      <CopyAddress value={creator} label="Created by" copyLabel="Copy creator wallet address" name={page.creatorName} />
    </span>
  );
}

/** `compact`: a chart shows, and on a phone the creator and the coin's address move under it. */
function Identity({ page, view, fallbackLogo, verified, compact }: Readonly<{ page: CoinPage; view: View; fallbackLogo?: string; verified: boolean; compact: boolean }>) {
  const { identity, lifecycle } = view;
  return <CoinIdentityHeader
    coin={{ key: identity.coinType ?? page.launchId, coinType: identity.coinType ?? undefined, iconUrl: identity.iconUrl || fallbackLogo || null, round: false }}
    name={identity.name ?? identity.symbol}
    symbol={identity.symbol}
    status={statusLabel(lifecycle, page.confirmed)}
    graduated={lifecycle === "migrated"}
    mark={verified ? <CoinVerifiedMark /> : null}
    compact={compact}
  >
    <CreatorByline page={page} />
  </CoinIdentityHeader>;
}

function QuoteMark({ coinType, coinKey, symbol, markSymbol = symbol }: Readonly<{ coinType: string; coinKey: string; symbol: string; markSymbol?: string }>) {
  return <><CoinMark coin={{ key: coinKey, coinType, round: true, iconUrl: null, symbol: markSymbol }} size={18} /><span>{symbol}</span></>;
}

type PriceUnits = Readonly<{ memeDecimals: number; quoteDecimals: number; quoteSymbol: string; quoteMark: ReactNode }>;

function priceUnits(view: View): PriceUnits | null {
  const { memeDecimals, quoteDecimals, quoteMark, identity } = view;
  return memeDecimals === null || quoteDecimals === null ? null : {
    memeDecimals, quoteDecimals, quoteSymbol: identity.quoteSymbol, quoteMark,
  };
}

function PriceValue({ units, price: rawPrice, tradeId }: Readonly<{ units: PriceUnits; price: string; tradeId: string | null }>) {
  const { memeDecimals, quoteDecimals, quoteMark, quoteSymbol } = units;
  const currency = useCoinPriceCurrency();
  const prices = poolPrices(memeDecimals, quoteDecimals, currency?.quoteUsd);
  return <CoinPriceFigure price={prices.price(rawPrice)} tradeId={tradeId} quoteSymbol={prices.usd ? undefined : quoteSymbol} quoteMark={quoteMark} />;
}

function MarketPrice({ units, price, tradeId = null, activity, showCurrency }: Readonly<{
  units: PriceUnits | null; price?: string | null; tradeId?: string | null; activity?: ReactNode; showCurrency?: boolean;
}>) {
  const last = useLastPrice(price);
  return <MarketPriceRow priceLabel="Current pool price" price={price != null && units ? <PriceValue units={units} price={price} tradeId={tradeId} /> : NO_VALUE}
    reserve={price == null && last != null && units ? <PriceValue units={units} price={last} tradeId={null} /> : null}
    activity={activity} showCurrency={showCurrency} />;
}

function ProgressCard({ view, tradeId, children }: Readonly<{ view: View; tradeId: string | null; children?: ReactNode }>) {
  if (!view.curve || !view.inputs) return null;
  return <section className={`${styles.card} ${styles.progressCard} ${styles.marketStats}`} aria-label="Launch progress">
    <RaiseProgress view={view} tradeId={tradeId} />
    {children}
  </section>;
}

function ProgressFacts({ view, tradeId }: Readonly<{ view: View; tradeId: string | null }>) {
  const { economics, coin, venue, lifecycle } = view;
  const currency = useCoinPriceCurrency();
  const rate = exactDecimal(currency?.rate);
  const fdv = fdvInQuote(economics?.price, economics?.inputs.currencySupply, economics?.inputs.quoteDecimals);
  const fdvLabel = fdv && rate ? readableUsd(exactText(multiplyExact(fdv, rate))) : null;
  if (!fdvLabel && !coin && !venue) return null;
  return <dl className={styles.stats}>
    {fdvLabel && <Fact label="FDV"><LiveFigureCue tradeId={tradeId} value={fdvLabel}>{fdvLabel}</LiveFigureCue></Fact>}
    {coin ? <Fact label="Holders">{coin.stats.holders.toLocaleString("en-US")}</Fact> : null}
    {venue ? <Fact label={lifecycle === "migrated" ? "Trading on" : "Graduates to"}><DexIdentity venue={venue} size={18} /></Fact> : null}
  </dl>;
}

function RaiseProgress({ view, tradeId }: Readonly<{ view: View; tradeId: string | null }>) {
  const { inputs, amount, progress, quoteDecimals } = view;
  if (view.lifecycle === "migration_ready") return <div className={styles.migrationState}><strong>Graduation target reached</strong><span>Migration pending</span></div>;
  if (inputs?.quoteReserve == null || inputs.graduationTarget === null) return null;
  const raised = quoteDecimals === null ? NO_VALUE : formatAmountShort(inputs.quoteReserve, quoteDecimals);
  const percent = progress === null ? null : `${progress.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;
  return <>
    <div className={styles.raised}>
      <span>
        <b><LiveFigureCue tradeId={tradeId} value={raised}>{amount(inputs.quoteReserve)}</LiveFigureCue></b>
        <small>of {amount(inputs.graduationTarget)} to graduate</small>
      </span>
      {percent && <strong className={styles.progressPercent}><LiveFigureCue tradeId={tradeId} value={percent}>{percent}</LiveFigureCue></strong>}
    </div>
    {progress === null ? null : <progress aria-label="Raise progress" max={100} value={progress} />}
  </>;
}

function AllocationCard({ view }: Readonly<{ view: View }>) {
  const { curve, identity, lifecycle, fresh } = view;
  if (!curve) return null;
  const graduated = lifecycle === "migrated";
  const { launch, economics } = curve;
  const { symbol } = identity;
  const decimals = launch.economics.inputs.memeDecimals;
  const memeDecimals = Number(decimals);
  const initialSupply = fresh?.atomicSupply ?? MEME_TOTAL_SUPPLY_WHOLE_TOKENS * BigInt(10) ** decimals;
  const migration = graduated ? launch.migration : null;
  const soldOnCurve = economics && migration ? economics.curveMeme - migration.disposedMeme : null;
  return (
    <Card title="Tokenomics">
      <dl className={styles.facts}>
        <Fact label={graduated ? "Curve allocation" : "On the curve"}>{bpsPercent(curve.plan.curveMemeBps)}</Fact>
        {soldOnCurve !== null ? (
          <Fact label="Sold on the curve">{formatAmountShort(soldOnCurve, memeDecimals)}{"\u00A0"}{symbol}</Fact>
        ) : null}
        {!graduated && economics ? (
          <Fact label="Projected curve sales">{formatAmountShort(economics.curveMemeReleased, memeDecimals)}{"\u00A0"}{symbol}</Fact>
        ) : null}
        {migration && migration.disposedMeme > ZERO ? (
          <Fact label={migration.totalSupplyAfter < initialSupply ? "Burned at graduation" : "Sent to the burn address at graduation"}>
            {formatAmountShort(migration.disposedMeme, memeDecimals)}{"\u00A0"}{symbol}
          </Fact>
        ) : null}
        <Fact label="For the pool">{bpsPercent(curve.plan.lpMemeBps)}</Fact>
        {curve.plan.protocolMemeBps > ZERO ? <Fact label="Blast">{bpsPercent(curve.plan.protocolMemeBps)}</Fact> : null}
        {allocationRows(curve.plan).map((recipient) => <Fact key={recipient.key} label={shortId(recipient.recipient.destination)}>{bpsPercent(recipient.memeBps)}</Fact>)}
      </dl>
    </Card>
  );
}

function FeesCard({ view }: Readonly<{ view: View }>) {
  const { curve, coin, identity } = view;
  const policy = coin?.feePolicy;
  const graduated = view.lifecycle === "migrated";
  const curvePolicy = graduated ? null : policy?.curve;
  if (!curve) return null;
  const poolFeeRate = curve.launch.launch.poolFeeRate;
  const routes = curve.split.routes.filter(({ bps }) => bps > ZERO);
  return (
    <Card title={graduated ? "Pool fees" : "Where money goes"}>
      <dl className={styles.facts}>
        {graduated && poolFeeRate !== null ? <Fact label="Pool trading fee">{Number(poolFeeRate) / 10_000}%</Fact> : null}
        {!graduated ? <Fact label="Raised">{bpsPercent(curve.plan.lpQuoteBps)} pool · {bpsPercent(curve.plan.protocolQuoteBps)} Blast</Fact> : null}
        {curvePolicy ? (
          <Fact label="Curve fees">
            Creator {creatorShare(curvePolicy.protocol_bps)} · Blast {bpsPercent(BigInt(curvePolicy.protocol_bps))}
          </Fact>
        ) : null}
        {policy?.lp ? <>
          <Fact label={`Blast’s share of pool fees (${identity.quoteSymbol})`}>{bpsPercent(BigInt(policy.lp.quote_bps))}</Fact>
          <Fact label={`Blast’s share of pool fees (${identity.symbol})`}>{bpsPercent(BigInt(policy.lp.meme_bps))}</Fact>
        </> : null}
      </dl>
      {routes.length ? <>
        <p className={styles.note}>Who gets the remaining pool fees</p>
        <dl className={styles.facts}>
          {routes.map(({ destination, bps }) => (
            <Fact key={destination.kind === "Address" ? destination.address : destination.kind} label={feeRouteLabel(destination)}>
              {bpsPercent(bps)}
            </Fact>
          ))}
        </dl>
      </> : null}
    </Card>
  );
}

function LaunchHistory({ view }: Readonly<{ view: View }>) {
  const { curve, inputs, amount, fresh, identity } = view;
  if (!curve || !inputs) return null;
  return <section className={styles.card} aria-label="Launch history"><Disclosure title="Launch history">
    <dl className={styles.facts}>
      {inputs.graduationTarget !== null ? <Fact label="Graduation target">{amount(inputs.graduationTarget)}</Fact> : null}
      {inputs.virtualQuote !== null ? <Fact label="Virtual starting liquidity">{amount(inputs.virtualQuote)}</Fact> : null}
      <Fact label="Raise allocation">{bpsPercent(curve.plan.lpQuoteBps)} pool · {bpsPercent(curve.plan.protocolQuoteBps)} Blast</Fact>
      {fresh ? <><Fact label={`Curve trading fee (${identity.quoteSymbol})`}>{bpsPercent(fresh.quoteFeeBps)}</Fact><Fact label={`Curve trading fee (${identity.symbol})`}>{bpsPercent(fresh.memeFeeBps)}</Fact></> : null}
    </dl>
  </Disclosure></section>;
}

function TermsCard({ view }: Readonly<{ view: View }>) {
  const { curve, inputs, amount, fresh, lifecycle, identity } = view;
  if (!curve || !inputs) return null;
  const poolFeeRate = curve.launch.launch.poolFeeRate;
  return (
<Card title="Terms"><dl className={styles.facts}>
            {inputs.virtualQuote !== null ? <Fact label="Virtual starting liquidity">{amount(inputs.virtualQuote)}</Fact> : null}
            {inputs.graduationTarget !== null ? <Fact label="Raise target">{amount(inputs.graduationTarget)}</Fact> : null}
            {lifecycle !== "migrated" && poolFeeRate !== null ? <Fact label="Pool fee">{Number(poolFeeRate) / 10_000}%</Fact> : null}
            {fresh ? <><Fact label={`Trading fee (${identity.quoteSymbol})`}>{bpsPercent(fresh.quoteFeeBps)}</Fact><Fact label={`Trading fee (${identity.symbol})`}>{bpsPercent(fresh.memeFeeBps)}</Fact></> : null}
            <Fact label="Liquidity">Locked forever</Fact>
          </dl></Card>
  );
}

function AboutCard({ details, view }: Readonly<{ details: LaunchPageDetails | null; view: View }>) {
  const { curve } = view;
  if (!details?.tagline && !details?.links.length && !curve?.launch.metadata?.description && !details?.cover) return null;
  return (
<Card title="About">
          {details?.cover ? <CoinCover cover={details.cover} /> : null}
          {details?.tagline ? <p className={styles.tagline}>{details.tagline}</p> : null}
          {curve?.launch.metadata?.description && curve.launch.metadata.description.trim() !== details?.tagline.trim() ? <p className={styles.note}>{curve.launch.metadata.description}</p> : null}
          <AboutLinks links={details?.links ?? []} />
        </Card>
  );
}

function AboutLinks({ links }: Readonly<{ links: LaunchPageDetails["links"] }>) {
  return <div className={styles.links}>
    {links.map((link) => (
      <ButtonLink href={link.url} key={link.label} rel="noopener noreferrer" size="sm" target="_blank">
        {link.label === "Telegram" ? <TelegramIcon /> : null}
        {link.label}
      </ButtonLink>
    ))}
  </div>;
}

/** `home`: a coin with no bonding curve (SUI, USDC) goes back to Home when it has no list to return to. */
function CoinBackLink({ origin, tradeJump = true, home = false }: Readonly<{ origin: string | null; tradeJump?: boolean; home?: boolean }>) {
  const from = coinBackOrigin(origin);
  const label = from?.pathname === "/" ? "Home" : "Bonding curves";
  const href = from ? `${from.pathname}${from.search}${from.hash}` : home ? "/" : "/bonding";

  return <div className={styles.back}>
    <Link href={href} replace onNavigate={(event) => {
      if (!from || window.history.length < 2) {
        return;
      }
      const navigation = window.navigation;
      if (navigation) {
        const previous = navigation.entries()[(navigation.currentEntry?.index ?? 0) - 1];
        const { blastOriginEntry } = listOriginHistoryState();
        const matches = blastOriginEntry
          ? previous?.key === blastOriginEntry && coinBackOrigin(previous.url)?.pathname === from.pathname
          : previous?.url === from.href;
        if (!matches) return;
      }
      event.preventDefault();
      window.history.back();
    }}>
      <PreviousIcon strokeWidth="2" />{from ? label : home ? "Home" : "Bonding"}
    </Link>
    <CoinPageWallet />
    {tradeJump ? <ButtonLink className={styles.tradeJump} href="#coin-trade" size="sm">Trade</ButtonLink> : null}
  </div>;
}

function coinBackOrigin(origin: string | null | undefined): URL | null {
  if (typeof origin !== "string") {
    return null;
  }
  try {
    const from = new URL(origin);
    return from.origin === window.location.origin && (from.pathname === "/" || from.pathname === "/bonding")
      ? from
      : null;
  } catch {
    return null;
  }
}

function CoinPageHeader({ page, view, details, verified, marketCatchingUp, compact }: Readonly<{
  page: CoinPage; view: View; details: LaunchPageDetails | null; verified: boolean; marketCatchingUp: boolean; compact: boolean;
}>) {
  const origin = useListOrigin(page.launchId);
  return <>
    <CoinBackLink origin={origin} />
    <Identity page={page} view={view} fallbackLogo={details?.iconUrl} verified={verified} compact={compact} />
    {!page.confirmed ? <EmptyState framed title="Launch could not be confirmed" role="alert" action={<ButtonLink href={`/coin/${page.launchId}`}>Reload</ButtonLink>}>The launch could not be read. Try again in a moment.</EmptyState> : null}
    {!marketCatchingUp && (page.curve.state === "stale" || page.coin.state === "stale" || page.venue?.state === "stale") ? <p className={styles.notice} role="status">Market data is delayed. Trading availability follows the latest chain read.</p> : null}
    {page.conflict && !marketCatchingUp ? <p className={styles.notice} role="status">The index is catching up with this launch. Trading follows its current chain state.</p> : null}
  </>;
}

/** The live screen's note while its stream has not been live for a while; the numbers shown stay as they were. */
function Reconnecting({ live }: Readonly<{ live: LiveCoin }>) {
  return live.reconnecting ? <p className={styles.notice} role="status">Reconnecting…</p> : null;
}

/**
 * Re-reads the page once when the stream reports a new lifecycle for the coin (a curve that migrated):
 * the live screen has no refresh timer to find it.
 */
function LifecycleRefresh({ lifecycle }: Readonly<{ lifecycle: string | null }>) {
  const router = useRouter();
  const first = useRef<string | null>(null);
  useEffect(() => {
    if (lifecycle === null) return;
    if (first.current === null) first.current = lifecycle;
    else if (first.current !== lifecycle) {
      first.current = lifecycle;
      router.refresh();
    }
  }, [lifecycle, router]);
  return null;
}

function CoinMarket({ snapshot, page, chart, activity, poolKey, checkpoint, expected }: Readonly<{
  snapshot: View; page: CoinPage; chart: ReactNode; activity: ReactNode; poolKey: string | null; checkpoint: number | null; expected: ExpectedDeployment | null;
}>) {
  const { tick, lastTrade, receivedAt } = useCoinTrade(snapshot.identity.coinType, poolKey, checkpoint);
  const liveOn = useLiveScreen() && expected !== null && page.confirmed;
  const live = useLiveCoin({ coin: snapshot.identity.coinType, pools: poolKey ? [poolKey] : [], expected, enabled: liveOn });
  const stats = statsAfterRead(live.stats, checkpoint);
  useReportListening(live.live);
  const graduated = snapshot.lifecycle === "migrated";
  const view = !graduated && tick ? coinView(page, tick) : snapshot;
  const tradeId = tick?.showCue ? tick.trade.cursor : null;
  // The best known price at once; after the viewer's own trade, only one that includes it.
  const price = useChartPrice(poolKey, null, page.launchId);
  const context = coinTradeSource(view, poolKey, lastTrade, receivedAt);
  // A phone reads the last trade under the chart (CSS shows one of the two), so the candles sit right under the price.
  const recent = context && <ChartLastTrade placement="headline" />;
  return <ChartPriceLaunch value={{ poolKey, launchId: page.launchId }}><ChartTradeContext value={context}>
    <div className={styles.market}>
      <Reconnecting live={live} />
      {liveOn ? <LifecycleRefresh lifecycle={live.stats?.lifecycle ?? null} /> : null}
      <CoinMarketCards graduated={graduated} view={view} tick={tick} tradeId={tradeId} stats={stats} chart={chart} activity={activity}
        price={<MarketPrice units={priceUnits(view)} price={price?.price} tradeId={tradeId && price?.cursor ? tradeId : null}
          showCurrency={view.identity.quoteType !== null} activity={recent} />}
        foot={<><span className={styles.byline}><CreatorByline page={page} />{view.identity.coinType ? <CoinTypeTag coinType={view.identity.coinType} /> : null}</span>{recent}</>} />
    </div>
  </ChartTradeContext></ChartPriceLaunch>;
}

/** The chart comes first at every width, the price row as its head; without a chart the price row stands alone. */
function CoinMarketCards({ graduated, view, tick, tradeId, stats, chart, activity, price, foot }: Readonly<{
  graduated: boolean; view: View; tick: ReturnType<typeof useCoinTrade>["tick"]; tradeId: string | null; stats: LiveCoinStats | null; chart: ReactNode; activity: ReactNode; price: ReactNode; foot: ReactNode;
}>) {
  const phone = usePhoneLayout();
  const phoneProgress = phone && !graduated;
  const facts = view.curve && view.inputs ? <ProgressFacts view={view} tradeId={tradeId} /> : null;
  const overview = graduated ? <GraduatedMarketOverview view={view} tick={tick} tradeId={tradeId} stats={stats} /> : (
    <ProgressCard view={view} tradeId={tradeId}>{phone ? null : facts}</ProgressCard>
  );
  return <>
    {chart ? <ChartCard head={price} foot={foot}>{chart}</ChartCard> : price}
    {overview}
    {phoneProgress && facts ? <div className={`${styles.card} ${styles.progressFacts}`}>{facts}</div> : null}
    {activity}
  </>;
}

function coinTradeSource(view: View, poolKey: string | null, trade: ReturnType<typeof useCoinTrade>["lastTrade"], receivedAt: number | null) {
  if (!poolKey || !view.identity.coinType) return null;
  return {
    poolKey, trade, receivedAt, decimals: view.quoteDecimals, symbol: view.identity.quoteSymbol,
    quoteType: view.identity.quoteType, placement: "headline" as const,
  };
}

function GraduatedMarketOverview({ view, tick, tradeId, stats }: Readonly<{
  view: View; tick: ReturnType<typeof useCoinTrade>["tick"]; tradeId: string | null; stats: LiveCoinStats | null;
}>) {
  return <MarketOverview fdv={stats?.fdvUsd ?? (tick ? tick.trade.fdvUsd : view.pool?.fdvUsd)} holders={stats?.holders ?? view.coin?.stats.holders}
    volume={stats?.volumeUsd ?? view.pool?.stats.day.volumeUsd} venue={view.venue} tradeId={tradeId} />;
}

function coinPageMarket(page: CoinPage, view: View) {
  const graduated = view.lifecycle === "migrated";
  const poolKey = graduated ? venueRoute(page)?.poolKey ?? null : page.source.kind === "curve" ? page.source.poolKey : null;
  const provenance = (graduated ? page.venue : page.curve)?.provenance;
  const marketKey = [page.launchId, poolKey, provenance?.network, provenance?.deployment].join(":");
  const marketCatchingUp = venueMarketCatchingUp(page);
  const marketOffline = marketCatchingUp && coinMarketOffline(page);
  const showMarket = !marketOffline || view.coin !== null || view.pool !== null;
  return { graduated, poolKey, marketKey, marketCatchingUp, marketOffline, showMarket, checkpoint: provenance?.checkpoint ?? null };
}

function CoinTradePlacement({ execution, symbol }: Readonly<{ execution: ReactNode; symbol: string | null }>) {
  const phone = usePhoneLayout();
  const hydrated = useHydrated();
  const [open, setOpen] = useState(false);
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const title = useId();
  // The portal stays mounted when its destination changes or the sheet closes.
  const placeExecution = useCallback((destination: HTMLElement | null) => {
    if (!destination) return;
    const panel = host ?? destination.ownerDocument.createElement("div");
    destination.append(panel);
    if (!host) setHost(panel);
  }, [host]);

  return <>
    {phone ? (
      <>
        <div className={styles.tradeDock}>
          <Button aria-haspopup="dialog" onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            setOpen(true);
          }} size="lg" variant="primary">Trade</Button>
        </div>
        <Sheet open={open} onRequestClose={() => setOpen(false)} labelledBy={title} className={styles.tradeSheet} hasDock>
          <SheetHeading id={title} title={symbol ? `Trade $${symbol}` : "Trade"} />
          <SheetClose onClick={() => setOpen(false)} />
          <div ref={placeExecution} />
        </Sheet>
      </>
    ) : (
      <aside className={styles.aside} id="coin-trade" tabIndex={-1}>
        <section aria-label="Trade" className={styles.card} ref={hydrated ? placeExecution : undefined}>
          {hydrated ? null : execution}
        </section>
      </aside>
    )}
    {host ? createPortal(<CoinTradeVisibility value={!phone || open}>{execution}</CoinTradeVisibility>, host) : null}
  </>;
}

function LegacyMarketDetails({ market, decimals, symbol }: Readonly<{ market?: LegacyCoinMarket; decimals: number; symbol: string }>) {
  const { totalSupplyAtoms, feeRate } = market ?? {};
  const { description, links } = poolCoinMetadata(market?.description);
  const hasAbout = Boolean(description || links.length);
  if (!hasAbout && totalSupplyAtoms === undefined && feeRate === undefined) return null;
  return <div className={styles.details}>
    {hasAbout ? <Card title="About">
      {description ? <p className={styles.tagline}>{description}</p> : null}
      {links.length ? <AboutLinks links={links} /> : null}
    </Card> : null}
    <div className={styles.pair}>
      {totalSupplyAtoms !== undefined ? <Card title="Tokenomics">
        <dl className={styles.facts}><Fact label="Total supply">{formatAmountShort(BigInt(totalSupplyAtoms), decimals)}{"\u00A0"}{symbol}</Fact></dl>
      </Card> : null}
      {feeRate !== undefined ? <Card title="Pool fees">
        <dl className={styles.facts}><Fact label="Pool trading fee">{feeRate / 10_000}%</Fact></dl>
      </Card> : null}
    </div>
  </div>;
}

/** A legacy coin's market read; it rests while the live screen's stream carries the coin's numbers. */
function useLegacyMarket(coinType: string, enabled: boolean, listening: boolean) {
  const { data, isRefetchError } = useQuery({
    ...legacyCoinMarketQuery(),
    enabled,
    refetchInterval: listening ? false : (query) => pollInterval(60_000, query),
  }, useAppQueryClient());
  return { market: data?.legacyMarket?.[coinType], fdvUsd: isRefetchError ? undefined : data?.legacyFdvUsd?.[coinType] };
}

export function LegacyCoinScreen({ coinType, name, symbol, logoUrl, chart, decimals, poolKey, poolKeys = [poolKey], quote = SUI_POOL_QUOTE, trade, legacy = true, major = false, verified = false, verifiedCommunity = false }: Readonly<{
  coinType: string; name: string; symbol: string; logoUrl: string; chart: ReactNode; decimals: number;
  poolKey: VenuePoolKey; poolKeys?: readonly VenuePoolKey[]; quote?: PoolQuote; trade: ReactNode; legacy?: boolean; major?: boolean; verified?: boolean; verifiedCommunity?: boolean;
}>) {
  const origin = useListOrigin(coinType);
  const quoteKey = quote.coinType === SUI_COIN_TYPE ? "sui" : quote.coinType === USDC_COIN_TYPE ? "usdc" : quote.coinType;
  const units = {
    coinType, symbol, iconUrl: logoUrl, memeDecimals: decimals,
    quoteType: quote.coinType, quoteSymbol: quote.symbol, quoteDecimals: quote.decimals,
    quoteMark: <QuoteMark coinType={quote.coinType} coinKey={quoteKey} symbol={quote.symbol} />,
  };
  const price = useChartPrice(poolKey);
  const liveScreen = useLiveScreen();
  // Both pools of the Trades list (at most a stream's two), so neither waits on a poll while the other streams.
  const live = useLiveCoin({ coin: coinType, pools: poolKeys.length <= 2 && poolKeys.includes(poolKey) ? poolKeys : [poolKey], pool: poolKey, expected: null, enabled: liveScreen });
  useReportListening(live.live);
  const { market, fdvUsd: readFdvUsd } = useLegacyMarket(coinType, !major, useLiveListening());
  const fdvUsd = live.stats?.fdvUsd ?? readFdvUsd;
  const mark = <>{verified || verifiedCommunity ? <CoinVerifiedMark community={verifiedCommunity} /> : null}{legacy ? <CoinLegacyMark /> : null}</>;
  return <div className={styles.page} data-legacy-coin="">
    <CoinBackLink origin={origin} tradeJump={trade != null} home={major} />
    <CoinIdentityHeader coin={{ key: coinType, coinType, iconUrl: logoUrl, round: major }} name={name} symbol={symbol} status={major ? "" : "Graduated"} graduated={!major} mark={mark} compact />
    <div className={styles.layout} data-no-trade={trade == null || undefined}>
      <CoinPriceCurrencyProvider quoteType={quote.coinType} quoteSymbol={quote.symbol}>
        <div className={styles.market}>
          <Reconnecting live={live} />
          <ChartCard head={<MarketPrice units={units} price={price?.price} tradeId={price?.cursor} showCurrency={!major} />}
            foot={<span className={styles.byline}><CoinTypeTag coinType={coinType} /></span>}><SectionBoundary subject="chart">{chart}</SectionBoundary></ChartCard>
          <MarketOverview fdv={major ? null : fdvUsd} holders={live.stats?.holders} volume={live.stats?.volumeUsd} venue={major ? null : poolKey.split(":")[0]} />
          <Card title="Trades">
            <SectionBoundary subject="trades" key={poolKeys.join()}>
              <IndexedPoolTrades poolKeys={poolKeys} units={units} />
            </SectionBoundary>
          </Card>
        </div>
      </CoinPriceCurrencyProvider>
      {trade == null ? null : <CoinTradePlacement execution={<SectionBoundary subject="execution">{trade}</SectionBoundary>} symbol={symbol} />}
      <LegacyMarketDetails market={market} decimals={decimals} symbol={symbol} />
    </div>
  </div>;
}

/**
 * A launch's permanent page, preserving chart, execution and migration contracts. `expected`: the
 * deployment the chart streams for (null without a stream), so the live screen joins the same stream.
 */
export function BondingCoinScreen({ page, details, verified = false, slots, expected = null }: Readonly<{
  page: CoinPage; details: LaunchPageDetails | null; verified?: boolean; slots: TerminalSlots; expected?: ExpectedDeployment | null;
}>) {
  const view = coinView(page);
  const { graduated, poolKey, marketKey, marketCatchingUp, marketOffline, showMarket, checkpoint } = coinPageMarket(page, view);
  const liveScreen = useLiveScreen();
  const slot = (name: keyof TerminalSlots) => <SectionBoundary subject={name} key={`${page.launchId}:${name}`}>{slots[name]}</SectionBoundary>;
  const charted = showMarket && !marketOffline && slots.chart != null;
  return <div className={styles.page} data-bonding-coin="">
    <CoinPageHeader page={page} view={view} details={details} verified={verified} marketCatchingUp={marketCatchingUp} compact={charted} />
    <WalletTradesProvider key={page.launchId} deployer={view.coin?.launcher ?? null}>
      <div className={styles.layout} data-graduated={graduated || undefined} data-market-offline={marketOffline || undefined} data-no-market={!showMarket || undefined}>
        {showMarket ? (
          <CoinPriceCurrencyProvider key={page.launchId} quoteType={view.identity.quoteType} quoteSymbol={view.identity.quoteSymbol}>
            <CoinMarket key={marketKey} snapshot={view} page={page} poolKey={poolKey} checkpoint={checkpoint} expected={expected}
              chart={charted ? slot("chart") : null}
              activity={marketOffline ? null : <CoinTradingActivity key={page.launchId} trades={slots.activity} holders={slots.holders} lazyHolders={liveScreen} />}
            />
          </CoinPriceCurrencyProvider>
        ) : null}
        <CoinTradePlacement execution={slot("execution")} symbol={view.identity.symbol} />
        <div className={styles.details}>
          {view.curve ? <details className={styles.card}><DisclosureSummary>Token &amp; fees</DisclosureSummary>
            <div className={styles.pair}><AllocationCard view={view} /><FeesCard view={view} /></div>
            {graduated ? <LaunchHistory view={view} /> : <TermsCard view={view} />}
          </details> : null}
          <AboutCard details={details} view={view} />
          <Disclosure title="Theses">{slot("theses")}</Disclosure>
        </div>
      </div>
    </WalletTradesProvider>
  </div>;
}
