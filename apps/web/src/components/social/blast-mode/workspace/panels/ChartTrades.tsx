import { Button, DisclosureButton } from "#web/components/blast-ui/Button.tsx";
import { Checkbox } from "#web/components/blast-ui/Checkbox.tsx";
import { useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import type { HomeThreadPage, HomeDiscussionPage } from "@blast/core/web/contracts/home.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { useViewerStateStore } from "#web/components/social/ViewerState.tsx";
import { tradersQuery } from "#web/components/social/coin-home/home-client.ts";
import { ListedKolsContext } from "../listed-kols";
import { publicPnlRanks } from "../holder-signals";
import { CoinDetailsSlots } from "./panel-context";
import { DEFAULT_TRADE_FILTERS, chartTradeAnnotation, filterChartTrades, mergeChartAnnotations, withChartPosts, type ChartAnnotation, type TradeFilters } from "./chart-trades";
import { fetchBigChartTrades, fetchMyChartTrades } from "./coin-market-reads";
import { useCurrentBlastAccount } from "../BlastActionProvider";
import { useTradeReads } from "#web/components/launchpad/trade-reads.ts";
import type { HomeChartTradesPage } from "@blast/core/web/contracts/coin-market.ts";
import { useCoinRead } from "./use-coin-read";
import type { CoinRecord } from "./coin-reads";
import { ChartTradesContext, type ChartActivityRead } from "./chart-trades-context";
import styles from "./ChartTrades.module.css";

const emptyTrades: readonly ChartAnnotation[] = [];
const noPosts = async () => null;
const noSubscribe = () => () => {};
const noVersion = () => 0;
const noRanks: ReadonlyMap<string, number> = new Map();

/** One optional overlay shares the panel's bounded public activity read. */
export function ChartTrades({ activity, coin, children, loadPosts, postMarketId }: Readonly<{
  activity: ChartActivityRead; coin: CoinRecord | null; children: ReactNode;
  loadPosts?: (signal: AbortSignal) => Promise<HomeDiscussionPage | null>;
  postMarketId?: string | null;
}>) {
  const [enabled, setEnabled] = useState(false);
  const [filters, setFilters] = useState<TradeFilters>(DEFAULT_TRADE_FILTERS);
  const slots = useContext(CoinDetailsSlots);
  const active = enabled && slots.visible !== false;
  const marketTrades = useMarketChartTrades(coin, slots.visible !== false);
  const kols = useContext(ListedKolsContext);
  const store = useChartViewerStore();
  const page = activity.status === "ready" ? activity.value : null;
  const { posts, discussion } = useChartPosts(active && filters.posts, loadPosts, postMarketId);
  const callsigns = chartCallsigns(page, discussion);
  const following = useChartFollowing(active && filters.groups.following, callsigns, store);
  const ranking = useChartPnlRanks(active && filters.groups.top, coin?.coin_type ?? null);
  const social = active ? selectChartAnnotations({ page, discussion, marketId: postMarketId, filters, kols, ranks: ranking.ranks, store }) : emptyTrades;
  const trades = marketTrades.extra.length ? mergeChartAnnotations(social, marketTrades.extra) : social;
  const missingFollows = followingStatusMissing(active && filters.groups.following, callsigns, store);
  const effectiveFilters = { ...filters, posts: filters.posts && !!loadPosts };
  const notice = <ChartReadNotice active={active} activity={activity} filters={effectiveFilters} kolAvailable={kols.length > 0} ranking={ranking} following={following} store={store} missingFollows={!!missingFollows} posts={posts} marketNotice={marketTrades.notice} />;
  const peopleReady = socialOverlaysReady(page, effectiveFilters, ranking, following.pending || !!missingFollows, !!store, kols.length > 0, posts, discussion);
  const ready = (!active || peopleReady) && marketTrades.ready;
  const shown = active || marketTrades.on;
  const value = { trades, coin, enabled: shown, notice, ready, ...chartCoverage(page) };
  const control = <OverlaysControl enabled={enabled} setEnabled={setEnabled} filters={filters} setFilters={setFilters} signedIn={!!store} postsAvailable={!!loadPosts} notice={notice}
    mine={marketTrades.mine} big={marketTrades.big}
    onPeople={(on) => { const next = toggledPeople(enabled, filters, on); setFilters(next.filters); setEnabled(next.enabled); }}
    onTheses={(on) => { const next = toggledTheses(enabled, filters, on); setFilters(next.filters); setEnabled(next.enabled); }}
    onMine={marketTrades.setMine} onBig={marketTrades.setBig} />;
  return <ChartTradesContext value={value}>
    {slots.chart ? createPortal(control, slots.chart) : control}
    {children}
  </ChartTradesContext>;
}

/** "People you follow" from the Overlays menu: from off it shows only followed accounts' trades; on, it flips Following. */
function toggledPeople(enabled: boolean, filters: TradeFilters, on: boolean) {
  if (!enabled) return { enabled: on, filters: { groups: { kol: false, top: false, following: true }, buy: true, sell: true, posts: false } };
  const next = { ...filters, groups: { ...filters.groups, following: on }, ...(on ? { buy: true, sell: true } : {}) };
  return { enabled: Object.values(next.groups).some(Boolean) || next.posts, filters: next };
}

/** "Calls & theses" from the Overlays menu: from off it shows only notable people's theses; on, it flips posts. */
function toggledTheses(enabled: boolean, filters: TradeFilters, on: boolean) {
  if (!enabled) return { enabled: on, filters: { ...DEFAULT_TRADE_FILTERS, buy: false, sell: false, posts: true } };
  const next = { ...filters, posts: on };
  return { enabled: next.posts || next.buy || next.sell, filters: next };
}

const DAY_MS = 86_400_000;
const noMarketTrades = async (): Promise<HomeChartTradesPage | null> => null;

/** The viewer's own trades and the coin's big trades over the chart's 24 hours (#534 reads). */
function useMarketChartTrades(coin: CoinRecord | null, visible: boolean) {
  const [mineChosen, setMine] = useState(false);
  const [bigChosen, setBig] = useState(false);
  const mineOn = visible && mineChosen;
  const bigOn = visible && bigChosen;
  const { getAccessToken, accountState } = useCurrentBlastAccount();
  const signedIn = !!accountState?.account;
  const coinType = coin?.coin_type ?? null;
  const loadMine = useCallback((signal: AbortSignal) => coinType ? fetchMyChartTrades(getAccessToken, coinType, Date.now() - DAY_MS, Date.now(), signal) : noMarketTrades(), [coinType, getAccessToken]);
  const loadBig = useCallback((signal: AbortSignal) => coinType ? fetchBigChartTrades(coinType, Date.now() - DAY_MS, Date.now(), signal) : noMarketTrades(), [coinType]);
  const mine = useCoinRead(mineOn && signedIn && !!coinType, `mine:${coinType}`, loadMine);
  const big = useCoinRead(bigOn && !!coinType, `big:${coinType}`, loadBig);
  const extra = [
    ...(mineOn && mine.value?.coin_type === coinType ? mine.value.trades.map(trade => chartTradeAnnotation(trade, "mine", null)) : []),
    ...(bigOn && big.value?.coin_type === coinType ? big.value.trades.map(trade => chartTradeAnnotation(trade, "big", null)) : []),
  ];
  const notice = <MarketTradeNotice mineOn={mineOn} bigOn={bigOn} mine={mine} big={big} />;
  return { extra, notice, mine: mineChosen, big: bigChosen, setMine, setBig, on: mineOn || bigOn, ready: (!mineOn || mine.status === "ready") && (!bigOn || big.status === "ready") };
}


function useChartViewerStore() {
  const store = useViewerStateStore();
  useSyncExternalStore(store?.subscribe ?? noSubscribe, store?.version ?? noVersion, noVersion);
  return store;
}

function selectChartAnnotations({ page, discussion, marketId, filters, kols, ranks, store }: Readonly<{
  page: HomeThreadPage | null; discussion: HomeDiscussionPage | null; marketId?: string | null;
  filters: TradeFilters; kols: readonly string[]; ranks: ReadonlyMap<string, number>;
  store: ReturnType<typeof useViewerStateStore>;
}>) {
  const membership = new Set(kols);
  const follows = (callsign: string) => store?.following({ kind: "account", callsign });
  const trades = filterChartTrades(page?.participants ?? [], filters, membership, ranks, follows);
  return withChartPosts(trades, discussion?.items ?? [], marketId ?? null, filters, membership, ranks, follows);
}

function useChartPosts(active: boolean, load: ((signal: AbortSignal) => Promise<HomeDiscussionPage | null>) | undefined, marketId: string | null | undefined) {
  const posts = useCoinRead(active && !!load, "chart-posts", load ?? noPosts);
  const discussion = posts.status === "ready" && posts.value?.presale_id === marketId ? posts.value : null;
  return { posts, discussion };
}

function chartPostsReady(selected: boolean, read: ReturnType<typeof useCoinRead<HomeDiscussionPage | null>>, discussion: HomeDiscussionPage | null) {
  return !selected || (read.status === "ready" && !!discussion);
}

function chartCoverage(page: HomeThreadPage | null) {
  return { window: page?.window ?? null, partial: !!page?.next_cursor || !!page?.participants.some(row => row.events_more) };
}

function chartCallsigns(page: HomeThreadPage | null, discussion: HomeDiscussionPage | null) {
  const actors = [...page?.participants.map(row => row.actor) ?? [], ...discussion?.items.map(post => post.actor) ?? []];
  return [...new Set(actors.flatMap(actor => actor?.type === "account" ? [actor.callsign] : []))].join(",");
}

function followingStatusMissing(active: boolean, callsigns: string, store: ReturnType<typeof useViewerStateStore>) {
  return !!(active && store && callsigns.split(",").filter(Boolean).some(callsign => store.following({ kind: "account", callsign }) === undefined));
}

function chartTradesReady(page: HomeThreadPage | null, filters: TradeFilters, rankingUnavailable: boolean, followingUnavailable: boolean, signedIn: boolean, kolAvailable: boolean) {
  const selectedGroups = filters.groups;
  const availableGroup = (selectedGroups.kol && kolAvailable) || selectedGroups.top || (selectedGroups.following && signedIn);
  return !!page && availableGroup && (filters.buy || filters.sell || filters.posts)
    && !(selectedGroups.top && rankingUnavailable) && !(selectedGroups.following && followingUnavailable);
}

function ChartPostStatus({ read }: Readonly<{ read: ReturnType<typeof useCoinRead<HomeDiscussionPage | null>> }>) {
  if (read.status === "pending") return <div role="status" aria-label="Loading chart calls and theses"><SkeletonText>Calls and theses</SkeletonText></div>;
  if (read.status === "error") return <p role="alert" className={styles.note}>Calls and theses could not load. <Button variant="ghost" size="sm" onClick={read.retry}>Retry posts</Button></p>;
  if (!read.value) return <p role="status" className={styles.note}>Calls and theses unavailable for this market.</p>;
  return read.value.as_of.lag_ms > 60_000 ? <p role="status" className={styles.note}>Calls and theses may be delayed.</p> : null;
}

/**
 * The day's top traders, read again when this coin trades on the tab's market stream (at most once per
 * 30 s) and every 30 s besides, for trades elsewhere.
 */
function useChartPnlRanks(active: boolean, coinType: string | null) {
  const read = useQuery({
    ...tradersQuery("24h", { search: "", page: 1, limit: 10 }),
    enabled: active, subscribed: active,
    staleTime: 30_000, retry: false,
    refetchOnWindowFocus: false, refetchOnReconnect: false,
  }, useAppQueryClient());
  useTradeReads({
    coinType: active ? coinType ?? "" : null,
    minGapMs: RANKS_GAP_MS,
    fallbackMs: RANKS_FALLBACK_MS,
    initial: false,
    read: () => void read.refetch({ cancelRefetch: false }),
  });
  const unavailable = read.isError || (!!read.data && read.data.as_of.lag_ms > 60_000);
  return {
    ranks: active && read.data && !unavailable ? publicPnlRanks(read.data.traders) : noRanks,
    pending: read.isPending, unavailable, retry: () => void read.refetch(),
  };
}

const RANKS_GAP_MS = 30_000;
const RANKS_FALLBACK_MS = { live: 30_000, idle: 30_000 } as const;

function useChartFollowing(active: boolean, callsigns: string, store: ReturnType<typeof useViewerStateStore>) {
  const [attempt, setAttempt] = useState(0);
  const [finished, setFinished] = useState<Readonly<{ store: typeof store; callsigns: string; attempt: number }> | null>(null);
  useEffect(() => {
    if (!active || !store || !callsigns) return;
    let current = true;
    store.want({ callsigns: callsigns.split(",") });
    void store.flush().finally(() => { if (current) setFinished({ store, callsigns, attempt }); });
    return () => { current = false; };
  }, [active, store, callsigns, attempt]);
  return {
    pending: active && !!store && !!callsigns && !(finished?.store === store && finished.callsigns === callsigns && finished.attempt === attempt),
    retry: () => setAttempt(value => value + 1),
  };
}

/**
 * Overlays (audit 11/15): every optional chart layer in one labelled menu with clear selected
 * states. My trades, Big trades, People you follow and Calls & theses lead; then which people
 * and sides the people layer shows. The trigger counts what is on, so the toolbar keeps one
 * control where Show people and four On chart chips used to compete.
 */
const EDGE = 12;

/** Room the Overlays popup keeps from the top of the viewport: the Blast mode top bar plus the edge gap. */
function topBarClearance(): number {
  const bar = document.querySelector("header:has(> [data-workspace-toolbar])");
  return Math.max(EDGE, Math.round((bar?.getBoundingClientRect().bottom ?? 0) + EDGE));
}

function OverlaysControl({ enabled, setEnabled, filters, setFilters, signedIn, postsAvailable, notice, mine, big, onPeople, onTheses, onMine, onBig }: Readonly<{
  enabled: boolean; setEnabled: (value: boolean) => void;
  filters: TradeFilters; setFilters: (value: TradeFilters) => void;
  signedIn: boolean; postsAvailable: boolean; notice: ReactNode;
  mine: boolean; big: boolean;
  onPeople: (on: boolean) => void; onTheses: (on: boolean) => void; onMine: (on: boolean) => void; onBig: (on: boolean) => void;
}>) {
  const { people, theses, on } = overlaySelection(signedIn, enabled, filters, postsAvailable, mine, big);
  const [top, setTop] = useState(EDGE);
  return <Popover.Root onOpenChange={open => { if (open) setTop(topBarClearance()); }}>
    <Popover.Trigger render={<DisclosureButton variant="secondary" size="sm">Overlays{on > 0 && <span className={styles.count} aria-hidden="true">{on}</span>}</DisclosureButton>} className={styles.trigger} aria-label={on > 0 ? `Chart overlays, ${on} on` : "Chart overlays"} data-active={on > 0} />
    <PopoverSurface
      // Under its trigger, flipping above only when more room is there, and never over the top bar and its Exit (audit F38). The popup scrolls in the room it gets.
      positioner={{ side: "bottom", align: "end", sideOffset: 8, collisionPadding: { top, right: EDGE, bottom: EDGE, left: EDGE }, collisionAvoidance: { side: "flip", align: "shift", fallbackAxisSide: "none" }, className: styles.layer }}
      popup={{ className: styles.popup, "aria-label": "Chart overlays" }}
    >
        <Popover.Title className={styles.title}>Overlays</Popover.Title>
        <fieldset className={styles.options}><legend>On chart</legend>
          <label className={styles.option}><Checkbox checked={signedIn && mine} disabled={!signedIn} onChange={event => onMine(event.currentTarget.checked)} /><span className={styles.layerName}><span aria-hidden="true" className={styles.dot} />My trades{!signedIn && <small>Sign in to show your trades</small>}</span></label>
          <label className={styles.option}><Checkbox checked={big} onChange={event => onBig(event.currentTarget.checked)} /><span className={styles.layerName}>Big trades &gt;$1K</span></label>
          <label className={styles.option}><Checkbox checked={people} disabled={!signedIn} onChange={event => onPeople(event.currentTarget.checked)} /><span className={styles.layerName}><span aria-hidden="true" className={styles.dots}><span /><span /></span>People you follow{!signedIn && <small>Sign in to use Following</small>}</span></label>
          <label className={styles.option}><Checkbox checked={theses} disabled={!postsAvailable} onChange={event => onTheses(event.currentTarget.checked)} /><span className={styles.layerName}>Calls &amp; theses{!postsAvailable && <small>No post source for this coin</small>}</span></label>
        </fieldset>
        <fieldset className={styles.options}><legend>People · match any selected group</legend>
          <label className={styles.option}><Checkbox checked={enabled} onChange={event => setEnabled(event.currentTarget.checked)} /><strong>Show people&apos;s trades</strong></label>
          {/* Groups belong to Show people's trades: off, they keep their choice but cannot change (audit F38). */}
          <label className={styles.option}><Checkbox disabled={!enabled} checked={filters.groups.kol} onChange={event => setFilters({ ...filters, groups: { ...filters.groups, kol: event.currentTarget.checked } })} /><span>KOLs</span></label>
          <label className={styles.option}><Checkbox disabled={!enabled} checked={filters.groups.top} onChange={event => setFilters({ ...filters, groups: { ...filters.groups, top: event.currentTarget.checked } })} /><span>Top traders<small>Top 10 by public PnL · 24h</small></span></label>
          <label className={styles.option}><Checkbox disabled={!signedIn || !enabled} checked={signedIn && filters.groups.following} onChange={event => setFilters({ ...filters, groups: { ...filters.groups, following: event.currentTarget.checked } })} /><span>Following{!signedIn && <small>Sign in to use Following</small>}</span></label>
        </fieldset>
        <fieldset className={styles.options}><legend>Side</legend><div className={styles.sides}>
          <label className={styles.option}><Checkbox disabled={!enabled} checked={filters.buy} onChange={event => setFilters({ ...filters, buy: event.currentTarget.checked })} /><span className={styles.buy}>B · Buys</span></label>
          <label className={styles.option}><Checkbox disabled={!enabled} checked={filters.sell} onChange={event => setFilters({ ...filters, sell: event.currentTarget.checked })} /><span className={styles.sell}>S · Sells</span></label>
        </div></fieldset>
        <p className={styles.note}>Trades on every venue · 24h</p>
        {notice}
        <div className={styles.footer}><Popover.Close render={<Button variant="secondary" size="sm" />}>Done</Popover.Close></div>
      </PopoverSurface>
  </Popover.Root>;
}

function TradeReadStatus({ activity, filters, kolAvailable, ranking, following }: Readonly<{
  activity: ChartActivityRead; filters: TradeFilters; kolAvailable: boolean;
  ranking: { pending: boolean; unavailable: boolean; retry: () => void };
  following: { signedIn: boolean; pending: boolean; unavailable: boolean; retry: () => void };
}>) {
  if (!Object.values(filters.groups).some(Boolean)) return <p role="status" className={styles.note}>Select a group to show trades.</p>;
  if (!filters.buy && !filters.sell && !filters.posts) return <p role="status" className={styles.note}>Select Buys or Sells to show trades.</p>;
  if (activity.status === "pending") return <div role="status" aria-label="Loading chart trades"><SkeletonText>Chart trades</SkeletonText></div>;
  if (activity.status === "error") return <p role="alert" className={styles.note}>Trades could not load. <Button variant="ghost" size="sm" type="button" onClick={activity.retry}>Retry trades</Button></p>;
  if (!activity.value) return <p role="status" className={styles.note}>Chart trades unavailable for this market.</p>;
  return <>
    {filters.groups.kol && !kolAvailable && <p role="status" className={styles.note}>KOL list is not configured yet.</p>}
    {activity.value.as_of.lag_ms > 60_000 && <p role="status" className={styles.note}>Trade indexing is delayed; recent trades may be missing.</p>}
    {filters.groups.top && (ranking.pending ? <div role="status" aria-label="Loading top traders"><SkeletonText>Top traders</SkeletonText></div> : ranking.unavailable ? <p role="status" className={styles.note}>Top traders unavailable. <Button variant="ghost" size="sm" type="button" onClick={ranking.retry}>Retry rankings</Button></p> : null)}
    {filters.groups.following && <FollowingTradeStatus {...following} />}
  </>;
}

function FollowingTradeStatus({ signedIn, pending, unavailable, retry }: Readonly<{ signedIn: boolean; pending: boolean; unavailable: boolean; retry: () => void }>) {
  if (!signedIn) return <p role="status" className={styles.note}>Sign in to use Following.</p>;
  if (pending) return <div role="status" aria-label="Loading Following trades"><SkeletonText>Following trades</SkeletonText></div>;
  if (unavailable) return <p role="status" className={styles.note}>Some Following status is unavailable. <Button variant="ghost" size="sm" type="button" onClick={retry}>Retry Following</Button></p>;
  return null;
}

function MarketTradeNotice({ mineOn, bigOn, mine, big }: Readonly<{ mineOn: boolean; bigOn: boolean; mine: ReturnType<typeof useCoinRead<HomeChartTradesPage | null>>; big: ReturnType<typeof useCoinRead<HomeChartTradesPage | null>> }>) {
  return <>
    {mineOn && mine.status === "error" && <p role="alert" className={styles.note}>Your trades could not load. <Button variant="ghost" size="sm" type="button" onClick={mine.retry}>Retry</Button></p>}
    {bigOn && big.status === "error" && <p role="alert" className={styles.note}>Big trades could not load. <Button variant="ghost" size="sm" type="button" onClick={big.retry}>Retry</Button></p>}
    {(mineOn && mine.value?.truncated) || (bigOn && big.value?.truncated) ? <p role="status" className={styles.note}>Showing the newest 200 trades.</p> : null}
  </>;
}

function overlaySelection(signedIn: boolean, enabled: boolean, filters: TradeFilters, postsAvailable: boolean, mine: boolean, big: boolean) {
  const people = signedIn && enabled && filters.groups.following && (filters.buy || filters.sell);
  const theses = postsAvailable && enabled && filters.posts;
  const on = [signedIn && mine, big, enabled && (people || filters.groups.kol || filters.groups.top), theses].filter(Boolean).length;
  return { people, theses, on };
}

function ChartReadNotice({ active, activity, filters, kolAvailable, ranking, following, store, missingFollows, posts, marketNotice }: Readonly<{
  active: boolean; activity: ChartActivityRead; filters: TradeFilters; kolAvailable: boolean;
  ranking: ReturnType<typeof useChartPnlRanks>; following: ReturnType<typeof useChartFollowing>;
  store: ReturnType<typeof useChartViewerStore>; missingFollows: boolean;
  posts: ReturnType<typeof useCoinRead<HomeDiscussionPage | null>>; marketNotice: ReactNode;
}>) {
  return <>
    {active && <TradeReadStatus activity={activity} filters={filters} kolAvailable={kolAvailable} ranking={ranking} following={{ signedIn: !!store, pending: following.pending, unavailable: missingFollows, retry: following.retry }} />}
    {active && filters.posts && <ChartPostStatus read={posts} />}
    {marketNotice}
  </>;
}

function socialOverlaysReady(page: HomeThreadPage | null, filters: TradeFilters, ranking: ReturnType<typeof useChartPnlRanks>, followingUnavailable: boolean, signedIn: boolean, kolAvailable: boolean, posts: ReturnType<typeof useCoinRead<HomeDiscussionPage | null>>, discussion: HomeDiscussionPage | null) {
  return chartTradesReady(page, filters, ranking.pending || ranking.unavailable, followingUnavailable, signedIn, kolAvailable)
    && chartPostsReady(filters.posts, posts, discussion);
}
