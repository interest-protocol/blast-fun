"use client";

import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { AppShell } from "../../../src/components/blast-ui/AppShell.tsx";
import type { PortfolioSummaryState } from "../../../src/components/blast-ui/portfolio.ts";
import { ProfileSkeleton } from "../../../src/components/social/profile/ProfileSkeleton.tsx";
import { ProfileScreen } from "../../../src/components/social/profile/ProfileScreen.tsx";
import { ConnectionRowsLoading } from "../../../src/components/social/profile/ConnectionsLoading.tsx";
import { EmptyState } from "../../../src/components/blast-ui/EmptyState.tsx";
import { FollowingList, WatchlistList } from "../../../src/components/social/coin-home/sources.tsx";
import { blankDraft } from "@blast/core/modules/social/create/model.ts";
import { PageHeader } from "../../../src/components/blast-ui/PageHeader.tsx";
import { bricolage, geist, geistMono } from "../../../src/components/blast-ui/fonts.ts";
import { QueryProvider } from "../../../src/lib/query/provider.tsx";
import { SocialViewerProvider } from "../../../src/components/social/SignInGate.tsx";
import { FeedOverlaysProvider } from "../../../src/components/social/feed-ui/shell-bridge.tsx";
import { WorkspaceHost } from "../../../src/components/social/blast-mode/workspace/WorkspaceHost.tsx";
import { useWorkspace, type WorkspaceOwnerResolver } from "../../../src/components/social/blast-mode/workspace/workspace-context.ts";
import { createWorkspaceStore } from "../../../src/components/social/blast-mode/workspace/model.ts";
import { encodeWorkspace } from "@blast/core/modules/social/blast-workspace/codec.ts";
import { workspaceJournalKey } from "../../../src/components/social/blast-mode/workspace/journal.ts";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { CoinPanel } from "../../../src/components/social/blast-mode/workspace/panels/CoinPanel.tsx";
import { PresalesData } from "../../../src/components/social/blast-mode/workspace/PresalesData.tsx";
import type { CoinReads } from "../../../src/components/social/blast-mode/workspace/panels/coin-reads.ts";
import type { SocialPresaleDetail } from "@blast/core/modules/social/contracts/presales.ts";
import type { Competition } from "@blast/core/modules/social/competitions/contracts.ts";
import { PROFILE_PNL } from "../social/profile/pnl-fixtures.ts";
import { WatchlistCard } from "../../../src/components/social/watchlist/WatchlistCard.tsx";
import { NotificationsView } from "../../../src/components/social/notifications/NotificationsView.tsx";
import { PresaleSection } from "../../../src/components/social/coin-home/PresaleSection.tsx";
import { CoinList, DiscoverList } from "../../../src/components/social/coin-home/sources.tsx";
import { HomeSections } from "../../../src/components/social/coin-home/HomeSections.tsx";
import { TableCard } from "../../../src/components/social/coin-home/TableFooter.tsx";
import { WatchlistProvider } from "../../../src/components/social/watchlist/Watchlist.tsx";
import { ConnectionsView } from "../../../src/components/social/profile/ConnectionsView.tsx";
import homeStyles from "../../../src/components/social/coin-home/CoinHome.module.css";
import { CreateView } from "../../../src/components/social/create/CreateView.tsx";
import { createStore } from "../../../src/components/social/create/create-store.ts";
import { SaleView } from "../../../src/components/presale-pages/SaleView.tsx";
import { SaleAside } from "../../../src/components/presale-pages/SaleAside.tsx";
import { PresalesList } from "../../../src/components/presale-pages/PresalesList.tsx";
import { ProfileTabs } from "../../../src/components/social/profile/ProfileTabs.tsx";
import profileStyles from "../../../src/components/social/profile/Profile.module.css";
import { InvitesPage } from "../../../src/components/social/referrals/InvitesPage.tsx";
import { ProfileFollow } from "../../../src/components/social/profile/IdentityCard.tsx";
import { CompetitionHero } from "../../../src/components/social/competitions/CompetitionHeader.tsx";
import competitionStyles from "../../../src/components/social/competitions/CompetitionScreen.module.css";
import { PortfolioView } from "../../../src/components/social/portfolio/PortfolioView.tsx";
import { LaunchRewards } from "../../../src/components/social/launch-rewards/LaunchRewards.tsx";
import { VestingOverview } from "../../../src/components/vesting/VestingOverview.tsx";
import { portfolioCoverage, portfolioFigures, pricedFigures } from "../../../src/components/social/portfolio/portfolio-model.ts";
import { shellPortfolioSummary } from "../../../src/components/social/use-shell-portfolio.ts";
import { HOME_DEFAULT_QUERY } from "@blast/core/modules/social/contracts/home.ts";
import { CREATE_QUOTE_TYPE, CREATE_SUI_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { CREATE_DEFAULT_FEE_POLICY } from "@blast/core/modules/social/create/model.ts";
import { filledSample } from "../../../../../packages/core/test/fixtures/social/create/create-fixtures.ts";
import { FIXTURE_NOW } from "../../../../../packages/core/test/fixtures/presale-pages/presale-fixtures.ts";
import { walletHolderRewardsBody, walletLaunchRewardsBody } from "../../../../../packages/core/test/fixtures/modules/launchpad-coin/rewards-fixtures.ts";
import { proofCoinTypes, proofCoins, proofHistory, proofMarket, proofThread } from "./redesign-fixtures";
import {
  CALLS, COMPETITION, HAPPENING, HOLDERS, HOME_COINS, INVITEES, MEMBERS_TOTAL, NOW, OPENS, PORTFOLIO, PORTFOLIO_COINS, RANK,
  SALE_COINS, SHELL_PORTFOLIO, SHELL_VIEWER, WATCHLIST, homeCoinsByIds, presalesPage, pricesFor, termsDetail, tradingDetail,
} from "./parity-fixtures";

/**
 * Visual proof for #589's parity reads wired in the web app (and #588's
 * scheduled start): production components with invented data
 * (`parity-fixtures.ts`), each inside the wrapper production gives it.
 * `?surface=` picks one, `?variant=` a state of it, `?theme=` the theme,
 * `?shell=member` a signed-in shell (a stand-in viewer and balance).
 * Reads are answered in the page: a fetch stub for the routes these
 * surfaces call (holders, prices, the happening and Home coins reads, the
 * presales list, the viewer's competition rank). There is
 * no wallet, signature, provider or send path; the signed-in surfaces use a
 * stand-in token no server sees.
 */
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
const FIXTURE_WALLET = `0x${"a1".repeat(32)}`;
function profileFixtureRead(url: URL) {
  if (url.pathname.endsWith("/connections")) {
    const accounts = new URLSearchParams(window.location.search).get("surface") === "connections-follow" ? [{ callsign: "nova", display_name: "Nova", avatar_url: null, verified: false, private: false }] : [];
    return json(url.searchParams.has("tab") ? { accounts, next_cursor: null } : { followers: accounts.length, following: 0 });
  }
  if (url.pathname === "/api/social/card-identities") return json(Object.fromEntries((url.searchParams.get("callsigns") ?? "").split(",").filter(Boolean).map(callsign => [callsign, null])));
  return null;
}
function authenticatedFixtureRead(path: string, init?: RequestInit) {
  const variant = new URLSearchParams(window.location.search).get("variant");
  const paths = ["/api/social/viewer-state", "/api/social/me/home/following", "/api/social/me/watchlist/keys", "/api/social/me/referrals", "/api/social/me/referrals/invitees"];
  if (!paths.includes(path)) return null;
  if (variant === "data-pending") return new Promise<Response>(() => {});
  if (variant === "error") return Promise.resolve(Response.json({ error: { code: "service_unavailable" } }, { status: 503 }));
  if (path.endsWith("viewer-state")) return json({ reactions: {}, follows: { accounts: { nova: true }, presales: {} }, backers: {} });
  if (path.endsWith("watchlist/keys")) return json({ keys: variant === "populated" ? SALE_COINS.coins.map(coin => coin.presale_id) : [] });
  if (path.endsWith("invitees")) return json({ invitees: variant === "populated" ? INVITEES : [], next_cursor: null });
  if (path.endsWith("referrals")) return json({ invited: 0, volume_usd: "0.00", unvalued_trades: 0, accounting: { assets: [], share_bps: 6000, as_of_ms: Date.UTC(2026, 9, 29, 16), pending_events: 0 } });
  const request = typeof init?.body === "string" ? JSON.parse(init.body) as { mode?: string } : {};
  if (request.mode === "preview") return json({ mode: "preview", previews: {}, window: "24h", clock_ms: NOW, as_of: SALE_COINS.as_of });
  const coins = variant === "populated" ? SALE_COINS.coins : [];
  return json({ ...SALE_COINS, mode: "coins", coins, page: 1, pages: 1, total: coins.length, following: coins.length, limit: 10, next_cursor: null });
}
function fixtureUrl(input: Parameters<typeof fetch>[0]) {
  return new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href);
}
function launchpadFixtureRead(path: string) {
  const walletPath = `/api/launchpad/market/wallets/${FIXTURE_WALLET}`;
  if (path === "/api/launchpad/market/status") return json({ provenance: walletHolderRewardsBody(FIXTURE_WALLET, NOW).provenance });
  if (path === `${walletPath}/launch-rewards`) return json({ ...walletLaunchRewardsBody(FIXTURE_WALLET, "live", NOW), launches: [] });
  if (path === `${walletPath}/vault-rewards` || path === `${walletPath}/launch-holder-rewards`) return json({ ...walletHolderRewardsBody(FIXTURE_WALLET, NOW), payouts: [] });
  return null;
}
if (typeof window !== "undefined" && !(window as { __parityFetch?: boolean }).__parityFetch) {
  (window as { __parityFetch?: boolean }).__parityFetch = true;
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = fixtureUrl(input);
    const path = url.pathname;
    const authenticatedRead = authenticatedFixtureRead(path, init);
    if (authenticatedRead) return authenticatedRead;
    const profileRead = profileFixtureRead(url);
    if (profileRead) return profileRead;
    if (path === "/api/social/home/holders") return json(HOLDERS);
    if (path === "/api/social/prices") return json(pricesFor(url.searchParams.getAll("presale")));
    if (path === "/api/social/happening") return json(HAPPENING);
    if (path === "/api/social/home/coins") return json({ ...homeCoinsByIds(url.searchParams.getAll("presale")), pool_volumes: {} });
    if (path === "/api/social/home/activity") return json({ presale_id: url.searchParams.get("presale"), participants: [], totals: SALE_COINS.coins[0]!.activity, next_cursor: null, window: "24h", clock_ms: NOW, as_of: SALE_COINS.as_of });
    if (path === "/api/social/home/market") return json(proofMarket(url.searchParams.get("coin") ?? proofCoinTypes.KSTL));
    if (path === "/api/social/presales" && (init?.method ?? "GET") === "GET") {
      return json(catalogPage((url.searchParams.get("status") ?? "live") as "live" | "upcoming" | "ended", firstParams?.get("variant")));
    }
    if (path === "/api/social/me/competitions/rank") return json(RANK);
    if (path === "/api/social/me/vesting") return json({ wallet: FIXTURE_WALLET, schedules: [] });
    if (path === `/api/social/presales/${tradingDetail().presale.presale_id}`) return json(tradingDetail());
    // The coin page's ticket (SaleTradePanel) reads the swap's featured competitions: none.
    if (path === "/api/social/competitions") return json({ competitions: [], coins: [], as_of_ms: Date.now(), next_change_at_ms: null });
    return launchpadFixtureRead(path) ?? original(input, init);
  };
}

const noop = () => undefined;
const noSubscription = () => () => {};
// Read once: a surface (the presales list) rewrites the address bar, and the page must keep its surface.
const firstParams = typeof window === "undefined" ? null : new URLSearchParams(window.location.search);
const param = (name: string, fallback: string) => () => firstParams?.get(name) ?? fallback;
const getAccessToken = async () => "fixture-token";
/** A signed-in viewer for the surfaces that need one: a stand-in token, no server session. */
function SignedIn({ children }: Readonly<{ children: ReactNode }>) {
  return <SocialViewerProvider signedIn sessionPending={false} callsign="kaimoreno" getAccessToken={getAccessToken}>{children}</SocialViewerProvider>;
}

/* ---------- Blast mode: the coin focus board (Holders) and Discover's Presales rows ---------- */

const coinReads: CoinReads = {
  coin: async () => ({ ...proofCoins.KSTL, price_as_of_ms: Date.now() }),
  chart: async (asset) => proofHistory(asset.coin_type, true),
  holders: async () => proofCoins.KSTL.top_holders ?? null,
  activity: async () => proofThread("KSTL"),
};
function memoryStorage(entries: Readonly<Record<string, string>>) {
  const map = new Map(Object.entries(entries));
  return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) };
}
function blastWorkspace(view: "holders" | "rows") {
  const store = createWorkspaceStore();
  store.add({ panel_id: "A", coin_type: proofCoinTypes.KSTL, presale_id: null, chain: "sui", network: "mainnet" });
  store.setPresentation("focus");
  store.focus("A");
  store.selectDataView("Presales");
  // The holders proof gives the board the width; the rows proof opens Discover on its Presales view.
  store.setDataCollapsed(view === "holders");
  const encoded = encodeWorkspace(store.getSnapshot());
  if (!encoded.ok) throw new Error(encoded.reason);
  return memoryStorage({ [workspaceJournalKey({ actor: { kind: "guest" }, chain: "sui", network: "mainnet" })]: encoded.bytes });
}
const noHistoryReads: CoinReads = { ...coinReads, chart: async () => null };
function FocusPanel({ panel }: Readonly<{ panel: PanelSetup }>) {
  const { dispatch } = useWorkspace();
  return <CoinPanel focus panel_id={panel.panel_id} asset={panel} coin_setup={panel.coin} onSetupChange={(coin) => dispatch.patchPanel(panel.panel_id, { coin })} effective_visibility actions={{ trade: null, authenticated: false, actor_key: "guest", signIn: noop }} reads={firstParams?.get("variant") === "empty" ? noHistoryReads : coinReads} />;
}
function BlastMode({ view }: Readonly<{ view: "holders" | "rows" }>) {
  const [storage] = useState(() => blastWorkspace(view));
  const resolve = useCallback<WorkspaceOwnerResolver>(async () => ({ kind: "guest" }), []);
  return <WorkspaceHost resolveOwner={resolve} ownerKey={`parity-${view}`} entryGeneration={1} onExit={noop} storage={storage} slots={{ panel: FocusPanel, data: { Presales: PresalesData } }} />;
}

/* ---------- Home: the Presales section and the coin cards ---------- */

function Home({ empty }: Readonly<{ empty: boolean }>) {
  const list = { source: "discover" as const, window: "24h" as const, nowMs: NOW, trading: false, sort: "relevant" as const, onSort: noop, page: 1, rows: 10, onPage: noop, onRows: noop };
  return (
    <FeedOverlaysProvider value={{ openCommit: noop, openCommitTo: noop }}>
      <div className={homeStyles.home}>
        <PageHeader title="Home" />
        <div className={homeStyles.board}>
          <HomeSections
            empty={null}
            onChange={noop}
            prefs={{ order: ["bonding", "presales", "coins", "posts", "traders"], hidden: ["posts", "traders"] }}
            sections={{
              bonding: { children: null },
              presales: { children: <PresaleSection happening={HAPPENING} initial={SALE_COINS} initialMs={NOW} nowMs={NOW} window="24h" /> },
              coins: { children: <TableCard><>{empty ? <DiscoverList initial={{ ...SALE_COINS, coins: [], total: 0, page: 1, pages: 1, next_cursor: null }} props={list} query={HOME_DEFAULT_QUERY} /> : <CoinList coins={HOME_COINS} props={list} />}</></TableCard> },
              posts: { children: null },
              traders: { children: null },
            }}
          />
        </div>
      </div>
    </FeedOverlaysProvider>
  );
}

/* ---------- Create: the Raise step's Opens ---------- */

function raiseState(variant: string) {
  createStore.reset({
    phase: "ready",
    draftId: "00000000-0000-4000-8000-0000000000f2",
    version: 1,
    fees: CREATE_DEFAULT_FEE_POLICY,
    cetusTiers: { [CREATE_QUOTE_TYPE]: [[200, 10_000]], [CREATE_SUI_QUOTE_TYPE]: [[200, 10_000]] },
    bluefinOptions: { status: "ready", min_tick: -443_636, max_tick: 443_636 },
    publish: { available: false, reasons: ["presale_not_deployed"] },
    selfAddress: "0x3f9a8c21d04b7e91a2c5f6e8b3d0794c1e2a5b6f8d9c0e1f2a3b4c5d6e7b1c21",
    nowMs: Date.now(),
    draft: { ...filledSample(), start_ms: OPENS[variant] ?? null },
    step: "raise",
    // The field was left once, so its check shows (as after a blur).
    touched: new Set(["start_ms"]),
  });
  return createStore.get();
}

/* ---------- Pages ---------- */

const NOTIFICATIONS = [
  { id: "2", kind: "fill" as const, title: "Meridian is 73% filled", sub: "You have 1,000 SUI in · 6h left", occurred_at_ms: NOW - 60 * 60_000, read: false, href: "/presale/mrdn", presale: { presale_id: WATCHLIST[3]!.presale_id, name: "Meridian", symbol: "MRDN", icon_url: "" }, actor: null },
];

function ProfileSurface({ surface, variant }: Readonly<{ surface: string; variant: string }>) {
    const own = surface === "own-profile";
    const profile = { callsign: "kaimoreno", display_name: "Kai Moreno", avatar_url: null, x_handle: null, verified: false, private: false, portfolio_public: false };
    return <SignedIn>{variant === "loading" ? <ProfileSkeleton callsign={profile.callsign} profile={profile} own={own} nowMs={NOW} /> : <ProfileScreen profile={profile} data={{ own, calls: { status: "ready", value: variant === "empty" ? { ...CALLS, calls: [] } : CALLS }, created: { status: "ready", value: [] }, mutuals: { status: "none" }, gold: { status: "none" }, pnl: { status: "ready", value: PROFILE_PNL } }} nowMs={NOW} onEdit={noop} />}</SignedIn>;
 }

function PersonalHomeSurface({ surface, variant }: Readonly<{ surface: string; variant: string }>) {
    const pending = variant === "loading";
    const props = { source: "following" as const, window: "24h" as const, nowMs: NOW, trading: false, page: 1, rows: 10, onPage: noop, onRows: noop };
    return <SocialViewerProvider signedIn={!pending} sessionPending={pending} callsign={pending ? null : "kaimoreno"} getAccessToken={getAccessToken}><WatchlistProvider signedIn={!pending} viewerKey="kaimoreno" getAccessToken={getAccessToken}><div className={homeStyles.home}><PageHeader title="Home" /><TableCard>{surface === "following" ? <FollowingList props={props} onDiscover={noop} /> : <WatchlistList props={props} />}</TableCard></div></WatchlistProvider></SocialViewerProvider>;
 }

function RefreshSurface({ surface, variant }: Readonly<{ surface: string; variant: string }>) {
  if (surface === "notifications") return <NotificationsView items={variant === "populated" ? NOTIFICATIONS : []} mode={variant === "loading" || variant === "error" ? variant : variant === "populated" ? "list" : "empty"} nowMs={NOW} />;
  if (surface === "connections") return <><PageHeader title="Followers" /><section className="card">{variant === "loading" ? <ConnectionRowsLoading tab="followers" /> : <EmptyState title="No followers yet" />}</section></>;
  if (surface === "profile" || surface === "own-profile") return <ProfileSurface surface={surface} variant={variant} />;
  if (surface === "following" || surface === "saved") return <PersonalHomeSurface surface={surface} variant={variant} />;
  return null;
}

type ServerFixture = Readonly<{ detail?: SocialPresaleDetail; competition?: Competition; nowMs?: number }>;

function AuthenticatedSurface({ surface, variant }: Readonly<{ surface: string; variant: string }>) {
  const pending = variant === "loading";
  if (surface !== "invites" && surface !== "follow-status" && surface !== "connections-follow") return null;
  const profile = { callsign: "kaimoreno", display_name: "Kai Moreno", avatar_url: null, x_handle: null, verified: false, private: false, portfolio_public: false, as_of: SALE_COINS.as_of };
  return <SocialViewerProvider signedIn={!pending} sessionPending={pending} callsign={pending ? null : "kaimoreno"} getAccessToken={getAccessToken}>{surface === "invites" ? <InvitesPage /> : surface === "connections-follow" ? <ConnectionsView profile={profile} tab="followers" /> : <><PageHeader title="Followers" /><section className="card"><ProfileFollow callsign="nova" /></section></>}</SocialViewerProvider>;
}

function catalogPage(status: Parameters<typeof presalesPage>[0], variant: string | null | undefined) {
  const page = presalesPage(status);
  return variant === "catalog-empty" ? { ...page, presales: [], status_counts: { live: 0, upcoming: 0, ended: 0 } } : page;
}

function PresaleSurface({ surface, variant, snapshot }: Readonly<{ surface: string; variant: string; snapshot?: ServerFixture }>) {
  if (surface === "terms") {
    const detail = snapshot?.detail ?? termsDetail(variant);
    return <SocialViewerProvider signedIn={false} sessionPending={false}><SaleView detail={variant === "empty" ? { ...detail, activity: [] } : detail} nowMs={FIXTURE_NOW} viewerEntry={null} /></SocialViewerProvider>;
  }
  if (surface === "presales") return <SocialViewerProvider signedIn={false} sessionPending={false}><PresalesList initial={catalogPage("live", variant)} nowMs={NOW} sort="ending" status="live" view="list" /></SocialViewerProvider>;
  if (surface === "coin") {
    // The trading coin's page as SalePage draws it; its right column (≥1220) is the real SaleAside.
    const detail = tradingDetail();
    return <SignedIn><SaleView detail={detail} nowMs={FIXTURE_NOW} tradingClaims={<SaleAside compact detail={detail} kit={null} nowMs={FIXTURE_NOW} />} viewerEntry={null} /></SignedIn>;
  }
  return null;
}

function Surface({ surface, variant, snapshot }: Readonly<{ surface: string; variant: string; snapshot?: ServerFixture }>) {
  const specialized = RefreshSurface({ surface, variant }) ?? AuthenticatedSurface({ surface, variant }) ?? PresaleSurface({ surface, variant, snapshot });
  if (specialized) return specialized;
  if (surface === "holders") return null;
  if (surface === "blast-rows") return null;
  if (surface === "watchlist") {
    // The Notifications page with its right column; below 1220px the shell hides that column, so the card follows the list.
    return <><NotificationsView items={NOTIFICATIONS} mode="list" nowMs={NOW} /><NarrowOnly><WatchlistCard nowMs={NOW} rows={variant === "empty" ? [] : WATCHLIST} /></NarrowOnly></>;
  }
  if (surface === "home") return <Home empty={variant === "empty"} />;
  if (surface === "create") return <SignedIn><CreateView onList={noop} onLogo={noop} onRetry={noop} signIn={<a href="/sign-in">Sign in</a>} state={variant === "blank-review" ? (createStore.reset({ ...raiseState(""), draft: blankDraft(), step: "review" }), createStore.get()) : raiseState(variant)} /></SignedIn>;
  if (surface === "calls") return <div className={profileStyles.page}><ProfileTabs callsign="kaimoreno" calls={{ status: "ready", value: CALLS }} nowMs={NOW} /></div>;
  if (surface === "competitions") return <SignedIn><div className={competitionStyles.screen}><PageHeader title="Competitions" /><CompetitionHero competition={snapshot?.competition ?? COMPETITION} membersTotal={MEMBERS_TOTAL} nowMs={snapshot?.nowMs ?? NOW} /></div></SignedIn>;
  if (surface === "portfolio") return <PortfolioSurface variant={variant} />;
  if (surface === "vesting") return <SignedIn><VestingOverview nowMs={NOW} /></SignedIn>;
  if (surface === "rewards") return <SignedIn><PageHeader title="Rewards" /><LaunchRewards active addresses={[FIXTURE_WALLET]} hidden={false} /></SignedIn>;
  return <p>Unknown surface.</p>;
}

function portfolioFixture(variant: string) {
  if (variant !== "unpriced" && variant !== "empty") return PORTFOLIO;
  return {
    ...PORTFOLIO,
    balances: { sui: { atoms: "0", usd: "0.00" }, usdc: { atoms: "0", usd: "0.00" } },
    commitments: { committed_usd: "0.00", claimable_usd: "0.00" },
    coins: variant === "empty" ? [] : PORTFOLIO.coins?.filter((coin) => coin.value_usd === null) ?? [],
  };
}

function PortfolioSurface({ variant }: Readonly<{ variant: string }>) {
    const unpriced = variant === "unpriced";
    const portfolio = portfolioFixture(variant);
    const historyRead = variant === "loading" ? { status: "loading" as const } : variant === "error" ? { status: "error" as const, retry: noop } : { status: "ready" as const, trend: null, first: null, last: null };
    return (
      <PortfolioView
        nowMs={NOW}
        data={{
          mode: variant === "visitor" ? "visitor" : variant === "loading" ? "loading" : "ready", portfolio: variant === "loading" ? "loading" : variant === "error" ? "error" : "ready", figures: portfolioFigures(portfolio), valuation: portfolioCoverage(portfolio), priced: pricedFigures(portfolio),
          today: null, history: { "1w": historyRead, "1m": historyRead, all: historyRead }, isPublic: false, coins: variant === "empty" || variant === "loading" ? [] : unpriced ? PORTFOLIO_COINS.filter((coin) => coin.usd === null) : PORTFOLIO_COINS, prices: new Map(), holdings: { created: [], positions: [], watchlist: [], coins: [], vestings: [] },
          holdingsFailed: false, hidden: false, rewards: { status: variant === "loading" ? "loading" : "ready", coins: [], latest: [], retry: noop },
        }}
      />
    );
 }

const narrowQuery = "(max-width: 1219px)";
const narrow = () => window.matchMedia(narrowQuery).matches;
const subscribeNarrow = (change: () => void) => { const media = window.matchMedia(narrowQuery); media.addEventListener("change", change); return () => media.removeEventListener("change", change); };
/** What the shell's right column holds, drawn in the page where the shell hides that column (below 1220px). */
function NarrowOnly({ children }: Readonly<{ children: ReactNode }>) {
  const shown = useSyncExternalStore(subscribeNarrow, narrow, () => false);
  return shown ? <div data-parity-narrow="" style={{ display: "grid", gap: "0.75rem", margin: "0.75rem 0" }}>{children}</div> : null;
}

function fixtureShellPortfolio(surface: string, variant: string, member: boolean): PortfolioSummaryState {
  if (!member) return { status: "unavailable" };
  if (variant === "loading") return { status: "loading" };
  if (surface !== "portfolio") return SHELL_PORTFOLIO;
  return { status: "ready", summary: shellPortfolioSummary(portfolioFixture(variant), new Map()) };
}

export function ParityFixture({ initial }: Readonly<{ initial?: { surface: string; variant: string; theme: string; shell: string; transition: string } & ServerFixture }>) {
  const [resolved, setResolved] = useState(false);
  useEffect(() => {
    performance.mark("fixture-hydrated");
    if (!initial?.transition) return;
    const timeout = setTimeout(() => { performance.mark("fixture-data-ready"); setResolved(true); }, 700);
    return () => clearTimeout(timeout);
  }, [initial?.transition]);
  // The server renders light settings; the client reads ?theme=, ?surface= and ?variant= without a hydration mismatch.
  const theme = useSyncExternalStore(noSubscription, param("theme", "light"), () => initial?.theme ?? "light");
  const surface = useSyncExternalStore(noSubscription, param("surface", "holders"), () => initial?.surface ?? "");
  const requestedVariant = useSyncExternalStore(noSubscription, param("variant", ""), () => initial?.variant ?? "");
  const variant = initial?.transition ? resolved ? initial.transition : "loading" : requestedVariant;
  const shell = useSyncExternalStore(noSubscription, param("shell", "visitor"), () => initial?.shell ?? "visitor");
  const member = shell === "member" && variant !== "visitor";
  const shellPortfolio = fixtureShellPortfolio(surface, variant, member);
  const aside = surface === "watchlist" ? <WatchlistCard nowMs={NOW} rows={variant === "empty" ? [] : WATCHLIST} /> : surface === "coin" ? <SignedIn><SaleAside detail={tradingDetail()} kit={null} nowMs={FIXTURE_NOW} /></SignedIn> : undefined;
  const overlays = surface === "holders" ? <BlastMode view="holders" /> : surface === "blast-rows" ? <BlastMode view="rows" /> : undefined;
  return (
    <div className={`${geist.variable} ${geistMono.variable} ${bricolage.variable}`} data-blast-ui="" data-theme={theme} data-fixture-surface={surface} data-fixture-variant={variant} data-fixture-resolved={resolved || undefined}>
      <QueryProvider>
        <AppShell signedIn={member} viewer={member ? SHELL_VIEWER : null} portfolio={shellPortfolio} signInHref="/sign-in" aside={aside} overlays={overlays}>
          {surface === "" ? null : <Surface surface={surface} variant={variant} snapshot={initial} />}
        </AppShell>
      </QueryProvider>
    </div>
  );
}
