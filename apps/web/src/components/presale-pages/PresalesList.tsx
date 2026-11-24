"use client";

import { hoverExcerpt } from "#web/lib/hover-text.ts";
import { spreadMs } from "#web/lib/query/polling.ts";
import { coreCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { LoadingIndicator } from "#web/components/blast-ui/LoadingIndicator.tsx";
import { Button, ButtonLink } from "#web/components/blast-ui/Button.tsx";
import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import { diagnosticMessage, publicErrorMessage } from "#web/lib/errors.ts";

import { useFeedbackReveal } from "#web/components/blast-ui/feedback-motion.ts";

import type { QueryClient } from "@tanstack/react-query";
import { useHydrated } from "#web/components/ui-libraries/use-hydrated.tsx";
import { IntentLink as Link } from "#web/components/blast-ui/NavigationLink.tsx";
import { redirect } from "next/navigation";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode, type RefObject } from "react";

import { captureLists, savedList, useListRestoration } from "#web/components/blast-ui/list-restoration.ts";
import { PresaleCalendar } from "./PresaleCalendar";
import { BackedPresales } from "./BackedPresales";
export { PresaleCalendar } from "./PresaleCalendar";
import { calendarListQuery } from "./calendar-query";
import type { CalendarRange } from "./calendar-model";
import { FeaturedPresales } from "./FeaturedPresales";
import { eligibleFeatured, featuredVisible, shuffleFeatured } from "./featured-model";
import { useCardRows } from "./card-grid";
import { PresalesControls } from "./PresalesControls";
import { PresaleRowsSkeleton } from "./PresalesSkeleton";
import { wholeCount } from "#web/components/blast-ui/tween-num.ts";
import { TweenNum } from "#web/components/blast-ui/use-tween-num.tsx";
import { featuredPresalesQuery, presaleListQuery, presaleViewerRequestQuery } from "#web/components/social/queries.ts";
import { useSignInGate, useSocialViewer } from "#web/components/social/SignInGate.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import { queryKeys } from "#web/lib/query/keys.ts";
import { loadableOf, useSeededQuery, type Loadable } from "#web/lib/query/seed.ts";
import type { PresaleListStatus, PresaleStatusCounts, SocialPresaleListPage, SocialPresaleSummary, SocialPresaleViewerResponse } from "@blast/core/web/contracts/presales.ts";

import { ProgressBar } from "#web/components/blast-ui/ProgressBar.tsx";
import { PersonAvatar } from "#web/components/social/PersonAvatar.tsx";
import { ArtworkMark } from "#web/components/blast-ui/ArtworkMark.tsx";
import { catalogCountdown, catalogTags, catalogFunding, catalogStatus, catalogTime, searchPresales } from "./catalog-model";
import { PresaleCover } from "./PresaleCover";
import { PresaleSocialProof } from "./PresaleSocialProof";
import { useFundingCue } from "./use-funding-cue";
import { CspStyles } from "./csp-style";
import { cx } from "./cx";
import { PHASE_LABEL, barStage, ended } from "@blast/core/modules/presale/presentation.ts";
import { NO_ACCESS_TOKEN, useNow, useViewerPresales, type ViewerPresales } from "./presales-client";

import { discoverySorts, withDiscoveryScope, discoveryPath, discoveryState, type PresaleResultLayout, type PresaleListView, type PresaleScope, type DiscoveryState } from "./discovery-state";
import { orderWatched } from "./watched-model";
export type { PresaleListView } from "./discovery-state";
export type { PresaleResultLayout } from "./discovery-state";

/**
 * The watchlist (UI-12): the starred sale ids, and (wired pages) whether the
 * viewer is signed in and how to read the starred sales of a tab. Without it
 * the Watchlist toggle is not offered; without `load` it filters the
 * tab's first page (fixtures).
 */
export type PresaleWatchlist = Readonly<{
  ids: ReadonlySet<string>;
  signedIn?: boolean;
  load?: (status: PresaleListStatus) => Promise<Readonly<{ rows: readonly SocialPresaleSummary[]; total: number }> | null>;
}>;

export type PresalesListProps = Readonly<{
  /** The first page the server read; null when it failed. */
  initial: SocialPresaleListPage | null;
  status: PresaleListStatus;
  sort: string;
  scope?: PresaleScope;
  view: PresaleListView;
  layout?: PresaleResultLayout;
  nowMs: number;
  /** The upcoming sales for the calendar, when the server read them. */
  calendar?: SocialPresaleListPage | null;
  /** Live sales read alongside the upcoming calendar page. */
  calendarLive?: SocialPresaleListPage | null;
  calendarEnded?: SocialPresaleListPage | null;
  calendarRange?: CalendarRange;
  watchlist?: PresaleWatchlist;
  featured?: readonly SocialPresaleSummary[] | null;
  featuredEnabled?: boolean;
  initialPinSeed?: string;
}>;

function PresaleWhen({ sale, now }: Readonly<{ sale: SocialPresaleSummary; now: number }>) {
  // A trading or cancelled sale's status chip says where it stands; "Ended" beside it would repeat it.
  if (sale.phase === "trading" || sale.phase === "cancelled") return null;
  return <>{catalogTime(sale, now)}</>;
}

/** A card's time left as the board draws it ("3d 9h"), its label kept for assistive technology. */
function CardWhen({ sale, now }: Readonly<{ sale: SocialPresaleSummary; now: number }>) {
  if (sale.phase === "trading" || sale.phase === "cancelled") return null;
  const { label, value } = catalogCountdown(sale, now);
  return <>{label ? <span className="sr-only">{label} </span> : null}{value}</>;
}

/** Sign in, returning here, as the shared button link; nothing once signed in or while the session is checked. */
function SignInButton() {
  const gate = useSignInGate();
  if (gate.signedIn || gate.sessionPending) return null;
  return <ButtonLink href={gate.signInHref} onClick={gate.openSignIn} prefetch={false} size="sm">Sign in</ButtonLink>;
}

/**
 * The raise in its own coin beside its mark: "{raised} of {target} {QUOTE}" in a row,
 * "{raised} {QUOTE} of {target}" on a card (the board), or the target alone before a sale opens.
 */
function FundingAmounts({ sale, funding, targetOnly = false, card = false }: Readonly<{ sale: SocialPresaleSummary; funding: ReturnType<typeof catalogFunding>; targetOnly?: boolean; card?: boolean }>) {
  const currency = coreCoin(sale.quote_type);
  return <span aria-hidden="true" className={cx("catalog-amount")}>
    <CoinMark coin={{ key: sale.quote_type, coinType: sale.quote_type, iconUrl: currency?.logoUrl ?? null, round: true, symbol: sale.quote_symbol }} size={card ? 18 : 16} />
    <span className={cx("funding-values")}>
      {targetOnly ? <b>{funding.target}</b> : card ? <><b>{funding.committed}</b><span> of {funding.targetAmount}</span></> : <><b>{funding.committedAmount}</b><span> of {funding.targetAmount} {sale.quote_symbol}</span></>}
    </span>
  </span>;
}

/** The sale's bold name, with the verified-coin mark after it when Blast checked the team; the name ellipsises, the mark stays whole. */
function SaleTitle({ sale }: Readonly<{ sale: SocialPresaleSummary }>) {
  if (!sale.verified_team) return <b title={hoverExcerpt(sale.name)}>{sale.name}</b>;
  return <span className={cx("sr-title")}><b title={hoverExcerpt(sale.name)}>{sale.name}</b><CoinVerifiedMark /></span>;
}

/** A list row (`a.card.srow2`): mark, name, when, fill, backers and up to three followed backers. */
export function PresaleRow({ sale, now, viewer, showStatus = false }: Readonly<{ sale: SocialPresaleSummary; now: number; viewer: ViewerPresales | null; showStatus?: boolean }>) {
  const following = viewer?.[sale.presale_id]?.following ?? [];
  const followed = following.slice(0, 3);
  const attribution = following.length === 1
    ? `${following[0].account.display_name ?? following[0].account.callsign} backed`
    : `${following.length} people you follow backed`;
  const funding = catalogFunding(sale);
  const fundingDescriptionId = useId();
  return (
    <Link aria-describedby={fundingDescriptionId} data-list-row={sale.presale_id} className={cx("card srow2")} href={`/presale/${sale.presale_id}`}>
      <ArtworkMark coinType={sale.coin_type} src={sale.icon_url} fallbackId={sale.presale_id} size={40} />
      <span className={cx("sr-name")}>
        <SaleTitle sale={sale} />
        <span>
          <span className={cx("sr-symbol")} title={sale.symbol}>{sale.symbol}</span>
          {showStatus || ended(sale.phase) ? <span className={cx(`status ${sale.phase}`)}>{PHASE_LABEL[sale.phase]}</span> : null}
        </span>
        <span className={cx("sr-tags")}>
          {catalogTags(sale).filter(tag => tag !== "Above target").map(tag => <span className={cx("catalog-tag")} key={tag}>{tag}</span>)}
        </span>
      </span>
      <span className={cx("sr-when")}>
        <PresaleWhen now={now} sale={sale} />
      </span>
      <span className={cx("sr-fill")}>
        {sale.phase === "pending" ? (
          <span className={cx("muted")}>{sale.interested.toLocaleString("en-US")} interested</span>
        ) : (
          <>
            <ProgressBar bar={sale.presale_id} label="Funding target progress" pct={funding.progress} small stage={barStage(sale.phase)} />
            {funding.percentage === null ? null : <span className={cx("num")}>{funding.percentage}</span>}
            {funding.over ? <span className={cx("sr-oversubscribed")}>Above target</span> : null}
          </>
        )}
      </span>
      <span className={cx("sr-back num")}>
        <span hidden id={fundingDescriptionId}>{sale.phase === "pending" ? funding.targetDescription : funding.description}</span>
        <FundingAmounts funding={funding} sale={sale} targetOnly={sale.phase === "pending"} />
        {sale.phase === "pending" ? <span aria-hidden="true">target</span> : <span><TweenNum format={wholeCount} value={sale.participants} /> {sale.participants === 1 ? "backer" : "backers"}</span>}
      </span>
      {followed.length ? (
        <span className={cx("sr-social")}>
          <span aria-hidden="true" className={cx("mini-pile")}>
            {followed.map((row) => <PersonAvatar key={row.account.callsign} person={row.account} size={18} />)}
          </span>
          <span className={cx("sr-social-text")} title={attribution}>{attribution}</span>
        </span>
      ) : null}
    </Link>
  );
}

function CardFunding({ sale, live, descriptionId }: Readonly<{ sale: SocialPresaleSummary; live: boolean; descriptionId: string }>) {
  const funding = catalogFunding(sale);
  const cue = useFundingCue(sale, live);
  if (sale.phase === "pending") return <span className={cx("tile-amount num")}>
    <span hidden id={descriptionId}>{funding.targetDescription}</span>
    <span aria-hidden="true">Target</span>
    <FundingAmounts card funding={funding} sale={sale} targetOnly />
  </span>;
  const percentage = funding.percentage !== null && (
    <span aria-hidden="true" className={cx("funding-percentage")}>{funding.percentage}</span>
  );
  return (
    <>
      <span className={cx("tile-progress")} data-funding-cue={cue?.kind}>
        <ProgressBar bar={sale.presale_id} label="Funding target progress" pct={funding.progress} small smooth={live} stage={barStage(sale.phase)} />
      </span>
      <span className={cx("tile-amount num")}>
        <span hidden id={descriptionId}>{funding.description}</span>
        <FundingAmounts card funding={funding} sale={sale} />
        {live ? (
          <span className={cx("funding-update")}>
            <span role="status">
              {cue && <span key={cue.text} className={cx("funding-cue")} data-tone={cue.kind}>{cue.text}</span>}
            </span>
            {!cue && percentage}
          </span>
        ) : percentage}
      </span>
    </>
  );
}

function CardBackers({ sale }: Readonly<{ sale: SocialPresaleSummary }>) {
  if (sale.phase === "pending" && sale.participants === 0) return null;
  const faces = (sale.backers_sample ?? []).slice(0, 3);
  return <span className={cx("tile-backers num")}>
    {faces.length ? <span aria-hidden="true" className={cx("tile-faces")}>{faces.map(person => <PersonAvatar key={person.callsign} person={person} size={18} />)}</span> : null}
    <span><TweenNum format={wholeCount} value={sale.participants} /> {sale.participants === 1 ? "backer" : "backers"}</span>
  </span>;
}

/**
 * A cover-first card (the Presales board): the 3:1 cover with the coin mark
 * over its edge, name, ticker and time left, the raise's fill, the raise in
 * its own coin with its share of the target, the tag chips, then recent
 * backers' faces and the count. Followed backers sit beside the link, over
 * the backers row's free end (their avatars are buttons).
 */
export function PresaleCard({ sale, now, viewer, showStatus = false }: Readonly<{ sale: SocialPresaleSummary; now: number; viewer: ViewerPresales | null; showStatus?: boolean }>) {
  const following = viewer?.[sale.presale_id]?.following ?? [];
  const fundingDescriptionId = useId();
  const upcoming = sale.phase === "pending";
  const status = showStatus || ended(sale.phase);
  const tags = catalogTags(sale);
  const interested = upcoming && sale.interested > 0;
  return (
    <article data-list-row={sale.presale_id} className={cx("card presale-tile")}>
      <Link aria-describedby={fundingDescriptionId} aria-label={`View ${sale.name} presale`} className={cx("tile-link")} href={`/presale/${sale.presale_id}`}>
        <PresaleCover className={cx("tile-cover")} cover={sale.metadata?.cover} presaleId={sale.presale_id} />
        <span className={cx("tile-identity")}>
          <ArtworkMark coinType={sale.coin_type} src={sale.icon_url} fallbackId={sale.presale_id} size={50} />
          <span className={cx("sr-name")}>
            <SaleTitle sale={sale} />
            <span>${sale.symbol.replace(/^\$/, "")}</span>
          </span>
          <span className={cx("tile-when num")}><CardWhen now={now} sale={sale} /></span>
        </span>
        <CardFunding key={sale.presale_id} sale={sale} live={catalogStatus(sale, now) === "live"} descriptionId={fundingDescriptionId} />
        {status || tags.length || interested ? (
          <span className={cx("tile-tags")}>
            {status ? <span className={cx(`status ${sale.phase}`)}>{PHASE_LABEL[sale.phase]}</span> : null}
            {tags.map(tag => <span className={cx("catalog-tag")} key={tag}>{tag}</span>)}
            {interested ? <span className={cx("catalog-tag")}>{sale.interested.toLocaleString("en-US")} interested</span> : null}
          </span>
        ) : null}
        <CardBackers sale={sale} />
      </Link>
      <div className={cx("tile-social")}>
        <PresaleSocialProof following={following} />
      </div>
    </article>
  );
}

function PresaleResults({ rows, layout, now, viewer, gridRef }: Readonly<{ rows: readonly SocialPresaleSummary[]; layout: PresaleResultLayout; now: number; viewer: ViewerPresales | null; gridRef: (node: HTMLElement | null) => void }>) {
  return <div className={cx(layout === "cards" ? "presale-grid" : "rows2")} ref={layout === "cards" ? gridRef : undefined}>
    {rows.map((sale) => layout === "cards"
      ? <PresaleCard key={sale.presale_id} now={now} sale={sale} viewer={viewer} />
      : <PresaleRow key={sale.presale_id} now={now} sale={sale} viewer={viewer} />)}
  </div>;
}

type Loaded = Readonly<{ rows: readonly SocialPresaleSummary[]; next: string | null; failed: boolean; error?: unknown; watchTotal?: number }>;

/**
 * A fresh first page followed by the pages the visitor had already read. The
 * old rows after the fresh page's last row are the pages that follow it (a row
 * that moved up into the fresh page is dropped from them). Rows that ended
 * drop out of the grid by their status; a row that slipped down from page one
 * waits for the next full read. A new choice or reload replaces the list as before.
 */
function withLaterPages(previous: Loaded, fresh: Loaded): Loaded {
  const last = fresh.rows.at(-1);
  const at = last && fresh.next !== null && !fresh.failed ? previous.rows.findIndex((row) => row.presale_id === last.presale_id) : -1;
  if (at < 0) return fresh;
  const first = new Set(fresh.rows.map((row) => row.presale_id));
  return { ...fresh, rows: [...fresh.rows, ...previous.rows.slice(at + 1).filter((row) => !first.has(row.presale_id))], next: previous.next };
}

type ListQuery = Parameters<typeof presaleListQuery>[0];

/**
 * A list page as a shared query (OA-38): a chip chosen again inside the CDN's
 * 10 s, or the page Blast mode's lanes just read, comes from the cache; null
 * on any failure.
 */
function sharedListPage(client: QueryClient, query: ListQuery): Promise<SocialPresaleListPage | null> {
  return client.fetchQuery(presaleListQuery(query)).catch(() => null);
}

/** The "Following" sort's rows: the viewer read by status, shared the same way; null on any failure. */
function followingRows(client: QueryClient, getAccessToken: () => Promise<string | null>, status: PresaleListStatus): Promise<SocialPresaleViewerResponse | null> {
  return client.fetchQuery(presaleViewerRequestQuery(getAccessToken, { status })).catch(() => null);
}

async function readListRows(
  client: QueryClient,
  viewer: ReturnType<typeof useSocialViewer>,
  { watchlist }: Pick<PresalesListProps, "watchlist">,
  status: PresaleListStatus,
  sort: string,
  scope: PresaleScope,
): Promise<Loaded> {
  if (scope === "following") {
    if (!viewer.signedIn) return { rows: [], next: null, failed: false };
    const answer = await followingRows(client, viewer.getAccessToken ?? NO_ACCESS_TOKEN, status);
    return { rows: orderWatched(answer?.rows ?? [], sort), next: null, failed: answer === null, error: client.getQueryState(presaleViewerRequestQuery(viewer.getAccessToken ?? NO_ACCESS_TOKEN, { status }).queryKey)?.error };
  }
  if (scope === "watch" && watchlist?.load) {
    if (watchlist.signedIn === false) return { rows: [], next: null, failed: false };
    const answer = await watchlist.load(status);
    return { rows: orderWatched(answer?.rows ?? [], sort), watchTotal: answer?.total, next: null, failed: answer === null };
  }
  if (scope === "watch") {
    const query = { status, sort, limit: 50 };
    const page = await sharedListPage(client, query);
    return { rows: (page?.presales ?? []).filter((row) => watchlist?.ids.has(row.presale_id)), watchTotal: savedSaleCount(watchlist?.ids), next: null, failed: page === null, error: client.getQueryState(presaleListQuery(query).queryKey)?.error };
  }
  const page = await sharedListPage(client, { status, sort });
  return { rows: page?.presales ?? [], next: page?.next_cursor ?? null, failed: page === null };
}

/** Overlay the shared first-page query while keeping the list's order and paging. */
function useLivePresaleRows(rows: readonly SocialPresaleSummary[], status: PresaleListStatus, sort: string, props: PresalesListProps, enabled: boolean, scope: PresaleScope) {
  const client = useAppQueryClient();
  const plain = scope === "all";
  const served = plain && status === props.status && sort === props.sort && props.initial ? props.initial : undefined;
  const fresh = useSeededQuery({ ...presaleListQuery({ status, sort }), enabled: enabled && plain }, served, props.nowMs, client);
  return useMemo(() => {
    if (!plain) return { rows, error: null, counts: undefined };
    const byId = new Map(fresh.data?.presales.map((row) => [row.presale_id, row]));
    return { rows: rows.map((row) => byId.get(row.presale_id) ?? row), error: fresh.error, counts: fresh.data?.status_counts };
  }, [fresh.data, fresh.error, rows, plain]);
}

function useFeaturedSales({ featured, featuredEnabled, initialPinSeed = "", nowMs }: PresalesListProps, view: PresaleListView, now: number, client: QueryClient) {
  // Keep the request's order for the lifetime of this page, even across router refreshes.
  const [seed] = useState(() => initialPinSeed);
  const visible = featuredVisible(view);
  const query = useSeededQuery({ ...featuredPresalesQuery(), enabled: featuredEnabled === true && visible }, featured, nowMs, client);
  const sales = visible ? shuffleFeatured(eligibleFeatured(query.data ?? [], now), seed) : [];
  // The hero can show pins outside the catalog's current tab or pages.
  const viewer = useViewerPresales(sales.map(sale => sale.presale_id));
  return { sales, viewer };
}

function catalogRows(
  rows: readonly SocialPresaleSummary[],
  { status, scope, sort }: DiscoveryState,
  now: number,
  featured: readonly SocialPresaleSummary[],
): readonly SocialPresaleSummary[] {
  const inStatus = (sale: SocialPresaleSummary) => catalogStatus(sale, now) === status;
  const matching = rows.filter(inStatus);
  if (scope !== "all" || sort !== "pinned" || featured.length === 0) return matching;

  // The featured read contains every pin. Use richer catalog rows as their pages arrive.
  const byId = new Map(rows.map(sale => [sale.presale_id, sale]));
  const pins = featured.map(sale => byId.get(sale.presale_id) ?? sale).filter(inStatus);
  const pinIds = new Set(pins.map(sale => sale.presale_id));
  return [...pins, ...matching.filter(sale => !pinIds.has(sale.presale_id))];
}

function PresaleReadError({ title, message, onRetry }: Readonly<{ title: string; message: string; onRetry: () => void }>) {
  return <EmptyState action={<Button onClick={onRetry} size="sm">Try again</Button>} framed role="alert" title={title}>{message}</EmptyState>;
}

function EmptyPresales({ scope, status, signedIn, watchTotal, showAllHref, onShowAll, browseAction }: Readonly<{
  scope: PresaleScope;
  status: PresaleListStatus;
  signedIn: boolean;
  watchTotal?: number;
  /** Where "show all" leads, so the in-sentence link is a real place (modified clicks open it). */
  showAllHref: string;
  onShowAll: () => void;
  browseAction?: ReactNode;
}>) {
  if (scope !== "all" && !signedIn) return (
    <EmptyState action={<SignInButton />} framed title={scope === "watch" ? "Your watchlist" : "Presales backed by people you follow"}>
      Sign in to see {scope === "watch" ? "your saved presales" : "these presales"}, or{" "}
      <Link
        className={cx("empty-link")}
        href={showAllHref}
        onClick={(event) => {
          if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onShowAll();
        }}
      >
        show all {status} presales
      </Link>.
    </EmptyState>
  );
  let title = `No ${status} presales`;
  let message: string | null = null;
  if (scope === "following") {
    title = `No ${status} presales backed by people you follow`;
  }
  if (scope === "watch") {
    title = watchTotal === 0 ? "No saved presales yet" : `No ${status} presales in your watchlist`;
    message = watchTotal === 0 ? "Select Add to watchlist on a presale." : null;
  }
  return <EmptyState action={browseAction} framed title={title}>{message}</EmptyState>;
}

function EmptyPresaleSearch({ search, more, onClear }: Readonly<{ search: string; more: boolean; onClear: () => void }>) {
  return (
    <EmptyState
      action={search ? <Button onClick={onClear} size="sm" variant="ghost">Clear search</Button> : null}
      framed
      role="status"
      title={search ? more ? "No matches in loaded presales" : "No matching presales" : "No presales in this view"}
    >
      {more ? "Load more to search further." : null}
    </EmptyState>
  );
}

function PresaleSearchCoverage({ search, matches, count, partial }: Readonly<{ search: string; matches: number; count: number; partial: boolean }>) {
  if (!search) return null;
  return <p className={cx("catalog-search-note")}>
    {matches} {matches === 1 ? "match" : "matches"} in {partial ? `${count} loaded` : `all ${count}`} {count === 1 ? "presale" : "presales"}.
  </p>;
}

function PresaleListContent({ revealFloor, shownCountRef, search, onClearSearch, layout, loaded, loading, rows, catalogCount, error, now, viewer, more, moreFailure, onRetry, onMore, scope, status, signedIn, showAllHref, onShowAll, browseAction }: Readonly<{
  revealFloor: number;
  shownCountRef: RefObject<number>;
  search: string;
  onClearSearch: () => void;
  scope: PresaleScope;
  status: PresaleListStatus;
  signedIn: boolean;
  showAllHref: string;
  onShowAll: () => void;
  browseAction?: ReactNode;
  layout: PresaleResultLayout;
  loaded: Loaded;
  loading: boolean;
  rows: readonly SocialPresaleSummary[];
  catalogCount: number;
  error: unknown;
  now: number;
  viewer: ViewerPresales | null;
  more: boolean;
  moreFailure: string | null;
  onRetry: () => void;
  onMore: () => void;
}>) {
  const hasNext = loaded.next !== null;
  const { gridRef, shown, reveal, canReveal } = useCardRows({ cards: layout === "cards", rows, searching: search !== "", hasNext, more, moreFailed: moreFailure !== null, loading, floor: revealFloor, onMore });
  useLayoutEffect(() => { shownCountRef.current = shown.length; }, [shownCountRef, shown.length]);
  if (loading && loaded.rows.length === 0) {
    return <PresaleRowsSkeleton />;
  }
  if (loaded.failed) {
    return <PresaleReadError title="Presales couldn’t load" message={publicErrorMessage(loaded.error ?? error, "Nothing changed. Check your connection and try again.", "service_unavailable")} onRetry={onRetry} />;
  }
  if ((catalogCount === 0 && !hasNext) || (scope !== "all" && !signedIn)) return <EmptyPresales scope={scope} status={status} signedIn={signedIn} watchTotal={loaded.watchTotal} browseAction={browseAction} onShowAll={onShowAll} showAllHref={showAllHref} />;
  return (
    <>
      {!rows.length ? <EmptyPresaleSearch more={hasNext} onClear={onClearSearch} search={search} /> : <PresaleResults gridRef={gridRef} layout={layout} now={now} rows={shown} viewer={viewer} />}
      <PresaleSearchCoverage search={search} matches={rows.length} count={catalogCount} partial={hasNext || scope !== "all"} />
      {moreFailure && <p className={cx("more-failure")} role="alert">{moreFailure}</p>}
      {canReveal ? (
        <Button className={cx("more")} disabled={more || loading} onClick={reveal}>
          {more ? <LoadingIndicator label="Loading more presales">Show more</LoadingIndicator> : "Show more"}
        </Button>
      ) : null}
    </>
  );
}

function PresaleCalendarContent({ reads, onRetry, now, range, onRange, onBrowse }: Readonly<{
  reads: readonly Loadable<SocialPresaleListPage>[];
  now: number;
  range: CalendarRange;
  onRange: (range: CalendarRange) => void;
  onRetry: () => void;
  onBrowse: () => void;
}>) {
  const error = reads.find((read) => read.status === "error");
  if (error) return <PresaleReadError title="Calendar couldn’t load" message={error.message ?? diagnosticMessage("Check your connection and try again.")} onRetry={onRetry} />;
  const sales = reads.every((read) => read.status === "ready") ? reads.flatMap((read) => read.value.presales) : null;
  return <PresaleCalendar
    browseAction={<Button onClick={onBrowse} size="sm" variant="ghost">Browse presales</Button>}
    now={now}
    onRange={onRange}
    range={range}
    sales={sales}
  />;
}

/** Saved sales only: a saved curve coin's key is its coin type (it holds `::`). */
function savedSaleCount(ids: ReadonlySet<string> | undefined): number | undefined {
  return ids && [...ids].filter((key) => !key.includes("::")).length;
}

function needsViewerRead(scope: PresaleScope, watchlist?: PresaleWatchlist): boolean {
  return scope === "following" || (scope === "watch" && !!watchlist?.load);
}

function initialListRows({ initial, watchlist }: PresalesListProps, { scope, sort }: DiscoveryState): Loaded {
  if (needsViewerRead(scope, watchlist)) return { rows: [], next: null, failed: false };
  if (scope === "watch") return { rows: orderWatched((initial?.presales ?? []).filter((row) => watchlist?.ids.has(row.presale_id)), sort), watchTotal: savedSaleCount(watchlist?.ids), next: null, failed: initial === null };
  return { rows: initial?.presales ?? [], next: initial?.next_cursor ?? null, failed: initial === null };
}

function viewIsBusy(view: PresaleListView, { loading, viewerRead, sessionBusy, calendarBusy }: Readonly<{
  loading: boolean;
  viewerRead: boolean;
  sessionBusy: boolean;
  calendarBusy: boolean;
}>) {
  const busy = {
    list: loading || (viewerRead && sessionBusy),
    calendar: calendarBusy,
    backed: sessionBusy,
  };
  return busy[view];
}

/**
 * The presales list (FEATURE-MAP §9): List or Calendar; Live, Upcoming or
 * Ended; the tab's sorts; dense rows with "Show more" paging (an OA-13
 * addition: keyset pages of 20). The first page comes from the server; other
 * tabs and sorts are read in the browser from the same public route, and the
 * address follows them so a link reopens the same view. "Backed by people
 * you follow" reads the signed-in viewer's own route (a visitor is asked to
 * sign in); "Watchlist" lists the viewer's starred sales of the tab (UI-12;
 * a visitor is asked to sign in), offered only with a watchlist.
 */

export function PresalesList(props: PresalesListProps) {
  const { status: initialStatus, sort: initialSort, view: initialView, nowMs, calendar, watchlist } = props;
  const viewer = useSocialViewer();
  const gate = useSignInGate();
  const now = useNow(nowMs, 15_000);
  const [search, setSearch] = useState("");
  const hydrated = useHydrated();
  const [selection, setSelection] = useState(() => discoveryState({ status: initialStatus, sort: initialSort, scope: props.scope, layout: props.layout, view: initialView, calendarRange: props.calendarRange }));
  const { status, sort, scope, view, layout, calendarRange } = selection;
  const [loaded, setLoaded] = useState(() => initialListRows(props, selection));
  const viewerRead = needsViewerRead(scope, watchlist);
  const [loading, setLoading] = useState(viewerRead);
  const request = useRef<AbortController | null>(null);
  const restored = useRef(false);
  const [more, setMore] = useState(false);
  const [moreFailure, setMoreFailure] = useState<string | null>(null);
  // A page read in flight: the grid fills itself, so two callers in one commit must not both append.
  const paging = useRef<string | null>(null);
  // Cards to keep showing after Back: the number that were shown. Any new read of the list clears it.
  const [revealFloor, setRevealFloor] = useState(0);
  const restorationId = `presales:${viewer.callsign ?? "public"}`;
  const shownCountRef = useRef(0);
  const listRoot = useListRestoration(restorationId, () => ({ selection, loaded, search, revealed: shownCountRef.current }), saved => {
    request.current?.abort();
    restored.current = true;
    setSelection(saved.selection);
    setLoaded(saved.loaded);
    setSearch(saved.search);
    setRevealFloor(saved.revealed ?? 0);
    setLoading(false);
    setMore(false);
    setMoreFailure(null);
  });
  useEffect(() => {
    const rawSort = new URLSearchParams(window.location.search).get("sort");
    if (window.location.pathname === "/presale" && (rawSort === "watch" || rawSort === "following" || rawSort === "fastest")) {
      window.history.replaceState({ blastLists: window.history.state?.blastLists }, "", discoveryPath(discoveryState({ status: initialStatus, sort: initialSort, scope: props.scope, layout: props.layout, view: initialView, calendarRange: props.calendarRange })));
    }
    return () => request.current?.abort();
  }, [initialSort, initialStatus, initialView, props.scope, props.layout, props.calendarRange]);
  function navigate(state: DiscoveryState) {
    const next = discoveryState(state);
    captureLists();
    setSelection(next);
    const path = discoveryPath(next);
    if (window.location.pathname + window.location.search !== path) window.history.pushState(null, "", path);
  }

  const client = useAppQueryClient();
  const calendarQuery = useSeededQuery({ ...calendarListQuery(client, "upcoming"), enabled: view === "calendar" }, calendar, nowMs, client);
  const calendarRead = loadableOf(calendarQuery, view === "calendar");
  const calendarLiveQuery = useSeededQuery({ ...calendarListQuery(client, "live"), enabled: view === "calendar" }, props.calendarLive, nowMs, client);
  const calendarLiveRead = loadableOf(calendarLiveQuery, view === "calendar");
  const calendarEndedQuery = useSeededQuery({ ...calendarListQuery(client, "ended"), enabled: view === "calendar" }, props.calendarEnded, nowMs, client);
  const calendarEndedRead = loadableOf(calendarEndedQuery, view === "calendar");
  const calendarReads = [calendarRead, calendarLiveRead, calendarEndedRead];
  const { sales: featuredSales, viewer: featuredViewer } = useFeaturedSales(props, view, now, client);
  const listPage = (query: ListQuery) => sharedListPage(client, query);

  /** `keepPages`: a timed refresh keeps the pages already read after the fresh first page, so the grid does not re-read them. */
  async function load(nextStatus: PresaleListStatus, nextSort: string, nextScope: PresaleScope, keepPages = false) {
    request.current?.abort();
    if (!keepPages) setRevealFloor(0);
    const apply = (fresh: Loaded) => setLoaded((previous) => keepPages ? withLaterPages(previous, fresh) : fresh);
    const controller = new AbortController();
    request.current = controller;
    const cached = nextScope !== "all" ? undefined : client.getQueryData<SocialPresaleListPage>(presaleListQuery({ status: nextStatus, sort: nextSort }).queryKey);
    if (cached) {
      apply({ rows: cached.presales, next: cached.next_cursor, failed: false });
      setLoading(false);
    } else if (view !== "list" || loaded.failed || nextStatus !== status || nextSort !== sort || nextScope !== scope) {
      setLoaded({ rows: [], next: null, failed: false });
      setLoading(true);
    }
    setMore(false);
    setMoreFailure(null);
    await readListRows(client, viewer, { watchlist }, nextStatus, nextSort, nextScope).then((rows) => {
      if (!controller.signal.aborted) apply(rows);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setLoaded({ rows: [], next: null, failed: true, error });
    }).finally(() => {
      // An aborted older read must not clear the newer read’s busy state.
      setLoading((current) => controller.signal.aborted ? current : false);
    });
  }

  function choose(nextStatus: PresaleListStatus, nextSort: string) {
    navigate({ ...selection, status: nextStatus, sort: nextSort, scope, view: "list" });
    void load(nextStatus, nextSort, scope);
  }

  function changeScope(nextScope: PresaleScope, event?: MouseEvent) {
    if (nextScope !== "all" && watchlist?.signedIn === false && !viewer.signedIn) {
      if (event) gate.openSignIn(event);
      return;
    }
    const next = withDiscoveryScope(selection, nextScope);
    navigate(next);
    void load(status, next.sort, nextScope);
  }

  function changeView(next: PresaleListView) {
    if (next === "list" && view !== "list") {
      void load(status, sort, scope);
    }
    if (next === "backed") {
      request.current?.abort();
      request.current = null;
      setLoading(false);
    }
    navigate({ ...selection, view: next });
  }

  async function showMore() {
    const query = { status, sort, cursor: loaded.next };
    const reading = request.current;
    const page = `${status}:${sort}:${loaded.next}`;
    if (!loaded.next || more || loading || paging.current === page) return;
    paging.current = page;
    setMoreFailure(null);
    setMore(true);
    await listPage(query).then((result) => {
      if (reading !== request.current) return;
      // Only the page that follows the rows now loaded may be appended: a read begun before a restore or a refresh must not repeat one.
      if (result) setLoaded((current) => current.next === query.cursor ? { rows: [...current.rows, ...result.presales], next: result.next_cursor, failed: false } : current);
      else setMoreFailure(publicErrorMessage(client.getQueryState(presaleListQuery(query).queryKey)?.error, "The next page of presales couldn’t load. Use Show more to try again."));
    }).finally(() => {
      if (paging.current === page) paging.current = null;
      if (reading === request.current) setMore(false);
    });
  }

  // Personal entries wait for the viewer instead of displaying the public server seed.
  const watchLoad = watchlist?.load;
  const watchIds = watchlist?.ids;
  const current = useRef({ selection, load });
  useEffect(() => {
    current.current = { selection, load };
  });
  useEffect(() => {
    function restore() {
      if (window.location.pathname !== "/presale" || savedList(restorationId)) return;
      const params = new URLSearchParams(window.location.search);
      const next = discoveryState({ status: params.get("status"), sort: params.get("sort"), scope: params.get("scope"), layout: params.get("layout"), view: params.get("view"), calendarRange: params.get("calendarRange") });
      if (discoveryPath(next) === discoveryPath(current.current.selection)) return;
      const chosen = current.current.selection;
      const changed = next.status !== chosen.status || next.sort !== chosen.sort || next.scope !== chosen.scope || next.view !== chosen.view;
      setSelection(next);
      if (!changed) return;
      request.current?.abort();
      if (next.view === "list") void current.current.load(next.status, next.sort, next.scope);
      else setLoading(false);
    }
    // Back navigation can remount a cached server seed from before the selected filters.
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [restorationId]);
  useEffect(() => {
    const { selection: chosen, load: read } = current.current;
    if (restored.current) { restored.current = false; return; }
    if (viewer.sessionPending || chosen.view !== "list" || chosen.scope === "all") return;
    void read(chosen.status, chosen.sort, chosen.scope);
  }, [watchLoad, watchIds, viewer.getAccessToken, viewer.sessionPending, viewer.signedIn]);

  const { rows, error, counts } = useLivePresaleRows(loaded.rows, status, sort, props, view === "list", scope);
  const boundaryPassed = rows.some(sale => sale.phase === "open" && sale.end_ms <= now || sale.phase === "pending" && sale.start_ms > 0 && sale.start_ms <= now);
  useEffect(() => {
    if (!boundaryPassed || view !== "list") return;
    let disposed = false;
    async function refreshBoundary() {
      const chosen = current.current.selection;
      await client.invalidateQueries({ queryKey: queryKeys.presales.lists, refetchType: "none" });
      if (!disposed && chosen === current.current.selection) await current.current.load(chosen.status, chosen.sort, chosen.scope, true);
    }
    // A scheduled start still waits for the authoritative open phase. Retry while
    // the projection catches up, and replace the page so departed rows disappear.
    void refreshBoundary();
    const timer = window.setInterval(() => void refreshBoundary(), spreadMs(30_000, Date.now()));
    return () => { disposed = true; window.clearInterval(timer); };
  }, [boundaryPassed, client, view]);
  const ids = useMemo(() => view === "list" ? loaded.rows.map((row) => row.presale_id) : [], [loaded.rows, view]);
  const followed = useViewerPresales(ids);
  const body = useRef<HTMLDivElement>(null);
  const sessionBusy = !hydrated || viewer.sessionPending === true;
  const busy = viewIsBusy(view, {
    loading,
    viewerRead,
    sessionBusy,
    calendarBusy: calendarReads.some((read) => read.status === "loading"),
  });
  useFeedbackReveal(`${view}:${status}:${sort}:${scope}:${busy}`, body);
  const browseTarget = catalogBrowseTarget(selection, counts, props.initial, now);
  const browseStatus = browseTarget?.status;
  function browse() {
    if (!browseTarget) return;
    navigate({ ...selection, ...browseTarget, scope: "all", view: "list" });
    setSearch("");
    void load(browseTarget.status, browseTarget.sort, "all");
  }
  const availableRows = catalogRows(rows, selection, now, featuredSales);
  const matchingRows = searchPresales(availableRows, search);
  const showResultControls = busy || (view === "list" && matchingRows.length > 0);

  const content = {
    backed: <BackedPresales now={now} onBrowse={browseStatus ? browse : undefined} />,
    calendar: <PresaleCalendarContent now={now} range={calendarRange} onBrowse={() => changeView("list")} onRange={(calendarRange) => navigate({ ...selection, calendarRange })} reads={calendarReads} onRetry={() => { void calendarQuery.refetch(); void calendarLiveQuery.refetch(); void calendarEndedQuery.refetch(); }} />,
    list: (
      <PresaleListContent
        layout={layout}
        key={`${status}:${sort}:${scope}`}
        revealFloor={revealFloor}
        shownCountRef={shownCountRef}
        scope={scope}
        status={status}
        signedIn={watchlist?.signedIn ?? viewer.signedIn}
        onShowAll={() => changeScope("all")}
        showAllHref={discoveryPath(withDiscoveryScope(selection, "all"))}
        browseAction={browseStatus && <Button onClick={browse} size="sm" variant="ghost">{browseStatus === status ? "Show all" : "Browse"} {browseStatus} presales</Button>}
        loaded={loaded}
        error={error}
        loading={busy}
        more={more}
        moreFailure={moreFailure}
        now={now}
        onMore={() => void showMore()}
        onRetry={() => void load(status, sort, scope)}
        rows={matchingRows}
        catalogCount={availableRows.length}
        search={search}
        onClearSearch={() => setSearch("")}
        viewer={{ ...featuredViewer, ...followed }}
        />
    ),
  }[view];

  return (
    <div ref={listRoot}>
      <CspStyles />
      {hydrated && viewer.callsign ? <LegacyPresalesRedirect callsign={viewer.callsign} /> : null}
      <PresalesControls
        search={search}
        showResultControls={showResultControls}
        onSearch={setSearch}
        featured={status === "live" && scope === "all" && !search.trim() ? <FeaturedPresales now={now} sales={featuredSales.filter(sale => catalogStatus(sale, now) === "live")} viewer={featuredViewer} /> : null}
        layout={layout}
        onLayout={(layout) => navigate({ ...selection, layout })}
        onChoose={choose}
        onScope={changeScope}
        scope={scope}
        onView={changeView}
        sort={sort}
        status={status}
        view={view}
        watchlist={!!watchlist}
      >
        <div aria-busy={busy || undefined} aria-live="polite" className={cx("results-panel")} id="plist" ref={body}>
          {content}
        </div>
      </PresalesControls>
    </div>
  );
}

function LegacyPresalesRedirect({ callsign }: Readonly<{ callsign: string }>) {
  if (typeof window !== "undefined" && window.location.pathname === "/presale" && new URLSearchParams(window.location.search).get("view") === "mine") {
    redirect(`/@${callsign}`);
  }
  return null;
}

function catalogBrowseTarget(
  selection: DiscoveryState,
  counts: PresaleStatusCounts | undefined,
  initial: PresalesListProps["initial"],
  now: number,
) {
  const { scope, status, view } = selection;
  const catalogCounts = counts ?? initial?.status_counts;
  const knownStatus = (candidate: PresaleListStatus) => {
    const count = catalogCounts?.[candidate];
    if (count !== undefined) return count > 0;
    return initial?.presales.some(row => catalogStatus(row, now) === candidate) ?? false;
  };
  if (view === "list" && scope !== "all" && knownStatus(status)) return withDiscoveryScope(selection, "all");
  const alternate = (["live", "upcoming", "ended"] as const).find(candidate =>
    (view !== "list" || candidate !== status) && knownStatus(candidate));
  if (alternate) return { status: alternate, sort: discoverySorts(alternate)[0][0] };
}
