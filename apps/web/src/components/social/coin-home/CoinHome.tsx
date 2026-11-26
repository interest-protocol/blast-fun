"use client";

import { canonicalHomePath } from "#web/components/blast-ui/nav.ts";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, use, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";

import { HOME_SOURCES, HOME_TRADERS_LIMIT, type HomeCoinsPage, type HomeQuery, type HomeSource, type HomeTradersPage } from "@blast/core/web/contracts/home.ts";
import type { SocialFeedPage } from "@blast/core/web/contracts/feed.ts";
import type { SocialPresaleSummary } from "@blast/core/web/contracts/presales.ts";
import type { BondingHeroSeed } from "#web/lib/backend-api/bonding.ts";

import { blastModeCovering, onUncover } from "../blast-mode/live/mode-cover";
import { happeningStore } from "../happening/happening-store";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { usePhoneLayout } from "#web/components/blast-ui/use-shell-prefs.ts";
import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { ListsLate } from "#web/components/blast-ui/ServiceStatus.tsx";
import { useListsLate } from "#web/components/blast-ui/service-status.ts";

import { useListRestoration } from "#web/components/blast-ui/list-restoration.ts";
import { useSocialViewer } from "../SignInGate";
import styles from "./CoinHome.module.css";
import { homeAnalytics } from "./home-analytics";
import { rememberHomeFilters, restoreHomeFilters } from "./home-filter-preferences";
import { parseHomeSections, serializeHomeSections, type HomeSectionKey, type HomeSectionPrefs } from "./home-sections";
import { HOME_DEFAULT_FEED, activeFilterCount, discoverQueryOf, stageDefaultSort, tabOf, viewSearchOf, viewStateOf, withView, type HomeViewState } from "./home-state";
import { setHomeRows, useHomeRows } from "./use-home-rows";
import { FollowedTape } from "./FollowedTape";
import { CoinsListControls, CoinTabs, HomeSearch, HomeSettingsMenu, SourceTabs } from "./HomeControls";
import { HomeSections, type SectionChange, type SectionSpec } from "./HomeSections";
import { PinnedLaunches } from "./PinnedLaunches";
import { PostsSection } from "./PostsSection";
import { HeaderRankingControls } from "./RankingControls";
import { createRankingsStore, RankingsSlot } from "./rankings-store.ts";
import { DiscoverList, DiscoverPending, FollowingList, ListSkeleton, WatchlistList, type ListProps } from "./sources";
import { TableCard } from "./TableFooter";
import { HomeBondingCurves } from "./HomeBondingCurves";
import { TradersSection } from "./TradersSection";
import { setHomeSections, useHomeSections } from "./use-home-sections";

const noop = () => undefined;

/** Relative times move on every 30 s (as the feed's), never while Blast mode covers the page. */
function useClock(initialMs: number): number {
  const [now, setNow] = useState(initialMs);
  useEffect(() => {
    const tick = window.setInterval(() => { if (!blastModeCovering()) setNow(Date.now()); }, 30_000);
    const off = onUncover(() => setNow(Date.now()));
    return () => { window.clearInterval(tick); off(); };
  }, []);
  return now;
}

function replaceViewUrl(url: string | URL): void {
  // Omit Next’s internal marker so its patched history API also synchronizes the URL controls.
  window.history.replaceState({ blastLists: window.history.state?.blastLists, blastListContent: window.history.state?.blastListContent }, "", url);
}

/** The URL owns the view. After hydration, a plain Home visit can use the saved filters. */
function useViewState(initial: HomeViewState): readonly [HomeViewState, (next: HomeViewState) => void] {
  const params = useSearchParams();
  const pathname = usePathname();
  const state = useMemo(() => (params === null ? initial : viewStateOf(new URLSearchParams(params.toString()))), [params, initial]);
  const controlsUrl = useRef<string | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    const changedByControls = controlsUrl.current === url.href;
    controlsUrl.current = null;
    if (changedByControls) {
      return;
    }
    const restored = restoreHomeFilters(url);
    if (!restored) {
      return;
    }
    // Next patches replaceState in an ancestor effect during hydration.
    const timer = window.setTimeout(() => {
      if (window.location.href === url.href && controlsUrl.current === null) {
        replaceViewUrl(restored);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [params, pathname]);
  const set = useCallback((next: HomeViewState) => {
    const url = new URL(`${canonicalHomePath(pathname)}${viewSearchOf(next)}`, window.location.href);
    if (url.href !== window.location.href) {
      controlsUrl.current = url.href;
      replaceViewUrl(url);
    }
  }, [pathname]);
  return [state, set];
}

export type CoinHomeProps = Readonly<{
  /** The confirmed server result for the initial Discover view, when available. */
  initial: HomeCoinsPage | null;
  initialState: HomeViewState;
  /** The server's reads of Blast's pins (presales, bonding curves); null when a read failed, and the browser then asks. */
  pinned?: Readonly<{ presales: readonly SocialPresaleSummary[] | null; curves: BondingHeroSeed | null; seed: string }>;
  /** The server's traders read; null when hidden or failed. */
  traders: HomeTradersPage | null;
  posts?: SocialFeedPage | null;
  /** The device's sections as the server read them from the cookie. */
  sections: HomeSectionPrefs;
  /** The device's rows per page as the server read them from the cookie (`home-rows.ts`). */
  initialRows: number;
  nowMs: number;
  trading: boolean;
}>;

type SectionSeed<Data> = Data | null | Promise<Data | null>;
type DiscoverSeed = SectionSeed<HomeCoinsPage>;
type CoinHomeReadProps = Omit<CoinHomeProps, "initial" | "traders" | "posts"> & Readonly<{
  initial: DiscoverSeed;
  traders: SectionSeed<HomeTradersPage>;
  posts?: SectionSeed<SocialFeedPage>;
}>;

/** Brings the Coins section's top under the sticky bar after a page turn (its `scroll-margin-top`), so the new page starts where the reader looks. */
function scrollToCoins(animate = true): void {
  const section = document.querySelector<HTMLElement>('[data-section="coins"]');
  if (!section) return;
  const reduce = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  section.scrollIntoView({ block: "start", behavior: animate && !reduce ? "smooth" : "instant" });
}

/**
 * Home (the Main board): the page header with Customize Home, the featured
 * carousel, the tape of followed trades, then the sections in
 * the device's order (by default the board's: Coins, Bonding Curves, Posts, Top
 * traders). Each section is a title line over its own surface: Coins
 * (Discover, Following and the Watchlist as the title line's sources; one
 * table with links to coin and presale pages; Trending lists presales next
 * to coins), Bonding Curves (launchpad stages), Posts and Top traders (tables) — movable and hideable from
 * Customize Home, the hidden ones never read. The page has no right column.
 */
export function CoinHome({ initial, initialState, pinned, traders, posts = null, sections, initialRows, nowMs, trading }: CoinHomeReadProps) {
  const [state, setState] = useViewState(initialState);
  const phone = usePhoneLayout();
  const prefs = useHomeSections(sections);
  const deviceRows = useHomeRows(initialRows);
  const [restoredRows, setRestoredRows] = useState<number | null>(null);
  const rows = restoredRows ?? deviceRows;
  const now = useClock(nowMs);
  const id = useId();
  const viewer = useSocialViewer();
  const late = useListsLate();
  // Home keeps the happening reads running, so the funded-presale notice and the portfolio refresh still hear a sale close.
  useEffect(() => happeningStore().subscribe(noop), []);
  const listValue = useMemo(() => ({ rows, sections: prefs }), [rows, prefs]);
  const listRoot = useListRestoration(`home:${viewer.callsign ?? "public"}`, listValue, saved => {
    setRestoredRows(saved.rows);
    // Older history entries (before Bonding Curves, or with the retired Presales section) need the same upgrade as saved cookies.
    setHomeSections(parseHomeSections(serializeHomeSections(saved.sections)));
  }, { restoreOnMount: "history-traversal" });
  const change = (asked: HomeViewState) => {
    const next = withView(state, asked);
    if (next.source !== state.source) homeAnalytics.source(next);
    else homeAnalytics.controls(next, activeFilterCount(next));
    rememberHomeFilters(state, next);
    setState(next);
  };
  // A page turn brings the section's top back under the bar.
  const onPage = useCallback((page: number, scroll = true) => {
    setState({ ...state, page });
    homeAnalytics.page(state.source, page, rows);
    if (scroll) scrollToCoins();
  }, [state, rows, setState]);
  const onRows = useCallback((next: number) => {
    setRestoredRows(next);
    setHomeRows(next);
    setState({ ...state, page: 1 });
    homeAnalytics.page(state.source, 1, next);
  }, [state, setState]);
  const changeSections = useCallback((next: HomeSectionPrefs, changed: SectionChange | null) => {
    setHomeSections(next);
    if (changed) homeAnalytics.sections(changed.key, changed.action, changed.position);
  }, []);
  const panelId = (source: HomeSource) => `${id}-${source}`;
  // The shown list's live switch, drawn on the Coins header's line.
  const [rankingsStore] = useState(createRankingsStore);
  const query = useMemo(() => discoverQueryOf(state, rows), [state, rows]);
  const matchesInitial = JSON.stringify(discoverQueryOf(initialState, initialRows)) === JSON.stringify(query);
  const list: ListProps = useMemo(() => ({
    source: state.source,
    window: state.window,
    nowMs: now,
    trading,
    stage: state.stage,
    sort: state.sort,
    defaultSort: stageDefaultSort(state.stage),
    streamPrices: true,
    onSort: (sort) => change({ ...state, sort }),
    page: state.page,
    rows,
    onPage,
    onRows,
    onWindow: (window) => change({ ...state, window, page: 1 }),
    onReset: () => change({ ...HOME_DEFAULT_FEED, stage: state.stage, sort: state.sort }),
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `change` closes over the same state the keys name.
  }), [state, rows, now, trading, onPage, onRows]);
  const specs: Readonly<Record<HomeSectionKey, SectionSpec>> = {
    posts: { children: (
      <Suspense fallback={<HomePending rows={3} />}>
        <HomeRead read={posts}>{(data) => <PostsSection initial={data} nowMs={now} />}</HomeRead>
      </Suspense>
    ) },
    coins: {
      tools: (
        <div className={styles.coinHead}>
          <SourceTabs ids={panelId} onSource={(source) => change({ ...state, source })} source={state.source} />
          <HomeSearch />
          <div className={styles.coinControls}>
            <CoinsListControls onChange={change} state={state} />
            {state.source !== "watchlist" ? <span className={styles.rowTools}><HeaderRankingControls store={rankingsStore} /></span> : null}
          </div>
        </div>
      ),
      children: (
        <TableCard>
          {HOME_SOURCES.map((source) => (
            <section aria-labelledby={`${panelId(source)}-tab`} hidden={state.source !== source} id={panelId(source)} key={source} role="tabpanel">
              {state.source === source ? (
                source === "discover" ? <DiscoverTabs onChange={change} panelId={`${panelId(source)}-coins`} state={state}>
                  <DiscoverSource read={matchesInitial ? initial : null} props={list} query={query} />
                </DiscoverTabs>
                  : source === "following" ? <FollowingList onDiscover={() => change({ ...state, source: "discover" })} props={list} />
                    : <WatchlistList props={list} />
              ) : null}
            </section>
          ))}
        </TableCard>
      ),
    },
    traders: { title: "PnL leaderboard", children: (
      <Suspense fallback={<HomePending rows={HOME_TRADERS_LIMIT} />}>
        <HomeRead read={traders}>{(data) => <TradersSection initial={data} initialMs={nowMs} nowMs={now} window={state.window} />}</HomeRead>
      </Suspense>
    ) },
    bonding: {
      children: <HomeBondingCurves nowMs={now} />,
    },
  };
  const customize = <HomeSettingsMenu onSections={changeSections} sections={prefs} showLabel={phone} />;
  const tape = <FollowedTape key="tape" nowMs={now} window={state.window} />;
  const discovery = (
    <RankingsSlot.Provider key="discovery" value={rankingsStore}>
      <HomeSections
        empty={<EmptyState framed title="Every section is hidden">Restore sections from Customize Home.</EmptyState>}
        prefs={prefs}
        sections={specs}
      />
    </RankingsSlot.Provider>
  );
  return (

    // While lists are late, one line stands in for every section whose list came back empty (CoinHome.module.css).
    <div ref={listRoot} className={styles.home} data-late={late || undefined}>
      <PageHeader actions={phone ? undefined : customize} title="Home" />
      <div className={styles.board}>
        {late ? <ListsLate className={styles.lateLine} /> : null}
        <PinnedLaunches curves={pinned?.curves} now={now} nowMs={nowMs} initialPinSeed={pinned?.seed ?? ""} presales={pinned?.presales} />
        {phone ? [discovery, tape] : [tape, discovery]}
        {phone ? <div className={styles.customize}>{customize}</div> : null}
      </div>
    </div>

  );
}

type DiscoverProps = Readonly<{
  read: DiscoverSeed;
  props: ListProps;
  query: HomeQuery;
}>;

/** Discover's tabs over the one list they control, labelled by the tab in force. */
function DiscoverTabs({ state, onChange, panelId, children }: Readonly<{ state: HomeViewState; onChange: (next: HomeViewState) => void; panelId: string; children: ReactNode }>) {
  const tab = tabOf(state);
  return <>
    <CoinTabs onChange={onChange} panelId={panelId} state={state} />
    <div aria-label={tab ? undefined : "Coins"} aria-labelledby={tab ? `${panelId}-${tab}` : undefined} id={panelId} role="tabpanel">{children}</div>
  </>;
}

function DiscoverSource({ read, props, query }: DiscoverProps) {
  return (
    <Suspense fallback={<div className={styles.pending}><DiscoverPending props={props} /></div>}>
      <HomeRead read={read}>{(data) => <DiscoverList initial={data} props={props} query={query} />}</HomeRead>
    </Suspense>
  );
}

function HomePending({ rows }: Readonly<{ rows: number }>) {
  return <div className={styles.pending}><TableCard><ListSkeleton rows={rows} /></TableCard></div>;
}

function HomeRead<Data>({ read, children }: Readonly<{ read: SectionSeed<Data>; children: (data: Data | null) => ReactNode }>) {
  return children(read && typeof read === "object" && "then" in read ? use(read) : read);
}
