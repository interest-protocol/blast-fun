"use client";

import { hoverExcerpt } from "#web/lib/hover-text.ts";

import { coinPagePath } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { pollInterval } from "#web/lib/query/polling.ts";
import { useDebouncedValue } from "#web/lib/use-debounced-value.ts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button, ButtonLink, IconButton } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { ListsLate } from "#web/components/blast-ui/ServiceStatus.tsx";
import { useListsLate } from "#web/components/blast-ui/service-status.ts";
import { LAUNCH_PATH } from "#web/components/blast-ui/nav.ts";
import { updateSavedList, useListRestoration } from "#web/components/blast-ui/list-restoration.ts";
import { IntentLink } from "#web/components/blast-ui/NavigationLink.tsx";
import { PageHeader } from "#web/components/blast-ui/PageHeader.tsx";
import { Pager } from "#web/components/blast-ui/Pager.tsx";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import { usePhoneLayout } from "#web/components/blast-ui/use-shell-prefs.ts";
import { Segmented } from "#web/components/blast-ui/Segmented.tsx";
import {
  SkeletonBox,
  SkeletonRows,
  SkeletonText,
} from "#web/components/blast-ui/Skeleton.tsx";
import {
  FieldGroup,
  TextField,
  SelectField,
} from "#web/components/blast-ui/TextField.tsx";
import { CoinVerifiedMark, FilterIcon, SearchIcon } from "#web/components/blast-ui/Icons.tsx";
import { useSocialAccount } from "../use-social-account.ts";
import { useSocialViewer, useSignInGate } from "../SignInGate.tsx";
import {
  normalizeBondingSearch,
  type BondingSort,
} from "@blast/core/modules/launchpad-discovery/bonding.ts";
import {
  bondingCatalogQuery,
  bondingFeaturedQuery,
  pageOf,
  readMyBondingLaunches,
} from "./bonding-client.ts";
import {
  compactQuoteAmount,
  quoteSymbol,
} from "#web/components/launchpad/discovery/discovery-model.ts";
import { shortCoinType } from "../coins/coin-display.ts";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { useSeededQuery } from "#web/lib/query/seed.ts";
import { ago } from "@blast/core/web/format.ts";
import { bpsPercent } from "@blast/core/lib/bps.ts";
import type {
  DiscoveryMetrics,
  DiscoveryResponse,
  DiscoveryRow,
  DiscoveryViewName,
} from "@blast/core/modules/launchpad-discovery/rows.ts";

import { FeaturedCarousel } from "#web/components/presale-pages/FeaturedCarousel.tsx";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import type { BondingHeroSeed } from "#web/lib/backend-api/bonding.ts";
import styles from "./bonding.module.css";
import { FeaturedCurve, MarketMetrics } from "./FeaturedCurve.tsx";

type Tab = "bonding" | "graduated" | "mine";
type CatalogPosition = Readonly<{ scope: string; cursors: readonly (string | null)[]; page: number }>;
type CatalogView = Readonly<{
  tab: Tab;
  sort: BondingSort;
  search: string;
  wallet: string;
  position: CatalogPosition | null;
}>;
type CatalogPagination = Readonly<{
  position: CatalogPosition | null;
  setPosition: (position: CatalogPosition) => void;
}>;
const FIRST_PAGE = { cursors: [null], page: 1 } as const;
const TABS = [
  ["bonding", "Live"],
  ["graduated", "Graduated"],
  ["mine", "My launches"],
] as const;
const EMPTY: Readonly<Record<Tab, string>> = {
  bonding: "No bonding curves yet",
  graduated: "No curve has graduated yet",
  mine: "No launches for this wallet yet",
};

function updateCatalogView(view: CatalogView, changes: Partial<CatalogView>): CatalogView {
  const next = { ...view, ...changes };
  const selectionChanged = next.tab !== view.tab || next.sort !== view.sort || next.wallet !== view.wallet ||
    normalizeBondingSearch(next.search) !== normalizeBondingSearch(view.search);
  return selectionChanged ? { ...next, position: null } : next;
}

/** Restored cursors belong only to the search, order, stage and wallet that produced them. */
function useBondingCatalogView() {
  const [view, setView] = useState<CatalogView>({
    tab: "bonding", sort: "progress", search: "", wallet: "", position: null,
  });
  const normalized = normalizeBondingSearch(view.search);
  const settled = useDebouncedValue(normalized ?? "", 300);
  const viewer = useSocialViewer();
  const account = useSocialAccount();
  const addresses =
    viewer.signedIn && account.status === "ready"
      ? (account.account?.wallets.map((w) => w.address) ?? [])
      : [];
  const address = addresses.includes(view.wallet) ? view.wallet : (addresses[0] ?? "");
  const listIdentity = `bonding:${viewer.callsign ?? "public"}`;
  const listRoot = useListRestoration(listIdentity, view, setView);
  function changeView(changes: Partial<CatalogView>) {
    const next = updateCatalogView(view, changes);
    updateSavedList(listIdentity, next, listRoot.current);
    setView(next);
  }
  return { view, normalized, settled, addresses, address, listRoot, changeView };
}

/** Use the server's featured curves in the first paint when available. */
export function BondingScreen({ hero }: Readonly<{ hero?: BondingHeroSeed | null }> = {}) {
  const { view, normalized, settled, addresses, address, listRoot, changeView } = useBondingCatalogView();
  const { tab, sort, search, position } = view;
  const phone = usePhoneLayout();
  const client = useAppQueryClient();
  const featured = useSeededQuery(
    {
      ...bondingFeaturedQuery(),
      refetchInterval: (query) => pollInterval(15_000, query),
    },
    hero?.answer,
    hero?.nowMs ?? 0,
    client,
  );
  const heroes = pageOf(featured.data)?.rows ?? [];
  // The Live list's first page ids, shared with CatalogResults through the cache: an empty or failed
  // list drops its sort, while a pending one keeps it so it never pops in.
  const liveHasRows = useQuery(
    {
      ...bondingCatalogQuery("bonding", sort, settled, null),
      enabled: tab === "bonding" && normalized !== null,
      select: (answer) => pageOf(answer)?.rows.map((row) => row.launchId) ?? [],
    },
    client,
  );
  function viewBonding() {
    changeView({ search: "", tab: "bonding" });
  }
  const feature = tab === "bonding" && !search.trim() ? <FeaturedCurves key="featured" heroes={heroes} answer={featured.data} details={hero?.details} /> : null;
  // A coin in the carousel above is not listed again below it.
  const shownAbove = feature && heroes.length > 0 ? new Set(heroes.map((row) => row.launchId)) : undefined;
  // A list left with only carousel coins has nothing to arrange.
  const showSort = tab === "bonding" && normalized !== null && (liveHasRows.data ? liveHasRows.data.some((id) => !shownAbove?.has(id)) : liveHasRows.isFetching);
  const controls = <BondingControls
    key="catalog-controls"
    tab={tab}
    search={search}
    sort={showSort ? sort : undefined}
    wallet={address}
    addresses={addresses}
    setTab={(next) => changeView({ tab: next })}
    setSearch={(next) => changeView({ search: next })}
    setSort={(next) => changeView({ sort: next })}
    setWallet={(next) => { if (next !== address) changeView({ wallet: next }); }}
  />;
  return (
    <div className={styles.page} ref={listRoot}>
      <PageHeader title="Bonding" />
      {phone ? [controls, feature] : [feature, controls]}
      <div aria-busy={settled !== normalized || undefined}>
        <BondingViewResults
          address={address}
          featured={shownAbove}
          search={settled}
          searchValid={normalized !== null}
          onViewBonding={heroes.length > 0 ? viewBonding : undefined}
          pagination={{ position, setPosition: (next) => changeView({ position: next }) }}
          sort={sort}
          tab={tab}
        />
      </div>
    </div>
  );
}

function BondingViewResults({ address, featured, search, searchValid, onViewBonding, pagination, sort, tab }: Readonly<{
  address: string;
  featured?: ReadonlySet<string>;
  search: string;
  searchValid: boolean;
  onViewBonding?: () => void;
  pagination: CatalogPagination;
  sort: BondingSort;
  tab: Tab;
}>) {
  if (!searchValid) return <EmptyState framed title="Search is too long">Use up to 128 bytes for a name, ticker or address.</EmptyState>;
  if (tab === "mine") return <MyLaunches address={address} pagination={pagination} search={search} />;
  const activeSort = tab === "bonding" ? sort : "newest";
  return <CatalogResults
    featured={tab === "bonding" ? featured : undefined}
    pagination={pagination}
    search={search}
    onViewBonding={tab === "graduated" ? onViewBonding : undefined}
    sort={activeSort}
    tab={tab}
  />;
}

function FeaturedCurves({ heroes, answer, details }: Readonly<{
  heroes: readonly DiscoveryRow[];
  answer: DiscoveryResponse | undefined;
  details?: BondingHeroSeed["details"];
}>) {
  if (heroes.length === 0) return null;
  return <section aria-label="Selected bonding curves">
    <FeaturedCarousel kind="bonding curves">
      {heroes.map(hero => <FeaturedCurve key={hero.launchId} row={hero} featured={answer?.featured === true} metrics={answer?.metrics?.[hero.launchId]} seed={details?.[hero.launchId]} />)}
    </FeaturedCarousel>
  </section>;
}

function CurveSort({ sort, onSort }: Readonly<{ sort: BondingSort; onSort: (sort: BondingSort) => void }>) {
  const field = <SelectField aria-label="Sort bonding curves" value={sort} onChange={(event) => onSort(event.target.value as BondingSort)}>
    <option value="progress">Closest to graduation</option>
    <option value="newest">Newest</option>
  </SelectField>;
  if (!usePhoneLayout()) return field;

  return <Popover.Root>
    <Popover.Trigger render={<IconButton aria-label="Filters" size="touch" variant="secondary"><FilterIcon /></IconButton>} />
    <PopoverSurface positioner={{ align: "end", sideOffset: 8, className: styles.filterLayer }} popup={{ className: styles.sortPopup }}>
      <Popover.Title>Sort by</Popover.Title>
      {field}
    </PopoverSurface>
  </Popover.Root>;
}

function BondingControls({
  tab,
  search,
  sort,
  wallet,
  addresses,
  setTab,
  setSearch,
  setSort,
  setWallet,
}: Readonly<{
  tab: Tab;
  search: string;
  /** Live's order; left out on other tabs and when the Live list has no rows. */
  sort?: BondingSort;
  wallet: string;
  addresses: readonly string[];
  setTab: (tab: Tab) => void;
  setSearch: (search: string) => void;
  setSort: (sort: BondingSort) => void;
  setWallet: (wallet: string) => void;
}>) {
  return (
    <div className={styles.controls}>
      <Segmented
        label="Curve stage"
        options={TABS}
        value={tab}
        onChange={setTab}
      />
      <FieldGroup className={styles.search} size="md">
        <SearchIcon />
        <TextField
          aria-label="Search bonding curves"
          placeholder="Search coins"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </FieldGroup>
      {sort ? <CurveSort sort={sort} onSort={setSort} /> : null}
      {tab === "mine" && addresses.length > 1 ? (
        <SelectField
          aria-label="Launch wallet"
          value={wallet}
          onChange={(event) => setWallet(event.target.value)}
        >
          {addresses.map((value) => (
            <option key={value} value={value}>
              {value.slice(0, 8)}…{value.slice(-6)}
            </option>
          ))}
        </SelectField>
      ) : null}
    </div>
  );
}

function MyLaunches({
  address,
  pagination,
  search,
}: Readonly<{ address: string; pagination: CatalogPagination; search: string }>) {
  const viewer = useSocialViewer();
  const account = useSocialAccount();
  const gate = useSignInGate();
  if (
    viewer.sessionPending ||
    (viewer.signedIn && account.status === "loading")
  )
    return <CardsSkeleton />;
  if (!viewer.signedIn || account.status === "signed_out")
    return (
      <EmptyState
        framed
        title="Sign in to see your launches"
        action={
          <ButtonLink
            href={gate.signInHref}
            onClick={gate.openSignIn}
            prefetch={false}
            variant="primary"
          >
            Sign in
          </ButtonLink>
        }
      >
        Your launches appear for the wallets linked to your account.
      </EmptyState>
    );
  if (account.status === "error")
    return (
      <EmptyState
        framed
        role="alert"
        title="Your wallets couldn’t load"
        action={
          <Button onClick={account.refresh} size="sm">
            Try again
          </Button>
        }
      >
        Try reading your account again.
      </EmptyState>
    );
  if (!address)
    return (
      <EmptyState
        framed
        title="No wallet linked"
        action={
          <ButtonLink href="/settings" size="sm">
            Link a wallet
          </ButtonLink>
        }
      >
        Link a wallet to see the coins you created.
      </EmptyState>
    );
  return (
    <CatalogResults
      pagination={pagination}
      address={address}
      ownerScope={JSON.stringify([
        account.account?.account_id,
        viewer.sessionIdentity,
      ])}
      search={search}
      sort="newest"
      tab="mine"
    />
  );
}

function CatalogResults({
  address,
  featured,
  ownerScope,
  onViewBonding,
  pagination: { position, setPosition },
  search,
  sort,
  tab,
}: Readonly<{
  address?: string;
  /** Launch ids already shown in the carousel above, left out of this list. */
  featured?: ReadonlySet<string>;
  ownerScope?: string;
  onViewBonding?: () => void;
  pagination: CatalogPagination;
  search: string;
  sort: BondingSort;
  tab: Tab;
}>) {
  const scope = JSON.stringify([tab, sort, search, address, ownerScope]);
  const paging = position?.scope === scope ? position : FIRST_PAGE;
  const viewer = useSocialViewer();
  const cursor = paging.cursors[paging.page - 1] ?? null;
  const client = useAppQueryClient();
  const read = useQuery(
    address
      ? {
          queryKey: ["blast", "me", "bonding-wallet", ownerScope, address, search, cursor],
          queryFn: ({ signal }) =>
            readMyBondingLaunches(address, search, cursor, viewer.getAccessToken, signal),
          retry: false,
          staleTime: 15_000,
        }
      : bondingCatalogQuery(tab === "graduated" ? "graduated" : "bonding", sort, search, cursor),
    client,
  );
  const nextCursor = pageOf(read.data)?.nextCursor ?? null;
  const selectPage = (next: number) => {
    if (
      read.isFetching ||
      next < 1 ||
      next > paging.page + 1 ||
      (next > paging.page && !nextCursor)
    )
      return;
    const cursors = [...paging.cursors];
    if (next > paging.page) cursors[next - 1] = nextCursor;
    setPosition({ scope, cursors, page: next });
  };
  return (
    <>
      <BondingResults
        answer={read.data}
        error={read.isError}
        featured={featured}
        nowMs={read.dataUpdatedAt}
        onRetry={() => void read.refetch()}
        onViewBonding={onViewBonding}
        pending={read.isFetching}
        tab={tab}
        search={search}
      />
      {read.data ? (
        <Pager
          hasMore={nextCursor !== null}
          onPage={selectPage}
          page={paging.page}
          pending={read.isFetching}
          what="bonding curves"
        />
      ) : null}
    </>
  );
}

function BondingResults({
  answer,
  error,
  featured,
  nowMs,
  onRetry,
  onViewBonding,
  pending,
  tab,
  search,
}: Readonly<{
  answer: DiscoveryResponse | undefined;
  error: boolean;
  featured?: ReadonlySet<string>;
  nowMs: number;
  onRetry: () => void;
  onViewBonding?: () => void;
  pending: boolean;
  tab: Tab;
  search: string;
}>) {
  const late = useListsLate();
  // While lists are late, a failed read or an empty catalog says so once, instead of "none yet".
  // A search with no match and an empty "My launches" stay as they are: the person narrowed those.
  if (late && listsCannotAnswer(answer, error, search, tab)) return <ListsLate />;
  if (!answer && error)
    return (
      <EmptyState
        action={
          <Button onClick={onRetry} size="sm">
            Try again
          </Button>
        }
        framed
        role="alert"
        title={tab === "mine" ? "Your launches couldn’t load" : "Bonding curves couldn’t load"}
      >
        The launchpad did not answer. Try again in a moment.
      </EmptyState>
    );
  if (!answer) return <CardsSkeleton />;
  const page = pageOf(answer);
  if (!page || page.rows.length === 0) return <EmptyBondingResults onViewBonding={onViewBonding} search={search} tab={tab} />;
  const rows = featured ? page.rows.filter((row) => !featured.has(row.launchId)) : page.rows;
  // Every curve on this page is in the carousel above: nothing to list twice.
  if (rows.length === 0) return null;
  const label = TABS.find(([key]) => key === tab)?.[1] ?? "Live";
  return (
    <>
      {answer.section.state === "stale" ? (
        <p className={styles.note} role="status">
          Showing the last loaded curves. The launchpad is catching up.
        </p>
      ) : null}
      <ol
        aria-busy={pending || undefined}
        aria-label={
          tab === "bonding" ? "Bonding curves" : `${label} bonding curves`
        }
        className={styles.grid}
      >
        {rows.map((row) => (
          <BondingCard
            key={row.launchId}
            metrics={answer.metrics?.[row.launchId]}
            nowMs={nowMs}
            row={row}
            view={tab === "graduated" ? "graduated" : "new"}
          />
        ))}
      </ol>
    </>
  );
}

function listsCannotAnswer(answer: DiscoveryResponse | undefined, error: boolean, search: string, tab: Tab): boolean {
  return !pageOf(answer)?.rows.length && (error || (answer !== undefined && !search && tab !== "mine"));
}

function EmptyBondingResults({ onViewBonding, search, tab }: Readonly<{
  onViewBonding?: () => void;
  search: string;
  tab: Tab;
}>) {
  // The empty curve list is the one place that offers a launch: the shell's Create already does elsewhere.
  const launch = tab === "bonding" && !search ? <ButtonLink href={LAUNCH_PATH} size="sm" variant="primary">Launch a coin</ButtonLink> : undefined;
  return <EmptyState
    action={onViewBonding && !search ? <Button onClick={onViewBonding} size="sm">View bonding coins</Button> : launch}
    framed
    title={search ? "No matching curves" : EMPTY[tab]}
  />;
}

/** `/bonding` while the server reads its featured curves: the header holds its place, so a click on Bonding shows at once. */
export function BondingLoading() {
  return (
    <div className={styles.page} aria-busy="true" data-route-loading="bonding">
      <PageHeader title="Bonding" />
      <div className={styles.loadingTop}>
        <SkeletonBox className={styles.featuredSkeleton} />
        <SkeletonBox className={styles.controlsSkeleton} />
      </div>
      <CardsSkeleton />
    </div>
  );
}

function CardsSkeleton() {
  return (
    <SkeletonRows
      className={styles.grid}
      count={6}
      label="Loading bonding curves"
      rowClassName={styles.card}
    >
      <span className={styles.head}>
        <SkeletonBox className={styles.mark} />
        <span className={styles.title}>
          <b>
            <SkeletonText>Coin name</SkeletonText>
          </b>
          <span>
            <SkeletonText>$TICKER · 2h</SkeletonText>
          </span>
        </span>
      </span>
      <span className={styles.meter}>
        <SkeletonText>0 of 8,000 SUI</SkeletonText>
      </span>
    </SkeletonRows>
  );
}

function BondingCard({
  row,
  metrics,
  view,
  nowMs,
}: Readonly<{
  row: DiscoveryRow;
  metrics?: DiscoveryMetrics;
  view: DiscoveryViewName;
  nowMs: number;
}>) {
  const title = row.name ?? row.symbol ?? shortCoinType(row.coinType);
  const age = ago(
    view === "graduated" && row.graduatedAtMs !== null
      ? row.graduatedAtMs
      : row.createdAtMs,
    nowMs,
  );
  return (
    <li data-list-row={row.launchId}>
      <IntentLink
        className={styles.card}
        href={coinPagePath(row.coinType)}
      >
        <span className={styles.head}>
          <CoinMark
            coin={{
              key: row.coinType,
              coinType: row.coinType,
              symbol: row.symbol ?? undefined,
              iconUrl: row.iconUrl,
              round: false,
            }}
            size={44}
          />
          <span className={styles.title}>
            <b title={row.name ? hoverExcerpt(row.name) : undefined}>{row.verifiedTeam ? <span className="coinNamed"><span className="nm">{title}</span><CoinVerifiedMark /></span> : title}</b>
            <span>
              {row.symbol ? `$${row.symbol} · ` : ""}
              {view === "graduated" ? `graduated ${age}` : age}
            </span>
          </span>
          <PriceChangeBadge bps={metrics?.market?.change_24h_bps} />
        </span>
        {row.lifecycle !== "migrated" ? <GraduationProgress row={row} /> : null}
        <MarketMetrics className={styles.cardMetrics} metrics={metrics} />
      </IntentLink>
    </li>
  );
}

function PriceChangeBadge({ bps }: Readonly<{ bps?: string | null }>) {
  if (bps == null) return null;
  const change = priceChange(bps);
  return (
    <span className={styles.change}>{change} · 24h</span>
  );
}

function GraduationProgress({ row }: Readonly<{ row: DiscoveryRow }>) {
  const progress = row.progressBps;
  if (progress === null) return null;
  return (
    <span className={styles.meter}>
      <span className={styles.figures}>
        <b className="num">
          {bpsPercent(progress)}
          <span className="sr-only"> to graduation</span>
        </b>
        {row.quoteRemaining !== null ? (
          <span className="num">
            {compactQuoteAmount(row.quoteRemaining, row.quoteDecimals, row.quoteType)}{" "}
            {quoteSymbol(row.quoteType)} to go
          </span>
        ) : null}
      </span>
      <progress
        aria-hidden="true"
        className={styles.bar}
        max={10_000}
        value={progress}
      />
    </span>
  );
}


function priceChange(raw: string): string {
  const bps = BigInt(raw);
  const magnitude = bps < 0n ? -bps : bps;
  return `${bps > 0n ? "+" : bps < 0n ? "−" : ""}${magnitude / 100n}.${String(magnitude % 100n).padStart(2, "0")}%`;
}

