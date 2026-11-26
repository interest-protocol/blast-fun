"use client";

import { ShellPortfolioProvider } from "#web/components/social/shell-portfolio-context.tsx";
import { NO_SHELL_PORTFOLIO } from "#web/components/social/shell-portfolio-context-model.ts";
import { createTestQueryClient } from "#web/lib/query/test-client.ts";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import type { ActionAccountSession } from "../../../src/components/social/blast-mode/workspace/BlastActionProvider";
import { AppShell } from "../../../src/components/blast-ui/AppShell.tsx";
import { ShellPrefsBoot } from "../../../src/components/blast-ui/ShellPrefsBoot.tsx";
import { useShellActions } from "../../../src/components/blast-ui/shell-actions.tsx";
import { bricolage, geist, geistMono } from "../../../src/components/blast-ui/fonts.ts";
import { BlastModeHost } from "../../../src/components/social/blast-mode/BlastModeHost.tsx";
import { QueryProvider } from "../../../src/lib/query/provider.tsx";
import { useWorkspace, type WorkspaceOwnerResolver } from "../../../src/components/social/blast-mode/workspace/workspace-context.ts";
import { createWorkspaceStore, type WorkspaceStore } from "../../../src/components/social/blast-mode/workspace/model.ts";
import { encodeWorkspace } from "@blast/core/modules/social/blast-workspace/codec.ts";
import { workspaceJournalKey } from "../../../src/components/social/blast-mode/workspace/journal.ts";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { CoinPanel } from "../../../src/components/social/blast-mode/workspace/panels/CoinPanel.tsx";
import { useAppQueryClient } from "../../../src/lib/query/provider";
import { tradersQuery } from "../../../src/components/social/coin-home/home-client";
import { ViewerStateProvider, useViewerStateStore } from "../../../src/components/social/ViewerState";
import { ListedKolsContext } from "../../../src/components/social/blast-mode/workspace/listed-kols";
import { CoinsData } from "../../../src/components/social/blast-mode/workspace/CoinsData.tsx";
import { createCoinReads, type CoinReads } from "../../../src/components/social/blast-mode/workspace/panels/coin-reads.ts";
import type { TradeKit } from "../../../src/components/social/trade/trade-kit.ts";
import { fixtureCoinType, fixtureWallet, fixtureTradeQuote } from "../social/trade/trade-fixtures.ts";
import { proofCoins, proofHistory, proofThread, proofHomeCoins, proofPresales } from "./redesign-fixtures";
import { homeCoinRows } from "./coin-fixtures";

import { discoveryCoins, discoveryResponse } from "./discovery-fixtures";
import { PresalePanel } from "../../../src/components/social/blast-mode/workspace/panels/PresalePanel";
import { createCommitQuotes } from "../../../src/components/social/commit/commit-quote";
import type { CommitKit } from "../../../src/components/social/commit/commit-kit";
import { presaleFacts, presaleViewer } from "./presale-fixtures";
import { nativeTradingHistory } from "./native-trading-fixture";
import { chartTradesFixture, chartPostsFixture } from "./chart-trades-fixture";
import { auditHolders, auditName, auditPosts, auditPresaleId, auditSymbol, auditThread } from "./audit-fixtures";

type Scenario = "catalog-coin" | "dust" | "activity-zero" | "activity-long" | "activity-unavailable" | "holders-old" | "holders-unavailable" | "people-ready" | "trades-partial" | "trades-delayed" | "trades-error" | "trades-loading" | "trades-empty" | "trades-unavailable" | "coin-error" | "sparse" | "unpriced" | "long-content" | "holders-ready" | "holders-loading" | "holders-error" | "posts-ready" | "posts-short" | "posts-empty" | "posts-error" | "posts-loading" | "posts-unavailable" | "presale-funded" | "presale-cancelled" | "pnl-loss" | "pnl-unknown" | "pnl-error" | "pnl-loading" | "guest" | "ready" | "loading" | "empty" | "unavailable" | "error" | "stale" | "zero" | "wallet-error" | "wallet-loading" | "quote-error" | "quote-no-route" | "quote-loading" | "native-ready" | "native-empty" | "native-unavailable" | "native-stale";
const projectMetadata = { site: "https://example.com/kestrel", x_handle: "example", telegram: "example", tagline: null, docs_url: null, audit_url: null, cover: null, launch_at_ms: null };
const ids = ["A", "B", "C", "D"];
const symbols = ["KSTL", "LUMN", "WAVE", "ORBT"];
const coins = symbols.map((symbol, index) => ({ ...proofCoins[index % 2 ? "LUMN" : "KSTL"], coin_type: fixtureCoinType(symbol), symbol, name: ["Kestrel", "Lumen", "Wave", "Orbit"][index]!, presale_id: null }));
const Context = createContext<Readonly<{ states: Record<string, Scenario>; setState: (id: string, state: Scenario) => void }> | null>(null);
declare global { interface Window { tradingFixture?: { state: (id: string, state: Scenario) => void; store: WorkspaceStore }; } }
if (typeof window !== "undefined") {
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href);
    if (url.pathname.startsWith("/api/social/follows/account/")) return Promise.resolve(new Response(null, { status: 204 }));
    if (url.pathname === "/api/social/viewer-state") {
      if (window.holderFixture?.scope === "unavailable") return Promise.resolve(new Response(null, { status: 503 }));
      const body = JSON.parse(String(init?.body ?? "{}"));
      return Promise.resolve(Response.json({ reactions: {}, backers: {}, follows_you: {}, follows: { accounts: Object.fromEntries((body.callsigns ?? []).map((id: string) => [id, window.holderFixture?.scope !== "other" && (id === "inesduarte" || id === "devonsui")])), presales: {} } }));
    }
    const discovery = discoveryResponse(url, init?.signal);
    if (discovery) return discovery;
    // `?flow=sparse` / `?flow=ready` answer Flow's market read (`GET /api/social/home/market`) in the page.
    const flow = new URLSearchParams(window.location.search).get("flow");
    if (flow && url.pathname === "/api/social/home/market") return Promise.resolve(Response.json(flowMarket(url.searchParams.get("coin") ?? "", flow === "sparse")));
    return original(input, init);
  };
}
/** Flow's market read for one coin: every window empty (`sparse`) or the board's figures (`ready`). */
function flowMarket(coinType: string, sparse: boolean) {
  const now = Date.now();
  const window = (span: number, change: number | null, buys: number, sells: number, bought: string | null, sold: string | null, buyers: number, sellers: number) => ({
    from_ms: now - span, to_ms: now, open_usd: change === null ? null : "0.0021", open_as_of_ms: change === null ? null : now - span, change_bps: change, change_usd: null,
    buys, sells, bought_atoms: "0", sold_atoms: "0", bought_usd: bought, sold_usd: sold, unpriced_buys: 0, unpriced_sells: 0, buyers, sellers,
  });
  const windows = sparse
    ? { "5m": window(300_000, null, 0, 0, null, null, 0, 0), "1h": window(3_600_000, null, 0, 0, null, null, 0, 0), "4h": window(14_400_000, null, 0, 0, null, null, 0, 0), "24h": window(86_400_000, null, 0, 0, null, null, 0, 0) }
    : { "5m": window(300_000, 15, 12, 5, "4200.00", "1800.00", 9, 4), "1h": window(3_600_000, 213, 1708, 735, "380000.00", "181000.00", 941, 410), "4h": window(14_400_000, 418, 4100, 2300, "910000.00", "520000.00", 2100, 1200), "24h": window(86_400_000, 342, 9800, 6100, "2100000.00", "1500000.00", 4400, 3100) };
  return { coin_type: coinType, presale_id: null, decimals: 9, quote: { type: "0x2::sui::SUI", symbol: "SUI", decimals: 9 }, clock_ms: now, price_usd: "0.00214", price_as_of_ms: now, windows, supply: { total: "1000000000000000000", escrowed: "0", circulating: "1000000000000000000" }, fdv_usd: "21400.00", market_cap_usd: "21400.00", pool: null, liquidity_usd: null, as_of: { checkpoint: 1, timestamp_ms: now, lag_ms: 0 } };
}
const slots = { panel: FixturePanel, data: { Coins: CoinsData }, controls: <Probe /> };
const pending = (signal?: AbortSignal) => new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("Fixture cancelled")), { once: true }));

declare global { interface Window { holderFixture?: { setSignedIn: (value: boolean) => void; setKols?: (callsigns: string[]) => void; refreshPnl?: () => Promise<void>; scope?: string; setScope?: (scope: string) => void; setFollowing?: (following: boolean) => Promise<unknown> } } }
const holderToken = async () => "simulated-holder-fixture";
const subscribeToLocation = () => () => {};
const holderPreviewSnapshot = () => new URLSearchParams(location.search).has("holderSignals");
const serverHolderPreviewSnapshot = () => false;
const tradePreviewSnapshot = () => new URLSearchParams(location.search).has("tradeSignals");
const portfolioPreviewSnapshot = () => new URLSearchParams(location.search).has("portfolioPreview");
/** `?shellPortfolio` gives the Blast mode bar a priced subtotal with unpriced assets (audit F35). */
const shellPortfolioSnapshot = () => new URLSearchParams(location.search).has("shellPortfolio");
const UNPRICED_SHELL_PORTFOLIO = { refresh: () => undefined, portfolio: null, state: { status: "ready", summary: { total_usd: null, known_value_usd: 209.24, unpriced_assets: true, today: null, breakdown: { coins: null, committed: null, claimable: null }, known_breakdown: { coins: 104.24, committed: 100, claimable: 5 } } } } as const;
const portfolioActor: ActionAccountSession = { status: "ready", sessionStatus: "authenticated", sessionIdentity: "portfolio-fixture", account: { account_id: "portfolio-fixture", kind: "new", callsign: "trader", display_name: "Trader", avatar_url: null, x_handle: null, verified: false, onboarding: { shown: true, completed: true }, privacy: "private", sharing_since_ms: null, wallets: [] } };
export function TradingFixture() {
  const tradePreview = useSyncExternalStore(subscribeToLocation, tradePreviewSnapshot, serverHolderPreviewSnapshot);
  const portfolioPreview = useSyncExternalStore(subscribeToLocation, portfolioPreviewSnapshot, serverHolderPreviewSnapshot);
  const shellPortfolio = useSyncExternalStore(subscribeToLocation, shellPortfolioSnapshot, serverHolderPreviewSnapshot);
  const holderPreview = useSyncExternalStore(subscribeToLocation, holderPreviewSnapshot, serverHolderPreviewSnapshot);
  const [holderSignedIn, setHolderSignedIn] = useState(true);
  const [kolCallsigns, setKols] = useState(["maralin"]);
  const [holderScope, setHolderScope] = useState("holder-fixture");
  useEffect(() => {
    window.holderFixture = { ...window.holderFixture, setSignedIn: setHolderSignedIn, setKols, setScope: setHolderScope, scope: holderScope };
  }, [holderScope]);
  useEffect(() => () => { delete window.holderFixture; }, []);
  const [states, setStates] = useState<Record<string, Scenario>>({ A: "ready", B: "empty", C: "zero", D: "stale" });
  const setState = useCallback((id: string, state: Scenario) => setStates(previous => ({ ...previous, [id]: state })), []);
  const resolve = useCallback<WorkspaceOwnerResolver>(async () => ({ kind: "guest" }), []);
  return <Context value={{ states, setState }}><div className={`${geist.variable} ${geistMono.variable} ${bricolage.variable}`} data-blast-ui="" data-theme="light" suppressHydrationWarning><ShellPrefsBoot nonce={null} /><QueryProvider><ListedKolsContext value={(holderPreview || tradePreview) ? kolCallsigns : []}><ViewerStateProvider active={(holderPreview || tradePreview) && holderSignedIn} getAccessToken={holderToken} resetKey={holderScope}><ShellPortfolioProvider value={shellPortfolio ? UNPRICED_SHELL_PORTFOLIO : NO_SHELL_PORTFOLIO}><AppShell signedIn={false} viewer={null} portfolio={{ status: "unavailable" }} signInHref="/sign-in" overlays={<BlastModeHost accountState={portfolioPreview ? holderSignedIn ? { ...portfolioActor, sessionIdentity: holderScope } : { status: "ready", sessionStatus: "signed_out", account: null } : undefined} getAccessToken={portfolioPreview ? holderToken : undefined} resolveOwner={resolve} ownerKey="trading-fixture" slots={slots} />}><Entry /></AppShell></ShellPortfolioProvider></ViewerStateProvider></ListedKolsContext></QueryProvider></div></Context>;
}
function Entry() {
  const run = useShellActions();
  return <div id="view"><h1>Trading workspace fixture</h1><p>Simulated data and wallet. Sending is disabled.</p><button id="trading-seed" type="button" className="btn btn-primary" onClick={() => {
    const store = createWorkspaceStore();store.setCapacity(4);store.setPresentation("compare");store.setDataCollapsed(false);
    coins.forEach((coin, index) => store.add({ panel_id: ids[index]!, coin_type: coin.coin_type, presale_id: null, chain: "sui", network: "mainnet" }, index));
    store.focus("A");
    const encoded = encodeWorkspace(store.getSnapshot());
    if (encoded.ok) localStorage.setItem(workspaceJournalKey({ actor: { kind: "guest" }, chain: "sui", network: "mainnet" }), encoded.bytes);
    window.location.reload();
  }}>Seed four assets</button><button id="trading-open" type="button" className="btn btn-quiet" onClick={() => run("toggleBlastMode")}>Open Blast mode</button></div>;
}
function Probe() {
  const { dispatch } = useWorkspace();const fixture = useContext(Context)!;
  const queryClient = useAppQueryClient();
  const viewerStore = useViewerStateStore();
  useEffect(() => { if (window.holderFixture) window.holderFixture.setFollowing = (following) => viewerStore?.setFollowing({ kind: "account", callsign: "inesduarte" }, following) ?? Promise.resolve(null); }, [viewerStore]);
  useEffect(() => { if (!window.holderFixture) window.holderFixture = { setSignedIn: () => {} }; window.holderFixture.refreshPnl = () => queryClient.refetchQueries({ queryKey: tradersQuery("24h", { search: "", page: 1, limit: 10 }).queryKey, exact: true }); }, [queryClient]);
  useEffect(() => { window.tradingFixture = { state: fixture.setState, store: dispatch };return () => { delete window.tradingFixture; }; }, [dispatch, fixture.setState]);
  return null;
}
function FixturePanel({ panel }: Readonly<{ panel: PanelSetup }>) {
  if (panel.active_namespace === "presale") return <FixturePresalePanel panel={panel} />;
  return <FixtureCoinPanel panel={panel} />;
}
function FixturePresalePanel({ panel }: Readonly<{ panel: PanelSetup }>) {
  const { dispatch, presentation } = useWorkspace();
  const state = useContext(Context)!.states[panel.panel_id] ?? "ready";
  const detail = useMemo(() => { const value = proofPresales[panel.coin_type.endsWith("::NOVA") ? "NOVA" : "ORBT"]; return { ...value, ...(state === "long-content" ? { terms: { ...value.terms!, buyer_vesting: { cliff_ms: "31536000000", duration_ms: "94608000000" } } } : {}), presale: { ...value.presale, metadata: projectMetadata, ...(state === "long-content" ? { name: auditName, symbol: auditSymbol } : {}), ...(state === "presale-funded" ? { phase: "funded" as const } : state === "presale-cancelled" ? { phase: "cancelled" as const } : {}) }, raise: { ...value.raise, points: value.raise.points.map(([time, usd, atoms]) => [Math.max(time, value.presale.opened_ms ?? value.presale.start_ms), usd, atoms] as const) } }; }, [panel.coin_type, state]);
  const kit = useMemo<CommitKit>(() => ({
    signedIn: true, signIn: () => {}, deposit: () => {},
    quotes: createCommitQuotes({ client: createTestQueryClient(), viewer: "terminal-presale-fixture", read: async () => presaleFacts(detail) }),
    quotePayment: async () => ({ status: "error" }),
    send: async () => { throw new Error("Transactions are disabled in this fixture"); },
  }), [detail]);
  useEffect(() => () => kit.quotes.dispose(), [kit]);
  const reads = useMemo(() => ({ detail: async () => detail, viewer: async () => ({ ...presaleViewer, mine: { ...presaleViewer.mine!, commitment_usd: "250.00", commitment_atoms: "250000000", refund_usd: "0.00", refund_atoms: "0", claimable_tokens: null } }) }), [detail]);
  return <PresalePanel panel_id={panel.panel_id} asset={panel} presale_setup={panel.presale} onSetupChange={presale => dispatch.patchPanel(panel.panel_id, { presale })} effective_visibility={presentation.visible_panel_ids.includes(panel.panel_id)} actions={{ authenticated: true, actor_key: "terminal-presale-fixture", confirmation: { status: "ready", enabled: true }, commit: kit, signIn: () => {} }} reads={reads} />;
}
function FixtureCoinPanel({ panel }: Readonly<{ panel: PanelSetup }>) {
  const { dispatch, presentation } = useWorkspace();const fixture = useContext(Context)!;const state = fixture.states[panel.panel_id] ?? "ready";
  const tradePreview = useSyncExternalStore(subscribeToLocation, tradePreviewSnapshot, serverHolderPreviewSnapshot);
  const [coin] = useState(() => coins.find(c => c.coin_type === panel.coin_type) ?? { ...proofCoins.KSTL, ...proofHomeCoins.find(c => c.symbol === panel.coin_type.split("::").at(-1)), coin_type: panel.coin_type });
  const asset = useMemo(() => (state.startsWith("posts-") || state === "people-ready") ? { ...panel, presale_id: auditPresaleId } : panel, [panel, state]);
  const reads = useMemo<CoinReads>(() => ({
    links: async () => projectMetadata,
    coin: async (_asset, signal) => {
      if (state === "coin-error") throw new Error("Simulated price read failure");
      if (state === "loading") return pending(signal);
      if (state === "unavailable") return null;
      const now = Date.now();
      // The production reader over this page's stubbed catalog and the loaded Discover rows (audit F9).
      if (state === "catalog-coin") return createCoinReads(() => [{ coins: discoveryCoins(now), window: "24h", read_ms: now }]).coin(panel, signal);
      let activity = discoveryCoins(now).find(row => row.coin_type === coin.coin_type)?.activity ?? coin.activity;
      if (state === "activity-zero") activity = { ...homeCoinRows[0]!.activity, from_ms: now - 86_400_000, to_ms: now };
      if (state === "activity-long") activity = { ...(activity ?? homeCoinRows[0]!.activity), from_ms: now - 86_400_000, to_ms: now, buyers: 1_234_567, sellers: 1_234_567_890, participants: 1_235_802_457, events: 1_235_802_457, preview: [] };
      return {
        ...coin,
        activity: state === "activity-unavailable" ? null : activity,
        ...(state === "long-content" ? { name: auditName, symbol: auditSymbol, fdv_usd: "123456789012345.678901", price_usd: "0.000000000000000123" } : {}),
        holders: state === "holders-unavailable" ? null : coin.holders,
        holders_as_of_ms: state === "holders-unavailable" ? null : now - (state === "holders-old" ? 3 * 86_400_000 : 0),
        ...(state === "unpriced" ? { price_usd: null, fdv_usd: null } : {}),
        price_as_of_ms: now - (state === "stale" ? 600_000 : 0),
      };
    },
    chart: async (_asset, _window, signal) => {
      if (state.startsWith("native-")) return nativeTradingHistory(coin.coin_type, state);
      if (state === "loading") return pending(signal);
      if (state === "error") throw new Error("Simulated history error");
      if (state === "unavailable") return null;
      const history = proofHistory(coin.coin_type, coin.symbol !== "LUMN");
      if (state === "sparse") return { ...history, points: history.points.slice(-1).map(([, price]) => [Date.now() - 3 * 86_400_000, price] as const), price_usd: null, quote: undefined };
      if (state === "unpriced") return { ...history, points: [], price_usd: null };
      return state === "empty" ? { ...history, points: [], price_usd: null } : history;
    },
    activity: async (_asset, signal) => {
      if (state === "activity-unavailable") return null;
      if (state === "activity-zero") {
        const now = Date.now();
        return { ...proofThread("KSTL"), participants: [], totals: { ...homeCoinRows[0]!.activity, from_ms: now - 86_400_000, to_ms: now }, clock_ms: now, as_of: { checkpoint: 1, timestamp_ms: now, lag_ms: 0 } };
      }
      if (state === "trades-loading") return pending(signal);
      if (state === "trades-error") throw new Error("Simulated activity read failure");
      if (state === "trades-unavailable") return null;
      if (state === "trades-partial") return { ...chartTradesFixture(coin.coin_type), next_cursor: "fixture-next-page" };
      if (state === "trades-delayed") return { ...chartTradesFixture(coin.coin_type), as_of: { checkpoint: 1, timestamp_ms: Date.now() - 180_000, lag_ms: 180_000 } };
      if (state === "trades-empty") return { ...chartTradesFixture(coin.coin_type), participants: [] };
      return state === "long-content" ? auditThread() : tradePreview ? chartTradesFixture(coin.coin_type) : proofThread("KSTL");
    },
    holders: async (_asset, signal) => {
      if (state === "holders-loading") return pending(signal);
      if (state === "holders-error") throw new Error("Simulated holders failure");
      return state === "unavailable" || state === "holders-unavailable" ? null : state === "holders-ready" || state === "long-content" ? auditHolders() : { share_bps: 0, holders: [] };
    },
    posts: async (asset, cursor, signal) => {
      if (state === "posts-loading") return pending(signal);
      if (state === "posts-error") throw new Error("Simulated posts failure");
      if (state === "people-ready") return chartPostsFixture(asset.coin_type, asset.presale_id!);
      return state === "posts-unavailable" ? null : auditPosts(asset.presale_id!, state === "posts-empty" ? 0 : state === "posts-short" ? 2 : state === "ready" ? discoveryCoins(Date.now()).find(coin => coin.coin_type === asset.coin_type)?.discussion.posts ?? 7 : 7, cursor !== null);
    },
  }), [coin, panel, state, tradePreview]);
  const kit = useMemo<TradeKit>(() => {
    const wallet = () => ({ ...fixtureWallet("sponsored", { kstl: state === "zero" ? BigInt(0) : state === "dust" ? BigInt(1) : undefined, lumn: state === "zero" ? BigInt(0) : undefined }), as_of_ms: Date.now() });
    return {
      signedIn: state !== "guest", signIn: () => {},
      wallet: async () => {
        if (state === "wallet-error") throw new Error("Simulated wallet error");
        if (state === "wallet-loading") return pending();
        return state === "unavailable" ? { ...wallet(), coins: null } : wallet();
      },
      quote: async (request, signal) => state === "quote-loading" ? pending(signal) : state === "quote-error" ? { status: "error" } : state === "quote-no-route" ? { status: "refused", code: "pool_unavailable", retryAfterSeconds: null } : { status: "ok", quote: { ...fixtureTradeQuote(request, { signedIn: true, fee: "blast", nowMs: Date.now(), wallet: wallet() }), slippage_bps: request.slippage_bps ?? 50 } },
      send: async () => { throw new Error("Transactions are disabled in this fixture"); },
    };
  }, [state]);
  const pnl = useCallback(async () => {
    if (state === "pnl-loading") return pending();
    if (state === "pnl-error") throw new Error("Simulated PnL failure");
    if (state === "dust") return null;
    return { basis_usd: "1000.00", basis_complete: state !== "pnl-unknown", pnl_usd: state === "long-content" ? "123456789012345.678901" : state === "pnl-loss" ? "-125.00" : state === "zero" ? null : "260.00", pnl_multiple: state === "pnl-loss" ? "0.8750" : "1.2600" };
  }, [state]);
  return <CoinPanel panel_id={panel.panel_id} asset={asset} coin_setup={panel.coin} onSetupChange={setup => dispatch.patchPanel(panel.panel_id, { coin: setup })} effective_visibility={presentation.visible_panel_ids.includes(panel.panel_id)} actions={{ authenticated: state !== "guest", actor_key: `fixture-wallet:${state}`, trade: kit, pnl, confirmation: { status: "ready", enabled: true }, signIn: () => {} }} reads={reads} />;
}
