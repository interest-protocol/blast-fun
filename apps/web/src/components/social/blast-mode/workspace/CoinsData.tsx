"use client";

import { queryKeys } from "#web/lib/query/keys.ts";
import { FieldGroup, TextField } from "#web/components/blast-ui/TextField.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { CoinVerifiedMark, SearchIcon } from "#web/components/blast-ui/Icons.tsx";
import { Button, IconButton } from "#web/components/blast-ui/Button.tsx";
import {
  useIsFetching,
  useQuery,
  keepPreviousData,
  type Query,
  type QueryFunction,
  type QueryFunctionContext,
  type SkipToken,
  type UseQueryResult,
} from "@tanstack/react-query";
import { createContext, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { PanelIdentitiesContext } from "./panel-identities";
import { useWorkspace } from "./workspace-context";
import {
  coinsByIdsQuery,
  discoverQuery,
  followingCoinsQuery,
} from "../../coin-home/home-client";
import { DiscoverEmpty } from "../../coin-home/sources";
import {
  HOME_COINS_MAX_IDS,
  HOME_DEFAULT_WINDOW,
  type HomeCoin,
  type HomeCoinsByIds,
  type HomeCoinsPage,
  type HomeFollowingResponse,
} from "@blast/core/web/contracts/home.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { RowsSkeleton } from "./RowsSkeleton";
import { useDebouncedValue } from "#web/lib/use-debounced-value.ts";
import { Collapse } from "#web/components/blast-ui/Collapse.tsx";
import { DelayedNote, LoadFailed, NothingHere, RefreshFailed } from "./DataStates";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { useSocialViewer } from "../../SignInGate";
import {
  useWatchlistSnapshot,
  useWatchlistRetry,
} from "../../watchlist/Watchlist";
import {
  Pick,
  WindowPick,
} from "../../coin-home/HomeControls";
import { HOME_LAUNCHED_AGES } from "@blast/core/web/contracts/home.ts";
import {
  activeFilterCount,
  AGE_LABELS,
  controlsApply,
  HOME_DEFAULT_VIEW,
  HOME_VIEW_SORTS,
  isHomeViewSort,
  MIN_PARTICIPANT_CHOICES,
  BLAST_MODE_SORT_LABELS,
  SOURCE_LABELS,
  type HomeViewState,
} from "../../coin-home/home-state";
import { Pager } from "#web/components/blast-ui/Pager.tsx";
import { liveFreshness } from "../../home/activity-hints";
import {
  browserGapTimers,
  hintedGap,
  NEW_POSTS_MIN_GAP_MS,
} from "../../home/feed-freshness";
import type { DataControls } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { fetchListedTradeCoins } from "../../coins/swap-client";
import type { SocialTradeCoin } from "@blast/core/web/contracts/trades.ts";
import { ECOSYSTEM_LIST_COINS } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { readablePrice } from "#web/lib/market-format.ts";
import { useQuoteUsd } from "../../prices/use-quote-usd";
import { useReportDiscoveryCoins } from "./discovery-preview";
import { CoinsRows, PanelAddButton, RefreshButton } from "./CoinsRows";
import { Switch } from "#web/components/blast-ui/Checkbox.tsx";
import { assetOnScreen, canonicalCoinType, ecosystemSlot, workspaceDiscoverQuery, workspaceViewState } from "./coin-row-model";
import { workspaceScrollOwner } from "./scroll-owner";
import styles from "./CoinsData.module.css";

/** How long typing pauses before Discover searches (one read, not one per keystroke). */
const SEARCH_PAUSE_MS = 250;

function workspaceRead<Data, Key extends readonly unknown[]>(options: {
  queryKey: Key;
  queryFn?: QueryFunction<Data, Key> | SkipToken;
}) {
  const read = options.queryFn;
  if (typeof read !== "function")
    throw new Error("Coins requires an existing Home read.");
  return (context: QueryFunctionContext) =>
    read({ ...context, queryKey: options.queryKey });
}

export function CoinsData() {
  const { snapshot, presentation } = useWorkspace();
  const active =
    presentation.mode_open &&
    presentation.document_visible &&
    !snapshot.data.collapsed &&
    snapshot.data.selected_view === "Coins";
  return active ? <CoinsContent /> : null;
}

function CoinsContent() {
  const { snapshot, dispatch } = useWorkspace();
  const controls = snapshot.data.controls.Coins;
  const id = useId();
  const filters = controls.navigation.expanded_ids.includes("filters");
  const [search, setSearch] = useState("");
  // One search read once typing pauses, not one per keystroke.
  const query = search.trim();
  const term = useDebouncedValue(query, SEARCH_PAUSE_MS);
  // Not a saved source: the full ecosystem list is a look, and any list choice leaves it.
  const [ecosystem, setEcosystem] = useState(false);
  const region = useRef<HTMLDivElement>(null);
  // The lead's button leaves the page as the list opens, so focus moves to the list it opened.
  const showEcosystem = () => {
    setEcosystem(true);
    requestAnimationFrame(() => region.current?.focus({ preventScroll: true }));
  };
  // Blast mode lists every stage; Home's tabs are its own.
  const state = workspaceViewState(controls);
  const change = (next: HomeViewState) => {
    setEcosystem(false);
    dispatch.patchDataControls("Coins", {
      ...controls,
      source: next.source,
      // Blast mode's saved setup keeps the four orders it offers.
      sort: isHomeViewSort(next.sort) ? next.sort : controls.sort,
      window: next.window,
      min_participants: next.minParticipants as 0 | 2 | 5 | 10,
      // The hour is New's alone (Home's tab); a saved setup keeps the Launched ages it offers.
      age: next.age === "1h" ? controls.age : next.age,
      tradable: next.tradable,
      // Left out while off (`setup.ts`).
      known_deployer: next.knownDeployer || undefined,
      page: 1,
      navigation: { ...controls.navigation, scroll_top: 0, anchor: null },
    });
  };
  const listSource = query ? "search" : ecosystem ? "ecosystem" : state.source;
  return (
    <ShowEcosystem.Provider value={showEcosystem}>
      <div className={styles.discoveryControls}>
        <div className={styles.searchRow}>
          <FieldGroup size="sm" className={styles.search}>
            <SearchIcon />
            <TextField size="sm"
              id={`${id}-search`}
              type="search"
              aria-label="Search coins"
              placeholder="Name, ticker or coin type"
              maxLength={200}
              value={search}
              onChange={(event) => setSearch(event.currentTarget.value)}
            />
          </FieldGroup>
          {!query && <FiltersButton
                controls={`${id}-filters`}
                count={ecosystem ? 0 : trayChanges(state)}
                open={filters}
                onToggle={() =>
                  dispatch.patchDataControls("Coins", {
                    ...controls,
                    navigation: {
                      ...controls.navigation,
                      expanded_ids: filters
                        ? controls.navigation.expanded_ids.filter(
                            (id) => id !== "filters",
                          )
                        : [...controls.navigation.expanded_ids, "filters"],
                    },
                  })
                }
              />}
        </div>
        {/* The pills stay through a search (an empty result included): picking one leaves the search for that list. */}
        <DiscoveryCategories searching={!!query} ecosystem={ecosystem} state={state} change={(next) => { setSearch(""); change(next); }} />
        {!query && (
          <>
            {ecosystem ? (
              <p className={styles.rankingNote}>Ecosystem coins</p>
            ) : state.source === "following" && (
              <p className={styles.rankingNote}>{SOURCE_LABELS.following} · {state.window}</p>
            )}
            <Collapse id={`${id}-filters`} open={filters}>
              <DiscoveryFilterTray state={state} change={change} ecosystem={ecosystem} showEcosystem={() => setEcosystem(true)} />
            </Collapse>
          </>
        )}
      </div>
      <div
        ref={region}
        tabIndex={-1}
        className={styles.listRegion}
        id={`${id}-${ecosystem ? "ecosystem" : state.source}`}
        role="region"
        aria-label={listSource === "search" ? "Coin search results" : listSource === "ecosystem" ? "Ecosystem coins" : `${SOURCE_LABELS[listSource]} coins`}
      >
        <CoinListResults
          source={listSource}
          term={term}
          controls={controls}
          state={state}
          browse={() => change({ ...state, source: "discover", sort: "trending" })}
        />
      </div>
    </ShowEcosystem.Provider>
  );
}

function CoinListResults({ source, term, controls, state, browse }: Readonly<{
  source: HomeViewState["source"] | "search" | "ecosystem";
  term: string;
  controls: DataControls["Coins"];
  state: HomeViewState;
  browse: () => void;
}>) {
  if (source === "search") {
    return term ? <AssetSearch key={term} term={term} /> : <RowsSkeleton label="Searching coins" />;
  }
  if (source === "ecosystem") return <EcosystemCoins rows={controls.rows} />;
  if (source === "discover") return <DiscoverCoins controls={controls} state={state} />;
  return <PersonalCoins controls={controls} browse={browse} />;
}

function DiscoveryFilterTray({ state, change, ecosystem, showEcosystem }: Readonly<{
  state: HomeViewState;
  change: (next: HomeViewState) => void;
  ecosystem: boolean;
  showEcosystem: () => void;
}>) {
  return (
    <div className={styles.filterPanel}>
      <div className={styles.filterRow}>
        <span>Lists</span>
        <MoreCoinLists state={state} change={change} ecosystem={ecosystem} showEcosystem={showEcosystem} />
      </div>
      {!ecosystem && state.source === "discover" && (
        <div className={styles.filterRow}>
          <span>Sort</span>
          <Pick
            label="Sort"
            value={state.sort}
            options={HOME_VIEW_SORTS}
            labels={BLAST_MODE_SORT_LABELS}
            onPick={(sort) => change({ ...state, sort })}
          />
        </div>
      )}
      {!ecosystem && (
        <>
          <div className={styles.filterRow}>
            <span>Window</span>
            <WindowPick state={state} onChange={change} />
          </div>
          <CoinsTools />
          {controlsApply(state.source) && <CoinsFilters state={state} change={change} />}
        </>
      )}
      {!ecosystem && trayChanges(state) > 0 && <Button variant="ghost" size="sm" className={styles.clearFilters} type="button" onClick={() => change({ ...HOME_DEFAULT_VIEW, window: HOME_DEFAULT_WINDOW, source: state.source, sort: state.sort })}>Clear filters</Button>}
    </div>
  );
}

/** Opens the full ecosystem list from the rows that lead Trending and New. */
const ShowEcosystem = createContext<(() => void) | null>(null);

/** How many tray settings differ from the defaults: sort and filters on Discover, and the window everywhere. */
function trayChanges(state: HomeViewState): number {
  const discover = state.source === "discover";
  return (
    (discover ? activeFilterCount(state) : 0) +
    (state.window === HOME_DEFAULT_WINDOW ? 0 : 1)
  );
}

/** One labelled control for secondary lists, ranking settings and active filters. */
function FiltersButton({ controls, count, open, onToggle }: Readonly<{ controls: string; count: number; open: boolean; onToggle: () => void }>) {
  return (
    <IconButton variant="secondary" size="sm"
      aria-controls={controls}
      aria-expanded={open}
      aria-label={count ? `Filters, ${count} active` : "Filters"}
      className={`${styles.iconButton} ${styles.filtersButton}`}
      data-active={count > 0 || undefined}
      onClick={onToggle}
      title="Filters"
      type="button"
    >
      <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinecap="round" strokeWidth="1.9" viewBox="0 0 24 24">
        <path d="M4 7h16M7 12h10M10 17h4" />
      </svg>
    </IconButton>
  );
}

/** A Coins read in this workspace (every source keys its read with this marker last). */
const workspaceCoinsRead = (query: Query) => query.queryKey.at(-1) === "workspace-coins";

/**
 * The Discover filters in the tray's one row layout (live audit F31): a label left, its control right, and the
 * shared switch for the on/off filter. Clear filters below the tray resets them, so there is no second reset here.
 */
function CoinsFilters({ state, change }: Readonly<{ state: HomeViewState; change: (next: HomeViewState) => void }>) {
  return (
    <>
      <div className={styles.filterRow}>
        <span>Participants</span>
        <Pick label="Participants in the window" value={String(state.minParticipants)} options={MIN_PARTICIPANT_CHOICES.map(String)} labels={{ "0": "Any", "2": "2 or more", "5": "5 or more", "10": "10 or more" }} onPick={(value) => change({ ...state, minParticipants: Number(value) })} />
      </div>
      <div className={styles.filterRow}>
        <span>Launched</span>
        <Pick label="Launched" value={state.age} options={HOME_LAUNCHED_AGES} labels={AGE_LABELS} onPick={(age) => change({ ...state, age })} />
      </div>
      <label className={styles.filterRow}>
        <span>Trades in the app only</span>
        <Switch aria-label="Trades in the app only" checked={state.tradable} onCheckedChange={(tradable) => change({ ...state, tradable })} />
      </label>
      <label className={styles.filterRow}>
        <span>Known deployer only</span>
        <Switch aria-label="Known deployer only" checked={state.knownDeployer} onCheckedChange={(knownDeployer) => change({ ...state, knownDeployer })} />
      </label>
    </>
  );
}

/** Live rankings and Refresh prices, in the filter tray: two rows, each a label and its control (the shared switch, a labelled refresh). */
function CoinsTools() {
  const { snapshot, dispatch } = useWorkspace();
  const controls = snapshot.data.controls.Coins;
  const client = useAppQueryClient();
  const fetching = useIsFetching({ predicate: workspaceCoinsRead }, client) > 0;
  return (
    <>
      <label className={styles.filterRow}>
        <span>Live rankings</span>
        <Switch aria-label="Live rankings" checked={controls.live} onCheckedChange={() => dispatch.patchDataControls("Coins", { ...controls, live: !controls.live })} />
      </label>
      <div className={styles.filterRow}>
        <span>Prices</span>
        <RefreshButton busy={fetching} label="Refresh market prices" onRefresh={() => void client.refetchQueries({ predicate: workspaceCoinsRead, type: "active" })} title="Refresh market prices" />
      </div>
    </>
  );
}

export function AssetSearch({ term }: Readonly<{ term: string }>) {
  const [cursor, setCursor] = useState<string | null>(null);
  const read = useQuery(
    {
      queryKey: queryKeys.workspace.assetSearch(term, cursor),
      queryFn: ({ signal }) => fetchListedTradeCoins({ q: term, cursor }, signal),
      retry: false,
    },
    useAppQueryClient(),
  );
  if (!read.data)
    return read.isError ? (
      <LoadFailed onRetry={() => void read.refetch()} retryLabel="Retry search" title="Coin search could not load" />
    ) : (
      <CoinsPending />
    );
  return (
    <div>
      <p className={styles.searchSummary}>
        Trading coins and open presales · all sources
      </p>
      {read.data.coins.length === 0 && (
        <NothingHere title="No matching coins">Try a name, ticker or coin type.</NothingHere>
      )}
      <ol className={styles.list}>
        {read.data.coins.map((coin) => <TradeCoinRow key={coin.coin_type} coin={coin} />)}
      </ol>
      <div className={styles.controls}>
        {cursor && (
          <Button variant="secondary" size="sm"

            type="button"
            onClick={() => setCursor(null)}
          >
            First results
          </Button>
        )}
        {read.data.next_cursor && (
          <Button variant="secondary" size="sm"

            type="button"
            onClick={() => setCursor(read.data!.next_cursor)}
          >
            Next results
          </Button>
        )}
      </div>
    </div>
  );
}

/** One coin outside the ranked list (a search result or a curated ecosystem coin): the whole row is its Add, which opens it in a panel by its coin type (live audit F8). */
function TradeCoinRow({ coin }: Readonly<{ coin: Pick<SocialTradeCoin, "coin_type" | "symbol" | "name" | "icon_url" | "usd_price" | "presale_id" | "in_presale" | "verified_team"> }>) {
  const { snapshot, dispatch } = useWorkspace();
  const identities = useContext(PanelIdentitiesContext);
  const canonical = canonicalCoinType(coin.coin_type);
  const open = assetOnScreen(snapshot, canonical);
  const address = coin.coin_type.split("::")[0]!;
  return (
    <li className={styles.row} data-on-screen={open}>
      <div className={styles.head} data-cols="search">
        <span className={styles.tile}>
          <CoinMark
            coin={{
              key: coin.coin_type,
              coinType: coin.coin_type,
              symbol: coin.symbol,
              iconUrl: coin.icon_url,
              round: true,
            }}
            size={34}
          />
        </span>
        <span className={styles.text}>
          <span className={styles.t1}>
            <strong>{coin.symbol}</strong>
            {coin.verified_team ? <CoinVerifiedMark size="sm" /> : null}
            {coin.name && coin.name !== coin.symbol ? <span className={styles.name}>{coin.name}</span> : null}
          </span>
          <span className={styles.t2}>
            {coin.in_presale ? <span className={styles.reason}>Presale ·</span> : null}
            <InspectValue label="coin type" value={coin.coin_type}>
              {address.slice(0, 6)}…{address.slice(-4)}
            </InspectValue>
          </span>
        </span>
        <span className={styles.figs}>
          {coin.usd_price !== null && (
            <span className={styles.figTop}>
              <InspectValue label="USD price" value={coin.usd_price}>
                ${readablePrice(coin.usd_price)}
              </InspectValue>
            </span>
          )}
        </span>
        <PanelAddButton
          disabled={canonical === null}
          open={open}
          symbol={coin.symbol}
          onAdd={() => {
            // The new panel and the workspace bar show this row's identity while the panel's read loads.
            identities?.report(coin.coin_type, { symbol: coin.symbol, icon: coin.icon_url, name: coin.name });
            const id = dispatch.add({
              panel_id: crypto.randomUUID(),
              chain: "sui",
              network: "mainnet",
              coin_type: coin.coin_type,
              presale_id: coin.presale_id,
            });
            if (!coin.in_presale)
              dispatch.patchPanel(id, { active_namespace: "coin" });
          }}
        />
      </div>
    </li>
  );
}

/** The curated ecosystem coins (`ECOSYSTEM_LIST_COINS`, in `CORE_COINS` order), at most half a page so Blast coins always show, then the way to all of them. They carry no Blast figures, so none are shown. */
function EcosystemRows({ rows }: Readonly<{ rows: number }>) {
  const show = useContext(ShowEcosystem);
  return (
    <>
      {ECOSYSTEM_LIST_COINS.slice(0, Math.floor(rows / 2)).map((coin) => <EcosystemRow key={coin.coinType} coin={coin} usdPrice={null} />)}
      {show && (
        <li className={styles.controls}>
          <Button variant="secondary" size="sm" type="button" onClick={show}>All ecosystem coins</Button>
        </li>
      )}
    </>
  );
}

/** Every curated ecosystem coin, `rows` a page, each with its market price when one is fresh. */
function EcosystemCoins({ rows }: Readonly<{ rows: number }>) {
  const [page, setPage] = useState(1);
  const list = useRef<HTMLOListElement>(null);
  const pages = Math.ceil(ECOSYSTEM_LIST_COINS.length / rows);
  const shown = Math.min(page, pages);
  // A new list or page starts at the top, as the Discover pager does.
  useLayoutEffect(() => {
    const panel = list.current?.closest<HTMLElement>("#workspace-data-panel");
    if (panel) workspaceScrollOwner(panel).scrollTop = 0;
  }, [shown]);
  return (
    <>
      <ol ref={list} className={styles.list}>
        {ECOSYSTEM_LIST_COINS.slice((shown - 1) * rows, shown * rows).map((coin) => <PricedEcosystemRow key={coin.coinType} coin={coin} />)}
      </ol>
      <Pager className={styles.coinsPager} what="coins" page={shown} pages={pages} onPage={setPage} />
    </>
  );
}

function PricedEcosystemRow({ coin }: Readonly<{ coin: (typeof ECOSYSTEM_LIST_COINS)[number] }>) {
  const usdPrice = useQuoteUsd(coin.coinType);
  return <EcosystemRow coin={coin} usdPrice={usdPrice} />;
}

function EcosystemRow({ coin, usdPrice }: Readonly<{ coin: (typeof ECOSYSTEM_LIST_COINS)[number]; usdPrice: string | null }>) {
  return <TradeCoinRow coin={{ coin_type: coin.coinType, symbol: coin.symbol, name: coin.name, icon_url: coin.logoUrl, usd_price: usdPrice, presale_id: null, in_presale: false }} />;
}

function DiscoverCoins({
  controls,
  state,
}: Readonly<{ controls: DataControls["Coins"]; state: HomeViewState }>) {
  const client = useAppQueryClient();
  const { dispatch } = useWorkspace();
  const query = workspaceDiscoverQuery(state, controls.rows);
  const options = discoverQuery(query);
  const read = useQuery<HomeCoinsPage>(
    {
      placeholderData: keepPreviousData,
      retry: options.retry,
      retryDelay: options.retryDelay,
      gcTime: options.gcTime,
      structuralSharing: options.structuralSharing,
      queryKey: queryKeys.workspace.coins(options.queryKey),
      queryFn: workspaceRead(options),
      staleTime: 0,
      refetchOnMount: "always",
    },
    client,
  );
  return (
    <CoinsResult
      controls={controls}
      read={read}
      viewKey={JSON.stringify(query)}
      // Ecosystem coins have no participants, launch time or deployer, so a participant, age or Known deployer filter leaves them out.
      ecosystem={state.minParticipants === 0 && state.age === "all" && !state.knownDeployer}
      empty={<DiscoverEmpty compact onReset={() => dispatch.patchDataControls("Coins", { ...controls, min_participants: 0, age: "all", tradable: false, known_deployer: undefined, page: 1 })} query={query} />}
    />
  );
}

function PersonalCoins({
  controls,
  browse,
}: Readonly<{ controls: DataControls["Coins"]; browse: () => void }>) {
  const viewer = useSocialViewer();
  const { owner } = useWorkspace();
  const run = useShellActions();
  const what =
    controls.source === "following" ? "who you follow" : "your watchlist";
  if (viewer.sessionPending) return <CoinsPending />;
  if (
    owner.kind !== "account" ||
    !viewer.signedIn ||
    !viewer.callsign ||
    !viewer.getAccessToken
  )
    return (
      <EmptyState
        action={<Button onClick={() => run("openSignIn")} size="sm" type="button" variant="secondary">Sign in</Button>}
        compact
        title={`Sign in to see ${what}`}
      />
    );
  return controls.source === "following" ? (
    <FollowingCoins
      controls={controls}
      token={viewer.getAccessToken}
      scope={viewer.callsign}
    />
  ) : (
    <WatchlistCoins controls={controls} browse={browse} />
  );
}

function FollowingCoins({
  controls,
  token,
  scope,
}: Readonly<{
  controls: DataControls["Coins"];
  token: NonNullable<ReturnType<typeof useSocialViewer>["getAccessToken"]>;
  scope: string;
}>) {
  const client = useAppQueryClient();
  const { dispatch } = useWorkspace();
  const options = followingCoinsQuery(
    token,
    scope,
    controls.window,
    controls.page,
    controls.rows,
  );
  const read = useQuery<Extract<HomeFollowingResponse, { mode: "coins" }>>(
    {
      placeholderData: keepPreviousData,
      retry: options.retry,
      retryDelay: options.retryDelay,
      gcTime: options.gcTime,
      structuralSharing: options.structuralSharing,
      queryKey: queryKeys.workspace.coins(options.queryKey),
      queryFn: workspaceRead(options),
      staleTime: 0,
      refetchOnMount: "always",
    },
    client,
  );
  return (
    <CoinsResult
      controls={controls}
      read={read}
      viewKey={`following:${scope}:${controls.window}:${controls.page}:${controls.rows}`}
      empty={<EmptyState
        action={read.data?.following === 0
          ? <Button onClick={() => dispatch.patchDataControls("Coins", { ...controls, source: "discover", page: 1 })} size="sm">Discover coins</Button>
          : controls.window === "1h" ? <Button onClick={() => dispatch.patchDataControls("Coins", { ...controls, window: "24h", page: 1 })} size="sm">View 24 hours</Button> : undefined}
        compact
        role="status"
        title={read.data?.following === 0 ? "You’re not following anyone yet" : "No followed activity in this window"}
      />}
    />
  );
}

function WatchlistCoins({
  controls,
  browse,
}: Readonly<{ controls: DataControls["Coins"]; browse: () => void }>) {
  const snapshot = useWatchlistSnapshot();
  const retry = useWatchlistRetry();
  const client = useAppQueryClient();
  const ids = [...snapshot.ids].slice(0, HOME_COINS_MAX_IDS);
  const limited = snapshot.ids.size > HOME_COINS_MAX_IDS;
  const options = coinsByIdsQuery(ids, controls.window);
  const read = useQuery<HomeCoinsByIds>(
    {
      retry: options.retry,
      retryDelay: options.retryDelay,
      gcTime: options.gcTime,
      structuralSharing: options.structuralSharing,
      queryKey: queryKeys.workspace.coins(options.queryKey),
      queryFn: workspaceRead(options),
      staleTime: 0,
      refetchOnMount: "always",
      enabled: snapshot.status === "ready" && ids.length > 0,
    },
    client,
  );
  if (snapshot.status === "error")
    return (
      <LoadFailed onRetry={retry} title="Your watchlist could not load" />
    );
  if (snapshot.status !== "ready") return <CoinsPending />;
  if (!ids.length)
    return <EmptyState compact role="status" title="No saved coins" action={<Button variant="ghost" size="sm" type="button" onClick={browse}>Browse coins</Button>}>Save a coin to find it here.</EmptyState>;
  const pages = Math.max(
    1,
    Math.ceil((read.data?.coins.length ?? 0) / controls.rows),
  );
  const page = Math.min(controls.page, pages);
  const data = read.data
    ? {
        ...read.data,
        coins: read.data.coins.slice(
          (page - 1) * controls.rows,
          page * controls.rows,
        ),
        page,
        pages,
        total: read.data.coins.length,
        next_cursor: null,
      }
    : undefined;
  return (
    <>
      {limited && (
        <p className={styles.note}>
          Showing your {HOME_COINS_MAX_IDS} most recently saved. Older saved
          sales are on the presales page’s Watchlist.
        </p>
      )}
      <CoinsResult
        controls={controls}
        read={{ data, isError: read.isError, isFetching: read.isFetching, isPlaceholderData: read.isPlaceholderData, refetch: read.refetch }}
        viewKey={`watchlist:${controls.window}:${page}:${controls.rows}`}
        empty={<EmptyState compact role="status" title={limited
          ? `No available coins among your ${HOME_COINS_MAX_IDS} most recently saved`
          : "No available coins in your watchlist"} />}
      />
      {read.data?.missing.map((id) => (
        <p key={id}>
          Saved asset unavailable. <span className={styles.visuallyHidden}>{id}</span>
        </p>
      ))}
    </>
  );
}

type CoinsRead = Pick<
  UseQueryResult<HomeCoinsPage>,
  "data" | "isError" | "isFetching" | "isPlaceholderData"
> & { refetch: (options?: { cancelRefetch?: boolean }) => Promise<unknown> };
function CoinsResult({
  controls,
  read,
  viewKey,
  empty,
  ecosystem = false,
}: Readonly<{
  controls: DataControls["Coins"];
  read: CoinsRead;
  viewKey: string;
  empty: ReactNode;
  /** Discover: Trending and New also list the curated ecosystem coins (`ecosystemSlot`). */
  ecosystem?: boolean;
}>) {
  const { dispatch } = useWorkspace();
  const refetch = read.refetch;
  useEffect(() => {
    const gate = hintedGap(NEW_POSTS_MIN_GAP_MS, browserGapTimers(), () => {
      void refetch({ cancelRefetch: false });
    });
    const off = liveFreshness("workspace-coins").subscribe((hint) => {
      if (gate.admit(hint)) void refetch({ cancelRefetch: false });
    });
    return () => {
      off();
      gate.cancel();
    };
  }, [refetch]);
  useEffect(() => {
    if (!read.isPlaceholderData && read.data && controls.page > read.data.pages)
      dispatch.patchDataControls("Coins", {
        ...controls,
        page: read.data.pages,
      });
  }, [controls, dispatch, read.data, read.isPlaceholderData]);
  if (!read.data)
    return read.isError ? (
      <LoadFailed onRetry={() => void refetch()} title="Coins could not load" />
    ) : (
      <CoinsPending />
    );
  // A placeholder page belongs to another sort or page, so it places no ecosystem rows.
  const slot = ecosystem && !read.isPlaceholderData ? ecosystemSlot(controls.sort, read.data, controls.rows, read.data.coins.length) : null;
  if (read.data.coins.length === 0 && slot === null) {
    if (read.isPlaceholderData) return <CoinsPending />;
    if (read.isError) return <LoadFailed onRetry={() => void refetch()} title="Coins could not load" />;
    return empty;
  }
  return (
    <>
      {read.data.as_of.lag_ms > 60_000 && <DelayedNote />}
      {read.isError && (
        <RefreshFailed onRetry={() => void refetch()} title="Coins could not refresh" />
      )}
      <RankedCoins
        key={`${viewKey}:${read.isPlaceholderData}`}
        coins={read.data.coins}
        preview={!read.isPlaceholderData}
        nowMs={read.data.clock_ms}
        slot={slot}
      />
      <Pager
        className={styles.coinsPager}
        what="coins"
        page={controls.page}
        pages={read.data.pages}
        onPage={(page) =>
          dispatch.patchDataControls("Coins", {
            ...controls,
            page,
            navigation: { ...controls.navigation, scroll_top: 0, anchor: null },
          })
        }
      />
    </>
  );
}

function CoinsPending() {
  return (
    <RowsSkeleton label="Loading coins" />
  );
}

function RankedCoins({
  coins,
  nowMs,
  preview,
  slot,
}: Readonly<{ coins: readonly HomeCoin[]; nowMs: number; preview: boolean; /** Where the ecosystem rows go in `coins` (`ecosystemSlot`), or null. */ slot: number | null }>) {
  const { snapshot } = useWorkspace();
  const identities = useContext(PanelIdentitiesContext);
  useEffect(() => {
    for (const coin of coins) identities?.report(coin.coin_type, { symbol: coin.symbol, icon: coin.icon_url, name: coin.name });
  }, [coins, identities]);
  const live = snapshot.data.controls.Coins.live;
  // The held order keeps its ecosystem slot, so a refresh under the pointer moves no row.
  const [held, setHeld] = useState({ order: coins, slot });
  const [interaction, setInteraction] = useState({
    pointer: false,
    focus: false,
  });
  const updating = live && !interaction.pointer && !interaction.focus;
  const hold = (kind: "pointer" | "focus", value: boolean) =>
    setInteraction((previous) => ({ ...previous, [kind]: value }));
  const shown = updating
    ? coins
    : held.order.map(
        (previous) =>
          coins.find((coin) => coin.coin_type === previous.coin_type) ??
          previous,
      );
  useReportDiscoveryCoins("Coins", shown, preview);
  const at = updating ? slot : held.slot;
  if (updating && (held.order !== coins || held.slot !== slot)) setHeld({ order: coins, slot });
  return (
    <>
      {!live && (
        <div className={`${styles.controls} ${styles.paused}`}>
          <span className={styles.note}>Ranking paused</span>
          <Button variant="secondary" size="sm"

            type="button"
            onClick={() => setHeld({ order: coins, slot })}
          >
            Update ranking
          </Button>
        </div>
      )}
      <div
        onPointerEnter={(event) => {
          if (event.pointerType !== "touch") hold("pointer", true);
        }}
        onPointerLeave={() => hold("pointer", false)}
        onPointerDown={() => hold("pointer", true)}
        onPointerUp={(event) => {
          if (event.pointerType === "touch") hold("pointer", false);
        }}
        onPointerCancel={() => hold("pointer", false)}
        onFocusCapture={() => hold("focus", true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget))
            hold("focus", false);
        }}
      >
        <CoinsRows coins={shown} nowMs={nowMs} insert={at === null ? undefined : { at: Math.min(at, shown.length), rows: <EcosystemRows rows={snapshot.data.controls.Coins.rows} /> }} />
      </div>
    </>
  );
}

type DiscoveryChoicesProps = Readonly<{ state: HomeViewState; change: (next: HomeViewState) => void; ecosystem: boolean }>;
/** Search spans every source, so while it runs no pill reads as the shown list. */
function DiscoveryCategories({ searching, state, change, ecosystem }: DiscoveryChoicesProps & Readonly<{ searching: boolean }>) {
  const shown = !searching && !ecosystem;
  return (
            <div className={styles.categories} role="group" aria-label="Discover coins">
              <Button variant="segment" size="xs" type="button" aria-pressed={shown && state.source === "discover" && state.sort === "trending"} onClick={() => change({ ...state, source: "discover", sort: "trending" })}>Trending</Button>
              <Button variant="segment" size="xs" type="button" aria-pressed={shown && state.source === "discover" && state.sort === "newest"} onClick={() => change({ ...state, source: "discover", sort: "newest" })}>New</Button>
              <Button variant="segment" size="xs" type="button" aria-pressed={shown && state.source === "watchlist"} onClick={() => change({ ...state, source: "watchlist" })}>Saved</Button>
            </div>
  );
}
function MoreCoinLists({ state, change, ecosystem, showEcosystem }: DiscoveryChoicesProps & Readonly<{ showEcosystem: () => void }>) {
  const current = ecosystem ? "ecosystem" : state.source === "following" ? "following" : state.source === "discover" && state.sort === "relevant" ? "relevant" : "more";
  return (
              <Pick
                label="More coin lists"
                value={current}
                options={["more", "following", "relevant", "ecosystem"] as const}
                labels={{ more: "All", following: "Following", relevant: "Relevant", ecosystem: "Ecosystem" }}
                onPick={(value) => {
                  // The menu reports a pick of the checked option too; it changes nothing.
                  if (value === current) return;
                  if (value === "ecosystem") showEcosystem();
                  // All returns to the tabs' list: Saved stays Saved, Following and Relevant go back to Trending.
                  else if (value === "more") change({ ...state, source: state.source === "following" ? "discover" : state.source, sort: state.sort === "relevant" ? "trending" : state.sort });
                  else change({ ...state, source: value === "following" ? "following" : "discover", ...(value === "relevant" ? { sort: "relevant" } : {}) });
                }}
              />
  );
}
