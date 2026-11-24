"use client";
import { Button, IconButton } from "#web/components/blast-ui/Button.tsx";

import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
  type UIEvent,
} from "react";
import { WorkspaceTradeDockContext } from "../workspace-trade-dock-context";
import { createPortal } from "react-dom";
import { DisclosureButton } from "#web/components/blast-ui/Button.tsx";
import { CopyButton } from "#web/components/blast-ui/CopyButton.tsx";
import { DexIdentity } from "#web/components/blast-ui/DexIdentity.tsx";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { coinTypeIdentity, usePanelIdentities, useReportPanelIdentity } from "../panel-identities";
import { FlowCard } from "./FlowCard";
import { normalizeStructTag } from "@mysten/sui/utils";
import { exactAtoms, groupedExact } from "@blast/core/web/exact-amount.ts";
import { compactFigure, readablePrice } from "#web/lib/market-format.ts";
import { ago, NO_VALUE } from "@blast/core/web/format.ts";
import { SOCIAL_FEED_DELAYED_LAG_MS } from "@blast/core/web/contracts/feed.ts";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { useShellPrefs } from "#web/components/blast-ui/use-shell-prefs.ts";
import { KindGlyph, QuoteMark } from "#web/components/social/coin-home/glyphs.tsx";
import type {
  HomeEvent,
  HomeParticipant,
  HomeThreadPage,
} from "@blast/core/web/contracts/home.ts";
import type { TradeKit } from "#web/components/social/trade/trade-kit.ts";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import type {
  CoinAsset,
  CoinReads,
  CoinRecord,
  CoinHistory,
} from "./coin-reads";
import { CoinChart, CoinPriceWindow } from "./CoinChart";
import { workspaceScrollOwner } from "../scroll-owner";
import { ClearFollowingOnlyContext, CoinDetailsSlots, FollowingOnlyContext, PanelAssetContext, PanelHeaderSlotContext, PanelHeadingContext } from "./panel-context";
import { useViewerStateStore } from "#web/components/social/ViewerState.tsx";
import { useWorkspaceLiveClock } from "../live-clock";
import { CoinTrade } from "./CoinTrade";
import { CurveLaunchTrade } from "./CurveLaunchTrade";
import { CoinProjectLinks } from "./ProjectLinks";
import { compactUsdText, volumeText } from "#web/components/social/coin-home/home-model.ts";
import type { ActionPreference } from "../ActionConfirmation";
import { coinPollMs, useCoinRead } from "./use-coin-read";
import { useMarketStream, type StreamedPrice } from "./use-market-stream";
import { useCoinSummaryFacts, type CoinSummaryFacts, type CoinSummaryRead } from "./coin-summary";
import { terminalUsd } from "./coin-facts";
import { PanelIdentity, PanelTabs, TradingStage, type PanelTab } from "./PanelChrome";
import { ChangePill, Figure } from "./Figures";
import { ActorCell } from "../ActorCell";
import { CoinParticipants } from "../CoinParticipants";
import { actorIdentity } from "../actor-identity";
import styles from "./CoinPanel.module.css";
import { NoRows, PanelEmptyState } from "./PanelEmptyState";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { SUI_COIN_TYPE } from "@blast/core/lib/sui/coin-types.ts";
import focusStyles from "./FocusPanel.module.css";
import { WorkspaceContext } from "../workspace-context";
import { CoinFocusWorkspace } from "./CoinFocusContext";
import { CurveTrades, useCurveListLaunch, useCurveQuotePrice, type CurveQuotePrice } from "./CurveLaunchLists";
import type { CoinPnlReader } from "./coin-pnl";

export type CoinPanelProps = Readonly<{
  focus?: boolean;
  panel_id: string;
  asset: CoinAsset;
  coin_setup: PanelSetup["coin"];
  onSetupChange: (setup: PanelSetup["coin"]) => void;
  effective_visibility: boolean;
  actions: Readonly<{
    trade: TradeKit | null;
    pnl?: CoinPnlReader;
    authenticated: boolean;
    actor_key: string;
    confirmation?: ActionPreference;
    signIn: () => void;
  }>;
  reads: CoinReads;
  onPresaleAvailable?: (presaleId: string) => void;
  /**
   * When the coin read finds no record (a miss is not proof the coin is gone:
   * an unindexed holding or a lagging sale reads the same), the person may
   * swap this panel to SUI or remove it. Nothing changes the setup by itself.
   */
  onShowSui?: () => void;
  onRemove?: () => void;
}>;

/** The views Blast mode's coin card shows; the saved setup may still name Holders or Posts. */
type ShownTab = "overview" | "activity";

const TABS: readonly PanelTab<ShownTab>[] = [
  ["overview", "Chart", "overview"],
  ["activity", "Trades", "activity"],
];

export function CoinPanel({
  focus: focusOverride,
  panel_id,
  asset: input,
  coin_setup: setup,
  onSetupChange,
  effective_visibility: visible,
  actions,
  reads,
  onPresaleAvailable,
  onShowSui,
  onRemove,
}: CoinPanelProps) {
  const workspace = useContext(WorkspaceContext);
  const focus = focusOverride ?? workspace?.snapshot.presentation === "focus";
  const prefix = useId();
  const dock = useContext(WorkspaceTradeDockContext);

  const [chartSlot,setChartSlot]=useState<HTMLDivElement|null>(null);
  const headerSlot = useContext(PanelHeaderSlotContext);
  const { shownTabs, tab } = coinPanelTabs(setup.tabs);
  const { key, coinRead, coin, asset, tradable, history, activity, navigation, presentationTab, streamedPrice } =
    useCoinPanelReads({ input, visible, focus, reads, setup, tab, onSetupChange, onPresaleAvailable });
  const [tradeOpen, setTradeOpen] = useState(false);
  const curveRead = useCurveListLaunch(asset, coin, visible);
  const curveLaunch = curveRead ?? null;
  const layout = coinPanelLayout(focus);
  const chart = (<section className={layout.chart} aria-label={layout.chartLabel}>
        {focus && headerSlot && <div className={focusStyles.chartHead} data-panel-header-slot="" ref={headerSlot} />}
        <div
          className={styles.body}
          data-scroll-fade=""
          id={`${prefix}-content`}
          role={layout.role}
          data-view={presentationTab}
          tabIndex={0}
          aria-labelledby={focus ? undefined : `${prefix}-${tab}`}
          {...navigation}
        >
          <CoinContent
            tab={focus ? "overview" : tab}
            curveLaunch={curveLaunch}
            visible={visible}
            coinRead={coinRead}
            coin={coin}
            history={history}
            activity={activity}
            asset={asset}
            reads={reads}
            setup={setup}
            onSetupChange={onSetupChange}
            chartTools={
              <div className={styles.chartTools}>
                <CoinPriceWindow
                  chart={setup.chart}
                  history={history.value}
                  sinceLaunch={asset.presale_id !== null}
                  onChart={(chart) => onSetupChange({ ...setup, chart })}
                />
                <div className={styles.chartDetailsSlot} ref={setChartSlot} />
              </div>
            }
          />
        </div>
        </section>);
  const trade = (<section className={layout.trade} aria-label={layout.tradeLabel} data-trade-open={tradeOpen} data-coin-trade-stack={focus || undefined}>
          <FocusTradeHeader enabled={focus} symbol={coin?.symbol ?? coinTypeIdentity(asset.coin_type).symbol} open={tradeOpen} controls={`${prefix}-trade`} onToggle={() => setTradeOpen(!tradeOpen)} />
          <div id={`${prefix}-trade`} tabIndex={-1}>
        <CurveLaunchTrade key={key} asset={asset} coin={coin} visible={visible}>
        <CoinTrade
          unavailable={!tradable}
          identityStatus={coinRead.status}
          retryIdentity={coinRead.retry}
          compact={!!dock}
          key={`${key}:${actions.actor_key}`}
          asset={asset}
          coin_setup={setup}
          onSetupChange={onSetupChange}
          effective_visibility={visible && tradable}
          actions={actions}
          coin={coin}
        />
        </CurveLaunchTrade>
          </div>
          {focus && <FlowCard asset={asset} coin={coin} visible={visible} />}
        </section>);
  return (
    <CoinDetailsSlots.Provider value={{chart:chartSlot,overlays:null,reset:null,visible}}>
    <div className={styles.panel} data-focus={focus} data-coin-panel={panel_id} data-dock={!!dock}>
      {focus ? <CoinBoardHeader coin={coin} asset={asset} read={coinRead} curveLaunch={curveRead} visible={visible} streamed={streamedPrice} socials={<CoinProjectLinks asset={asset} reads={reads} visible={visible} />} /> : <CoinHeader
        coin={coin}
        asset={asset}
        socials={<CoinProjectLinks asset={asset} reads={reads} visible={visible} />}
        tabs={
          <PanelTabs
            tabs={shownTabs}
            selected={tab}
            onSelect={(selected) =>
              onSetupChange({ ...setup, tabs: { ...setup.tabs, selected } })
            }
            prefix={prefix}
            label="Coin views"
          />
        }
      />}
      <CoinPanelFacts checkedAt={coinRead.checkedAt} focus={focus} coin={coin} pending={coinRead.status === "pending"} />
      <CoinPanelMissing status={coinRead.status} coin={coin} asset={asset} onShowSui={onShowSui} onRemove={onRemove} />
      {focus ? <CoinFocusWorkspace coinPending={coinRead.status === "pending"} chart={chart} trade={trade} coin_setup={setup} onSetupChange={onSetupChange} asset={asset} coin={coin} actions={actions} reads={reads} visible={visible} activity={<CoinContent tab="activity" curveLaunch={curveLaunch} visible={visible} coinRead={coinRead} coin={coin} history={history} activity={activity} asset={asset} setup={setup} onSetupChange={onSetupChange} chartTools={null} />} /> : <div className={styles.presentation}>{chart}{trade}</div>}
    </div>
    </CoinDetailsSlots.Provider>
  );
}

function coinPanelTabs(tabs: PanelSetup["coin"]["tabs"]) {
  const enabled = new Set(tabs.enabled);
  const shownTabs = TABS.filter(([tab]) => tab === "overview" || enabled.has(tab));
  // A saved selection outside the available views opens Chart until the user chooses a view.
  const tab = shownTabs.find(([value]) => value === tabs.selected)?.[0] ?? "overview";
  return { shownTabs, tab };
}

function useCoinPanelReads({
  input, visible, focus, reads, setup, tab, onSetupChange, onPresaleAvailable,
}: Readonly<{
  input: CoinAsset;
  visible: boolean;
  focus: boolean;
  reads: CoinReads;
  setup: CoinPanelProps["coin_setup"];
  tab: ShownTab;
  onSetupChange: CoinPanelProps["onSetupChange"];
  onPresaleAvailable: CoinPanelProps["onPresaleAvailable"];
}>) {
  // While the focused coin's stream is live, its snapshot reads poll at 30 s instead of 15 s.
  const [live, setLive] = useState(false);
  const pollMs = coinPollMs(live);
  const identity = useCoinIdentity(input, visible, reads, onPresaleAvailable, pollMs);
  const { asset, key, coinRead } = identity;
  const views = useCoinViews({ visible, focus, tab, key, reads, asset, setup, onSetupChange, coinPending: coinRead.status === "pending", pollMs });
  const { history } = views;
  const snapshot = history.value;
  const streamed = snapshot && "kind" in snapshot && (snapshot.kind === "market" || snapshot.kind === "trades") ? snapshot : null;
  // An empty read keeps the stream open. Native coins and price-point charts end it.
  const stream = useMarketStream(asset.coin_type, streamed, focus && visible && (streamed !== null || snapshot === null), history.refresh);
  if (stream.live !== live) {
    setLive(stream.live);
  }
  const displayHistory = streamed && stream.history !== streamed ? { ...history, value: stream.history } : history;
  return { ...identity, ...views, history: displayHistory, streamedPrice: stream.price };
}

function CoinPanelMissing({ status, coin, asset, onShowSui, onRemove }: Readonly<{
  status: ReadResult<CoinRecord | null>["status"];
  coin: CoinRecord | null;
  asset: CoinAsset;
  onShowSui: CoinPanelProps["onShowSui"];
  onRemove: CoinPanelProps["onRemove"];
}>) {
  if (status !== "ready" || coin || asset.network !== "mainnet") {
    return null;
  }
  return <CoinMissing showSui={asset.coin_type === SUI_COIN_TYPE ? undefined : onShowSui} remove={onRemove} />;
}

/** Compact cards keep their summary below the identity; focus uses the market strip. */
function CoinPanelFacts({ checkedAt, focus, coin, pending }: Readonly<{ checkedAt: number | null; focus: boolean; coin: CoinRecord | null; pending: boolean }>) {
  return focus ? null : <CoinHero checkedAt={checkedAt} coin={coin} pending={pending} />;
}

function useCoinViews({ visible, focus, tab, key, reads, asset, setup, onSetupChange, coinPending, pollMs }: Readonly<{
  visible: boolean; focus: boolean; tab: ShownTab; key: string; reads: CoinReads; asset: CoinAsset;
  setup: PanelSetup["coin"]; onSetupChange: CoinPanelProps["onSetupChange"]; coinPending: boolean; pollMs: number;
}>) {
  const window =
    setup.chart.renderer === "recharts" ? setup.chart.window : "24h";
  const interval = setup.chart.renderer === "recharts" ? setup.chart.interval : undefined;
  const presentationTab = focus ? "overview" : tab;
  const loadChart = useCallback(
    (signal: AbortSignal) => reads.chart(asset, window, signal, interval),
    [asset, reads, window, interval],
  );
  const history = useCoinRead(
    visible && presentationTab === "overview",
    `${key}:${window}:${interval ?? "auto"}`,
    loadChart,
    undefined,
    pollMs,
  );
  const loadActivity = useCallback(
    (signal: AbortSignal) => reads.activity(asset, signal),
    [asset, reads],
  );
  const activity = useCoinRead(
    visible,
    key,
    loadActivity,
  );
  const selectedRead = presentationTab === "activity" ? activity : history;
  const navigation = useCoinNavigation({
    visible,
    tab: presentationTab,
    anchor: setup.navigation.scroll_top,
    ready: selectedRead.status === "ready" && !coinPending,
    content: selectedRead.value,
    save: (scroll_top) =>
      onSetupChange({
        ...setup,
        navigation: { ...setup.navigation, scroll_top },
      }),
  });
  return { history, activity, navigation, presentationTab };
}

function coinPanelLayout(focus: boolean) {
  return focus
    ? { chart: focusStyles.chart, trade: focusStyles.trade, chartLabel: "Price chart", tradeLabel: "Buy or sell selected asset", role: undefined }
    : { chart: styles.chartRegion, trade: styles.tradeRegion, chartLabel: undefined, tradeLabel: undefined, role: "tabpanel" };
}

function FocusTradeHeader({ enabled, symbol, open, controls, onToggle }: Readonly<{ enabled: boolean; symbol: string; open: boolean; controls: string; onToggle: () => void }>) {
  if (!enabled) return null;
  return <Button variant="ghost" size="sm" data-workspace-escape={open ? "trade" : undefined} className={focusStyles.tradeToggle} type="button" aria-expanded={open} aria-controls={controls} onClick={event => { onToggle(); event.currentTarget.focus({preventScroll: true}); }}>{open ? "Close trade" : `Buy / Sell ${symbol}`}</Button>;
}

function Pending({ name }: Readonly<{ name: string }>) {
  return (
    <div aria-label={`Loading ${name}`} role="status">
      <SkeletonText>Coin {name} and market information</SkeletonText>
    </div>
  );
}

function ReadProblem({
  name,
  retry,
}: Readonly<{ name: string; retry: () => void }>) {
  return (
    <EmptyState
      role="alert"
      className={styles.problem}
      title={`${name} could not load`}
      action={<Button variant="secondary" size="sm" aria-label={`Retry ${name.toLowerCase()}`} type="button" onClick={retry}>Retry</Button>}
    >
      Your setup is kept.
    </EmptyState>
  );
}

/** A mainnet coin no source has a record of: the person chooses SUI or removal; the setup stays until then. */
function CoinMissing({ showSui, remove }: Readonly<{ showSui?: () => void; remove?: () => void }>) {
  const actions = (showSui || remove) && (
    <>
      {showSui && <Button variant="secondary" size="sm" type="button" onClick={showSui}>Show SUI</Button>}
      {remove && <Button variant="ghost" size="sm" type="button" onClick={remove}>Remove</Button>}
    </>
  );
  return (
    <EmptyState role="status" className={styles.problem} title="No source has a record of this coin right now" action={actions || undefined} />
  );
}

const noSubscribe = () => () => {};
const noVersion = () => 0;

function Activity({ page, coin }: Readonly<{ page: HomeThreadPage | null; coin: CoinRecord | null }>) {
  const noteId = useId();
  const [limit,setLimit]=useState(12);
  const followingOnly = useContext(FollowingOnlyContext);
  const clearFollowingOnly = useContext(ClearFollowingOnlyContext);
  const store = useViewerStateStore();
  useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.version ?? noVersion, noVersion);
  const callsigns = followingOnly ? (page?.participants ?? []).flatMap(row => row.actor.type === "account" ? [row.actor.callsign] : []).join(",") : "";
  useEffect(() => { if (store && callsigns) store.want({ callsigns: callsigns.split(",") }); }, [store, callsigns]);
  if (!page)
    return <NoRows><PanelEmptyState title="Trades unavailable for this coin" /></NoRows>;
  const followed = (participant: HomeParticipant) => !followingOnly || (participant.actor.type === "account" && store?.following({ kind: "account", callsign: participant.actor.callsign }) === true);
  const events = page.participants.filter(followed).flatMap((participant) =>
    (participant.events ?? []).filter(event => event.kind === "trade_buy" || event.kind === "trade_sell").map((event) => ({ participant, event })),
  ).sort((a, b) => b.event.occurred_at_ms - a.event.occurred_at_ms);
  const freshness = activityFreshness(page.as_of);
  return (
    <>
      <ListNote id={noteId}>
        {[
          freshness.note,
          "Trades on every venue.",
          page.next_cursor ? "Showing the newest returned events; older activity is not loaded." : null,
        ].filter(Boolean).join(" ")}
      </ListNote>
      {freshness.warning && <p role="status" className={styles.warning}>{freshness.warning}</p>}
      {events.length === 0 ? (
        followingOnly && clearFollowingOnly && page.participants.some(participant => participant.events?.some(event => event.kind === "trade_buy" || event.kind === "trade_sell"))
          ? <EmptyState compact role="status" title="No trades by people you follow in this period" action={<Button variant="ghost" size="sm" type="button" onClick={clearFollowingOnly}>Show all trades</Button>} />
          : <PanelEmptyState title={followingOnly ? "No trades by people you follow in this period" : "No recorded trades in this period"} />
      ) : (
        <div><div className={styles.tradeTableHead} aria-hidden="true"><span>Trader</span><span>Side</span><span>Value</span><span>Age</span></div><ol className={styles.rows} aria-label="Recent trades, last 24 hours" aria-describedby={noteId}>
          {events.slice(0,limit).map(({ participant, event }) => (
            <TradeRow key={event.activity_id} participant={participant} event={event} coin={coin} nowMs={page.clock_ms} />
          ))}
        </ol></div>
      )}
      {events.length > limit && <Button variant="ghost" size="sm" className={styles.pill} type="button" onClick={()=>setLimit(limit+5)}>More activity</Button>}
    </>
  );
}

/** One line per trade: who, which side (in words, colour repeats it), what it was worth, and when. The coin quantity is in the amount's inspector. */
function TradeRow({
  participant,
  event,
  coin,
  nowMs,
}: Readonly<{ participant: HomeParticipant; event: HomeEvent; coin: CoinRecord | null; nowMs: number }>) {
  const hidden = useShellPrefs().amountsHidden;
  const buy = event.kind === "trade_buy";
  const tokens = coin ? exactAtoms(event.tokens, coin.decimals ?? -1) : null;
  const quantity = tokens && coin ? `${groupedExact(tokens, tokens.scale)} ${coin.symbol}` : null;
  const at = new Date(event.occurred_at_ms).toISOString();
  return (
    <li>
      <ActorCell identity={actorIdentity(participant.actor)} size={24} compact />
      <span className={styles.side} data-direction={buy ? "up" : "down"}>
        <KindGlyph kind={event.kind} size={12} />
        {buy ? "Buy" : "Sell"}
      </span>
      <span className={styles.figure}>
        {event.quote === null ? "—" : hidden ? "••••" : <TradeAmount quote={event.quote} quantity={quantity} />}
      </span>
      <time className={styles.when} dateTime={at}>
        <InspectValue value={at} label="activity time">{ago(event.occurred_at_ms, nowMs)}</InspectValue>
      </time>
    </li>
  );
}

/** The trade's worth: the indexer's USD when it priced the row, else the quote coin's amount with its mark; exact amounts in the inspector. */
function TradeAmount({ quote, quantity }: Readonly<{ quote: NonNullable<HomeEvent["quote"]>; quantity: string | null }>) {
  const symbol = quote.quote_symbol ?? "quote";
  const parsed = quote.quote_decimals == null ? null : exactAtoms(quote.atoms, quote.quote_decimals);
  const amount = parsed ? `${groupedExact(parsed, parsed.scale)} ${symbol}` : `${quote.atoms} ${symbol} atoms`;
  const figure = compactFigure(quote.atoms, quote.quote_decimals);
  return (
    <InspectValue
      value={`${amount}${quote.usd == null ? " · USD unavailable" : ` · $${quote.usd}`}${quantity ? ` · ${quantity}` : ""}`}
      label="activity amount"
    >
      {quote.usd != null ? (
        terminalUsd(quote.usd)
      ) : (
        <>
          <QuoteMark symbol={symbol} />
          {figure === null ? `${quote.atoms} atoms` : `${figure} ${symbol}`}
        </>
      )}
    </InspectValue>
  );
}

/**
 * How current the trades are. Only a delay or an unknown freshness is shown
 * in the panel; the current state and the exact indexed time are part of the
 * list's description.
 */
function activityFreshness(
  asOf: HomeThreadPage["as_of"] | null | undefined,
): Readonly<{ warning: string | null; note: string }> {
  const at =
    asOf && Number.isFinite(asOf.timestamp_ms)
      ? new Date(asOf.timestamp_ms)
      : null;
  if (
    !asOf ||
    !at ||
    Number.isNaN(at.getTime()) ||
    !Number.isFinite(asOf.lag_ms) ||
    asOf.lag_ms < 0
  )
    return { warning: "Activity freshness unavailable.", note: "Activity freshness unavailable." };
  const indexed = `Indexed ${at.toISOString()}.`;
  if (asOf.lag_ms > SOCIAL_FEED_DELAYED_LAG_MS) {
    const warning = `Activity is delayed. Indexing is ${Math.round(asOf.lag_ms / 60_000)} min behind; recent trades may be missing.`;
    return { warning, note: `${warning} ${indexed}` };
  }
  return { warning: null, note: `Activity is current within 1 min. ${indexed}` };
}

/** A list's supporting facts for assistive technology only: coverage and freshness, read as the list's description. */
function ListNote({ id, children }: Readonly<{ id: string; children: string }>) {
  return (
    <p className="sr" id={id} data-list-note="">
      {children}
    </p>
  );
}

function CoinHeader({
  coin,
  asset,
  tabs,
  metrics,
  socials,
}: Readonly<{
  coin: CoinRecord | null;
  asset: CoinAsset;
  tabs: ReactNode;
  metrics?: ReactNode;
  socials?: ReactNode;
}>) {
  const sale = asset.presale_id && coin?.lifecycle !== "migrated";
  return (
    <PanelIdentity
      stable
      coinType={asset.coin_type}
      network={asset.network}
      symbol={coin?.symbol}
      name={coin?.name}
      icon={coin?.icon_url}
      verified={coin?.verified_team === true}
      stage={sale ? (coin?.lifecycle ? "Sale" : "Checking") : <TradingStage venue={coin?.venue || null} />}
      tabs={tabs}
      metrics={metrics}
      socials={socials}
    />
  );
}

/**
 * The focus board's chart-card header (BlastMode.dc.html): the coin chip (mark,
 * symbol and name opening Discover, venue, coin type and copy), the price with
 * today's move, and the market stats. It takes the panel header's identity slot,
 * so full screen and the panel's options sit at the row's end.
 */
function CoinBoardHeader({ coin, asset, read, curveLaunch, visible, streamed, socials }: Readonly<{ coin: CoinRecord | null; asset: CoinAsset; read: ReadResult<CoinRecord | null>; curveLaunch: string | null | undefined; visible: boolean; streamed: StreamedPrice | null; socials?: ReactNode }>) {
  const target = useContext(PanelHeadingContext);
  useReportPanelIdentity(asset.coin_type, coin?.symbol, coin?.icon_url, coin?.name, asset.network);
  const summary = useCoinSummaryFacts(asset, coin, visible);
  const refresh = () => {
    read.retry();
    summary.refresh();
  };
  const row = (
    <div className={focusStyles.boardHead} data-board-head="">
      <CoinBoardIdentity coin={coin} asset={asset} socials={socials} />
      <CoinBoardPrice coin={coin} read={read} curveLaunch={curveLaunch} visible={visible} streamed={streamed} />
      <span className={focusStyles.headSpacer} />
      <CoinMarketFacts checkedAt={read.checkedAt} coin={coin} summary={summary} loading={read.status === "pending" && !coin} refresh={refresh} />
    </div>
  );
  return target ? createPortal(row, target) : row;
}

/**
 * The headline price as the board's display figure, with today's move as a line under it. Both
 * keep their slots in every state (audit 12): skeletons while loading, a dash and a note when
 * the coin has no USD price, and a reserved move line. A coin still on its curve with no USD price
 * (its quote, such as Test SUI, is unlisted) shows the curve's price in that quote instead of the
 * dash. The reads poll on their own, so the price has no refresh control. A trade the market
 * stream carried after the coin read's observation shows its USD price instead, worked out here;
 * when the stream stops it stays, marked "Updates paused", until a newer read replaces it.
 */
function CoinBoardPrice({ coin, read, curveLaunch, visible, streamed }: Readonly<{ coin: CoinRecord | null; read: ReadResult<CoinRecord | null>; curveLaunch: string | null | undefined; visible: boolean; streamed: StreamedPrice | null }>) {
  const hidden = useShellPrefs().amountsHidden;
  const clock = useWorkspaceLiveClock();
  const newer = newerPrice(coin, streamed);
  const { loading, missing, stale, failed } = coinBoardPriceStatus(coin, read.status, newer, clock.now());
  const quote = useCurveQuotePrice(curveLaunch, missing && visible);
  const quoteStale = quote != null && clock.now() - quote.checkedAt > 120_000;
  const figure = newer
    ? <StreamedFigure price={newer} checkedAt={read.checkedAt} hidden={hidden} />
    : <ReadFigure coin={coin} checkedAt={read.checkedAt} loading={loading} missing={missing} failed={failed} quote={quote} hidden={hidden} />;
  return <div aria-label="Market price" role="group" className={focusStyles.boardPrice}>
    <span className={focusStyles.boardPriceFigure}>
      {figure}
      {(stale || quoteStale) && <span className={styles.stale} title="Over 2 minutes old">Stale</span>}
    </span>
    <PriceToday bps={loading || coin?.price_usd == null ? null : coin.change_24h_bps} loading={loading} />
  </div>;
}

function coinBoardPriceStatus(
  coin: CoinRecord | null,
  status: ReadResult<CoinRecord | null>["status"],
  newer: StreamedPrice | null,
  now: number,
) {
  const loading = status === "pending" && !coin && !newer;
  const missing = !loading && coin?.price_usd == null && !newer;
  const stale = !newer && !missing && coin?.price_as_of_ms != null && now - coin.price_as_of_ms > 120_000;
  const failed = missing && status === "error";
  return { loading, missing, stale, failed };
}

/** The stream's trade when it is newer than the coin read's observation (or the read has no price); a tie goes to the read. */
function newerPrice(coin: CoinRecord | null, streamed: StreamedPrice | null): StreamedPrice | null {
  if (streamed === null) return null;
  return coin?.price_usd == null || coin.price_as_of_ms == null || streamed.observedAt > coin.price_as_of_ms ? streamed : null;
}

function StreamedFigure({ price, checkedAt, hidden }: Readonly<{ price: StreamedPrice; checkedAt: number | null; hidden: boolean }>) {
  return <>
    <ObservedPrice checkedAt={checkedAt} observedAt={price.observedAt} price={price.usd} loading={false} hidden={hidden} />
    {price.paused && <span className={styles.priceNote}>· Updates paused</span>}
  </>;
}

/** The coin read's price; without one, the curve's price in its quote, or a dash. */
function ReadFigure({ coin, checkedAt, loading, missing, failed, quote, hidden }: Readonly<{ coin: CoinRecord | null; checkedAt: number | null; loading: boolean; missing: boolean; failed: boolean; quote: CurveQuotePrice | null | undefined; hidden: boolean }>) {
  if (!missing) return <ObservedPrice checkedAt={checkedAt} observedAt={coin?.price_as_of_ms} price={coin?.price_usd} loading={loading} hidden={hidden} />;
  if (quote === undefined) return <ObservedPrice checkedAt={null} price={undefined} loading hidden={hidden} />;
  return quote === null ? <MissingPrice failed={failed} /> : <QuotePrice quote={quote} hidden={hidden} />;
}

function MissingPrice({ failed }: Readonly<{ failed: boolean }>) {
  return <span className={focusStyles.priceMissing} role={failed ? "alert" : undefined}><span aria-hidden="true">{NO_VALUE}</span><span className={styles.priceNote}>{failed ? "USD price could not load" : "No USD price yet"}</span></span>;
}

/** The curve's price for one coin in its quote coin, exact in the inspector, with the quote's symbol as its unit. */
function QuotePrice({ quote, hidden }: Readonly<{ quote: CurveQuotePrice; hidden: boolean }>) {
  const unit = <span className={styles.priceNote}>{quote.symbol}</span>;
  if (hidden) return <span><Figure className={styles.priceFigure} text="••••" />{unit}</span>;
  return (
    <InspectValue value={`${quote.price} ${quote.symbol}`} label={`Bonding curve price in ${quote.symbol} (no USD price) · ${checkedTime(quote.checkedAt)}`}>
      <Figure className={styles.priceFigure} text={readablePrice(quote.price)} />
      {unit}
    </InspectValue>
  );
}

/** Today's move under the price; without one the line stays, blank, so the header keeps its height. */
function PriceToday({ bps, loading }: Readonly<{ bps: number | null | undefined; loading: boolean }>) {
  if (bps == null) return <span className={focusStyles.today} aria-hidden="true">{loading ? <SkeletonText>+0.00% today</SkeletonText> : "\u00a0"}</span>;
  const direction = bps > 0 ? "up" : bps < 0 ? "down" : "flat";
  return <span className={focusStyles.today} data-direction={direction}><span className="sr">24h change </span>{`${bps > 0 ? "+" : bps < 0 ? "−" : ""}${(Math.abs(bps) / 100).toFixed(2)}%`} today</span>;
}

/**
 * The headline under the identity, on one line: the observed price (exact in
 * the inspector, marked Stale past two minutes), the 24 h move, and FDV as one
 * quiet item. Holders live in their own tab.
 */
function CoinHero({ checkedAt, coin, pending }: Readonly<{ checkedAt: number | null; coin: CoinRecord | null; pending: boolean }>) {
  const clock = useWorkspaceLiveClock();
  const hidden = useShellPrefs().amountsHidden;
  const loading = pending && !coin;
  const stale = coin?.price_as_of_ms != null && clock.now() - coin.price_as_of_ms > 120_000;
  return (
    <div className={styles.hero}>
      <div className={styles.price}>
        <ObservedPrice checkedAt={checkedAt} observedAt={coin?.price_as_of_ms} price={coin?.price_usd} loading={loading} hidden={hidden} />
        {stale && (
          <span className={styles.stale} title="Over 2 minutes old">
            Stale
          </span>
        )}
        {loading || coin?.change_24h_bps == null ? null : (
          <ChangePill bps={coin.change_24h_bps} window="24h" />
        )}
      </div>
      {(loading || coin?.fdv_usd != null) && <span className={styles.fdv}>
        FDV{" "}
        <ObservedFdv value={coin?.fdv_usd} loading={loading} hidden={hidden} />
      </span>}
      {coin?.activity ? <CoinParticipants symbol={coin.symbol} activity={coin.activity} sale={false} className={styles.heroFaces} /> : null}
    </div>
  );
}


/**
 * Market stats as the board's quiet label-over-value row, in its order: the
 * 24 h volume across venues, the coin's size and the holder count. Each keeps its slot in every state (audit 12): a skeleton
 * while loading, a dash when unknown; when the price is missing, its move keeps a tile of its own. The holder count's freshness
 * is part of its refresh control's name. A standalone launch can use its coin summary for missing figures.
 */
function CoinMarketFacts({ checkedAt, coin, summary, loading, refresh }: Readonly<{ checkedAt: number | null; coin: CoinRecord | null; summary: SummaryFacts; loading: boolean; refresh: () => void }>) {
  const clock = useWorkspaceLiveClock();
  const hidden = useShellPrefs().amountsHidden;
  const waiting = loading || summary.loading;
  const changed = coin?.holders_as_of_ms == null ? null : ago(coin.holders_as_of_ms, clock.now());
  const refreshLabel = changed === null ? "Refresh holder count" : `Refresh holder count, changed ${changed === "now" ? "just now" : `${changed} ago`}`;
  return <dl aria-label="Selected market facts" className={focusStyles.marketFacts}>
    {!loading && coin?.price_usd == null && coin?.change_24h_bps != null && <MarketFact label="24h change" loading={false} hidden={false}><ChangePill bps={coin.change_24h_bps} /></MarketFact>}
    <VolumeFact coin={coin} facts={summary.facts} waiting={waiting} hidden={hidden} />
    <SizeFact coin={coin} summary={summary} waiting={waiting} hidden={hidden} />
    <MarketFact label="Holders" loading={false} hidden={false} action={<HolderRefresh label={refreshLabel} onRefresh={refresh} />}>
      <HolderCount checkedAt={checkedAt} coin={coin} facts={summary.facts} waiting={waiting} hidden={hidden} />
    </MarketFact>
  </dl>;
}

type SummaryFacts = Pick<CoinSummaryRead, "loading" | "facts">;
type FactProps = Readonly<{ coin: CoinRecord | null; waiting: boolean; hidden: boolean }>;

/**
 * The summary's 24 h volume when it has one, else the feed's from a loaded Discover list. Only coins that read
 * the summary (no presale, feed FDV or holders missing) get its steady figure; the rest keep the feed's, which
 * drops to a dash while no loaded Discover list carries the coin.
 */
function VolumeFact({ coin, facts, waiting, hidden }: FactProps & Readonly<{ facts: CoinSummaryFacts | null }>) {
  const summaryVolume = facts?.volume24hUsd ?? null;
  const volume = summaryVolume === null ? poolVolumeText(coin) : compactUsdText(summaryVolume);
  return <MarketFact label="24h volume" loading={volume === null && waiting} hidden={hidden && volume !== null}>
    {volume === null ? <MissingFigure /> : <>{volume}{volume.endsWith("+") && <span className="sr"> partial total</span>}</>}
  </MarketFact>;
}

/** Prefer the feed's FDV when both reads have it. */
function SizeFact({ coin, summary, waiting, hidden }: FactProps & Readonly<{ summary: SummaryFacts }>) {
  const feedFdv = coin?.fdv_usd ?? null;
  const value = feedFdv ?? summary.facts?.fdvUsd ?? null;
  const label = feedFdv === null ? `FDV · ${checkedTime(summary.facts?.checkedAt ?? null)}` : "FDV";
  return <MarketFact label="FDV" loading={value === null && waiting} hidden={hidden && value !== null}>
    {value !== null ? <ObservedFdv value={value} label={label} loading={false} hidden={false} /> : <MissingFigure />}
  </MarketFact>;
}

/** The feed's holder count, else the summary's; its skeleton and hiding stay inside the value so the refresh beside it keeps focus. */
function HolderCount({ checkedAt, coin, facts, waiting, hidden }: FactProps & Readonly<{ checkedAt: number | null; facts: CoinSummaryFacts | null }>) {
  const holders = coin?.holders ?? facts?.holders ?? null;
  if (holders === null) return waiting ? <SkeletonText>000.00</SkeletonText> : <MissingFigure />;
  if (hidden) return "••••";
  const observed = coin?.holders != null ? (coin.holders_read_ms ?? checkedAt) : (facts?.checkedAt ?? null);
  const change = coin?.holders_as_of_ms == null ? "" : ` Last count change: ${new Date(coin.holders_as_of_ms).toISOString()}`;
  return <InspectValue label={`holder count observation · ${checkedTime(observed)}`} value={`${holders.toLocaleString("en-US")} holders.${change}`}>{compactFigure(String(holders), 0)}</InspectValue>;
}

function HolderRefresh({ label, onRefresh }: Readonly<{ label: string; onRefresh: () => void }>) {
  return <IconButton variant="ghost" size="xs" className={focusStyles.factRefreshButton} onClick={onRefresh} aria-label={label} title={label}>
    <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.9" viewBox="0 0 24 24"><path d="M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4" /></svg>
  </IconButton>;
}

function poolVolumeText(coin: CoinRecord | null) {
  if (!coin?.activity || coin.activity.scope !== "pool" || coin.activity.window !== "24h") return null;
  return volumeText({ ...coin.activity, committed: [] });
}

/** An unknown market figure keeps its slot as a dash, so the header never changes shape when data resolves. */
function MissingFigure() {
  return <span className={focusStyles.missingFigure}><span aria-hidden="true">{NO_VALUE}</span><span className="sr">unavailable</span></span>;
}

/**
 * One stat. `action` (the holder count's refresh) sits beside the value, not in it: the value
 * becomes a skeleton while a refresh reads, and the control a keyboard user pressed must stay the
 * same node so it keeps focus (#488), in every state: the refresh is not an amount, so hidden
 * amounts keep it too.
 */
function MarketFact({ label, loading, hidden, action, children }: Readonly<{ label: string; loading: boolean; hidden: boolean; action?: ReactNode; children: ReactNode }>) {
  return <div><dt>{label}</dt><dd>{loading ? <SkeletonText>000.00</SkeletonText> : hidden ? "••••" : children}{action}</dd></div>;
}

function ObservedPrice({ checkedAt, observedAt, price, loading, hidden, failed = false }: Readonly<{ checkedAt: number | null; observedAt?: number | null; price: CoinRecord["price_usd"] | undefined; loading: boolean; hidden: boolean; failed?: boolean }>) {
  if (loading) return <span className={styles.pricePending}><SkeletonText>0.000000</SkeletonText></span>;
  if (price == null) return failed ? <span className={styles.priceUnavailable} role="alert">USD price could not load</span> : null;
  if (hidden) return <Figure className={styles.priceFigure} text="••••" />;
  return (
    <InspectValue value={price} label={`observed USD price${observedAt == null ? "" : ` · Last observation ${new Date(observedAt).toISOString()}`} · ${checkedTime(checkedAt)}`}>
      <Figure className={styles.priceFigure} text={`$${readablePrice(price)}`} />
    </InspectValue>
  );
}

function checkedTime(at: number | null) {
  return at == null ? "Successful check time unavailable" : `Last checked ${new Date(at).toISOString()}`;
}

function ObservedFdv({ value, loading, hidden, label = "FDV" }: Readonly<{ value: CoinRecord["fdv_usd"] | undefined; loading: boolean; hidden: boolean; label?: string }>) {
  if (loading) return <SkeletonText>$00.0K</SkeletonText>;
  if (value == null) return null;
  if (hidden) return "••••";
  return (
    <InspectValue value={`$${value}`} label={label}>
      ${Number(value).toLocaleString("en-US", { notation: "compact", maximumFractionDigits: 1 })}
    </InspectValue>
  );
}

type ReadResult<T> = ReturnType<typeof useCoinRead<T>>;
function CoinContent({
  tab,
  curveLaunch,
  visible,
  coinRead,
  coin,
  history,
  activity,
  asset,
  setup,
  onSetupChange,
  chartTools,
  overlays,
  reads,
}: Readonly<{
  tab: ShownTab;
  /** The bonding curve the coin trades on: its Trades come from the launch, not the presale-keyed home thread. */
  curveLaunch: string | null;
  visible: boolean;
  coinRead: ReadResult<CoinRecord | null>;
  coin: CoinRecord | null;
  history: ReadResult<CoinHistory | null>;
  activity: ReadResult<HomeThreadPage | null>;
  asset: CoinAsset;
  setup: PanelSetup["coin"];
  onSetupChange: CoinPanelProps["onSetupChange"];
  chartTools: ReactNode;
  overlays?: ReactNode;
  reads?: CoinReads;
}>) {
  const loadPosts = useCallback((signal: AbortSignal) => reads?.posts?.(asset, null, signal) ?? Promise.resolve(null), [reads, asset]);
  return (
    <>
      {tab !== "overview" && <CoinMetadataStatus read={coinRead} coin={coin} missingShown={asset.network === "mainnet"} />}
      {tab === "overview" && (
        <>
        <div className={styles.chartStage} data-chart-stage="">
          {chartTools}
            <CoinChart
              key={asset.coin_type}
              activity={activity}
              coin={coin}
              loadPosts={asset.presale_id && reads?.posts ? loadPosts : undefined}
              postMarketId={asset.presale_id}
              failed={history.status === "error" && !history.unavailable}
              unavailable={history.unavailable}
              history={
                history.value?.coin_type === asset.coin_type
                  ? history.value
                  : null
              }
              pending={history.status === "pending" || history.status === "ready" && !history.value && coinRead.status === "pending"}
              retry={history.retry}
              chart={setup.chart}
              onChart={(chart) => onSetupChange({ ...setup, chart })}
            />
          {overlays}
        </div>
        </>
      )}
      {tab === "activity" && (
        <>
          {curveLaunch !== null ? (
            <CurveTrades launchId={curveLaunch} asset={asset} coin={coin} visible={visible} />
          ) : activity.status === "error" ? (
            <ReadProblem name="Activity" retry={activity.retry} />
          ) : activity.status === "pending" ? (
            <Pending name="activity" />
          ) : (
            <Activity page={activity.value} coin={coin} />
          )}
        </>
      )}
    </>
  );
}

function CoinMetadataStatus({
  read,
  coin,
  missingShown,
}: Readonly<{ read: ReadResult<CoinRecord | null>; coin: CoinRecord | null; missingShown: boolean }>) {
  return (
    <>
      {read.status === "pending" && (
        <div role="status" aria-label="Loading coin metadata">
          <SkeletonText>Coin identity and market facts</SkeletonText>
        </div>
      )}
      {read.status === "error" && (
        <ReadProblem name="Coin metadata" retry={read.retry} />
      )}
      {read.status === "ready" && !coin && !missingShown && (
        <p role="status">
          Coin metadata is unavailable from the loaded sources. Your setup is
          kept.{" "}
          <Button variant="ghost" size="sm"
            className={styles.pill}
            type="button"
            onClick={read.retry}
          >
            Retry metadata
          </Button>
        </p>
      )}
    </>
  );
}

/** Restore once per presentation/tab, after content is ready. User intent wins over late reads. */
function useCoinNavigation({
  visible,
  tab,
  anchor,
  ready,
  content,
  save,
}: Readonly<{
  visible: boolean;
  tab: PanelSetup["coin"]["tabs"]["selected"];
  anchor: number;
  ready: boolean;
  content: unknown;
  save: (position: number) => void;
}>) {
  const ref = useRef<HTMLDivElement>(null);
  const restoration = useRef<{
    tab: typeof tab;
    visible: boolean;
    anchor: number;
    pending: boolean;
    user: boolean;
    recordScroll: boolean;
    content: unknown;
    ready: boolean;
  } | null>(null);
  useLayoutEffect(() => {
    let state = restoration.current;
    if (!state || state.tab !== tab || state.visible !== visible) {
      state = {
        tab,
        visible,
        anchor,
        pending: true,
        user: false,
        recordScroll: false,
        content,
        ready,
      };
      restoration.current = state;
    }
    if (state.content !== content || state.ready !== ready) {
      state.content = content;
      state.ready = ready;
      state.recordScroll = false;
    }
    if (visible && ready && state.pending && !state.user && ref.current) {
      workspaceScrollOwner(ref.current).scrollTop = state.anchor;
      state.pending = false;
    }
  }, [visible, tab, anchor, ready, content]);
  useEffect(() => {
    if(!ref.current)return;
    const owner=workspaceScrollOwner(ref.current);
    if(owner === ref.current)return;
    const remember=()=>{if(restoration.current?.recordScroll)save(owner.scrollTop);};
    owner.addEventListener("scroll",remember);
    return ()=>owner.removeEventListener("scroll",remember);
  },[save]);
  const userNavigation = () => {
    const state = restoration.current;
    if (state) {
      state.user = true;
      state.recordScroll = true;
      state.pending = false;
    }
  };
  return {
    ref,
    onPointerDown: userNavigation,
    onTouchStart: userNavigation,
    onWheel: userNavigation,
    onKeyDown: (event: KeyboardEvent<HTMLDivElement>) => {
      if (
        [
          "ArrowUp",
          "ArrowDown",
          "PageUp",
          "PageDown",
          "Home",
          "End",
          " ",
        ].includes(event.key)
      )
        userNavigation();
    },
    onScroll: (event: UIEvent<HTMLDivElement>) => {
      if (restoration.current?.recordScroll)
        save(event.currentTarget.scrollTop);
    },
  };
}

function useCoinIdentity(input: CoinAsset, visible: boolean, reads: CoinReads, onPresaleAvailable: CoinPanelProps["onPresaleAvailable"], pollMs: number) {
  const initialAsset = useMemo(
    () => ({
      chain: input.chain,
      network: input.network,
      coin_type: normalizeStructTag(input.coin_type),
      presale_id: input.presale_id,
    }),
    [input.chain, input.network, input.coin_type, input.presale_id],
  );
  const key = `${initialAsset.chain}:${initialAsset.network}:${initialAsset.coin_type}:${initialAsset.presale_id ?? ""}`;
  const loadCoin = useCallback(
    (signal: AbortSignal) => reads.coin(initialAsset, signal),
    [initialAsset, reads],
  );
  const coinRead = useCoinRead(visible, key, loadCoin, (coin) => {
    if (coin?.coin_type !== initialAsset.coin_type) return;
    const presaleId = initialAsset.presale_id ?? coin.presale_id;
    if (presaleId && coin.lifecycle && coin.lifecycle !== "migrated")
      onPresaleAvailable?.(presaleId);
  }, pollMs);
  const coin =
    coinRead.value?.coin_type === initialAsset.coin_type ? coinRead.value : null;
  const asset = useMemo(() => ({...initialAsset,presale_id:initialAsset.presale_id ?? coin?.presale_id ?? null}),[initialAsset,coin?.presale_id]);
  const tradable = (!asset.presale_id && coinRead.status !== "pending") || coin?.lifecycle === "migrated";
  return { key, coinRead, coin, asset, tradable };
}

function CoinBoardIdentity({ coin, asset, socials }: Readonly<{ coin: CoinRecord | null; asset: CoinAsset; socials?: ReactNode }>) {
  const select = useContext(PanelAssetContext);
  const { label, name, address, sale, icon } = useCoinBoardIdentity(coin, asset);
  const names = <><strong className="ticker">{label}</strong>{coin?.verified_team ? <CoinVerifiedMark size="md" /> : null}{name && <span className={focusStyles.coinName}>{name}</span>}</>;
  return (
    <div className={focusStyles.coinChip}>
      <span className={focusStyles.coinMark}><CoinMark coin={{ key: asset.coin_type, coinType: asset.coin_type, network: asset.network, symbol: label, iconUrl: icon, round: false }} size={32} /></span>
      <span className={focusStyles.coinNames}>
        <span className={focusStyles.coinTitle}>
          {select ? <DisclosureButton variant="ghost" size="xs" className={focusStyles.changeCoin} type="button" onClick={select} aria-label={`Change coin: ${coin?.name ?? label}`}>{names}</DisclosureButton> : <span className={focusStyles.changeCoin}>{names}</span>}
          {socials}
        </span>
        <span className={focusStyles.coinMeta}>
          <CoinBoardVenue coin={coin} sale={!!sale} />
          {asset.network !== "mainnet" && <strong>{asset.network}</strong>}
          <InspectValue label={`coin type on Sui ${asset.network}`} value={asset.coin_type}><span className={focusStyles.address}>{address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address}</span></InspectValue>
          <CopyButton key={asset.coin_type} className={focusStyles.copy} label={`Copy ${label} coin address`} onCopy={async () => { await navigator.clipboard.writeText(asset.coin_type); return true; }} />
        </span>
      </span>
    </div>
);
}

function CoinBoardVenue({ coin, sale }: Readonly<{ coin: CoinRecord | null; sale: boolean }>) {
  return <>
    {sale ? (coin?.lifecycle ? <span>Sale</span> : <SkeletonText>Sale</SkeletonText>) : coin?.venue ? <span className={focusStyles.venue}><span className="sr">Trading on </span><DexIdentity iconOnly venue={coin.venue} /></span> : null}
  </>;
}

function useCoinBoardIdentity(coin: CoinRecord | null, asset: CoinAsset) {
  // Audit 12: a coin the workspace has already named (Discover, the bar, a saved panel) shows that identity while its read loads.
  const known = usePanelIdentities()?.get(asset.coin_type, asset.network);
  const fallback = coinTypeIdentity(asset.coin_type);
  const label = coin?.symbol ?? known?.symbol ?? fallback.symbol;
  const fullName = coin?.name ?? known?.name ?? fallback.name;
  const name = fullName && fullName !== label ? fullName : null;
  const address = asset.coin_type.split("::")[0]!;
  const sale = asset.presale_id && coin?.lifecycle !== "migrated";
  return { label, name, address, sale, icon: coin?.icon_url ?? known?.icon ?? fallback.icon };
}
