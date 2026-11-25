import { createRoot } from "react-dom/client";
import { useState } from "react";
import { QueryClient } from "@tanstack/react-query";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { LibraryProviders } from "#web/components/ui-libraries/LibraryProviders.tsx";
import { ShellActionsProvider } from "#web/components/blast-ui/shell-actions.tsx";
import { ToastProvider } from "#web/components/blast-ui/Toasts.tsx";
import { SocialViewerProvider } from "#web/components/social/SignInGate.tsx";
import { SettingsView, type SettingsViewProps } from "#web/components/social/settings/SettingsView.tsx";
import { PortfolioView, type PortfolioViewData } from "#web/components/social/portfolio/PortfolioView.tsx";
import { CreateView } from "#web/components/social/create/CreateView.tsx";
import { createStore, useCreateState } from "#web/components/social/create/create-store.ts";
import { filledSample } from "../../../../../packages/core/test/fixtures/social/create/create-fixtures.ts";
import { CREATE_QUOTE_TYPE } from "@blast/core/modules/social/contracts/create.ts";
import { DEFAULT_NOTIFICATION_PREFERENCES } from "@blast/core/modules/social/contracts/settings.ts";
import { PUBLIC_PREFERRED_COINS, type WalletCoinView } from "#web/components/social/coins/coin-model.ts";
import { TokenPickerBody } from "#web/components/social/coins/TokenPicker.tsx";
import { CreateVesting } from "#web/components/vesting/CreateVesting.tsx";
import { VestingDetail } from "#web/components/vesting/VestingDetail.tsx";
import { ChartVisual } from "#web/components/social/blast-mode/workspace/panels/NativeCoinChart.tsx";
import { Unknown } from "#web/components/social/coin-home/MetricHelp.tsx";
import { LegalPage } from "#web/components/legal/LegalPage.tsx";
import { SalePage } from "#web/components/presale-pages/SalePage.tsx";
import { presaleDetail } from "../workspace/presale-fixtures.ts";
import { presaleDetailQuery } from "#web/components/social/queries.ts";
import type { VestingDetail as Detail } from "@blast/core/modules/vesting/model.ts";
import { address, probe } from "./wallet";
import "#web/components/blast-ui/blast-ui.css";
import "#web/components/ui-libraries/library-csp.css";
import "#web/components/social/create/create.module.css";
import "@fontsource/vt323/400.css";
import "@fontsource/inter/400.css";
import "./style.css";
const noop = () => {};
const nowMs = Date.now();
const coin: WalletCoinView = { ...PUBLIC_PREFERRED_COINS[0]!, atoms: 100000000000n, amount: 100 };
const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: 600000 } } });
client.setQueryData(["blast", "me", "vesting-coins", address], [coin]);
const sale = presaleDetail(new URLSearchParams(location.search).get("view") === "position-open" ? "open" : "trading");
client.setQueryData(presaleDetailQuery(sale.presale.presale_id).queryKey, sale);
const schedule: Detail["schedule"] = { schedule_id: `0x${"b".repeat(64)}`, coin_type: coin.coinType, beneficiary: address, creator: address, total: "1000000000", released: "0", refunded: "0", refund_recipient: null, cancel_cap_id: null, terms: { kind: "checkpoints", checkpoints: [{ timestamp_ms: "1", cumulative_amount: "1000000000" }] }, status: "active", created_timestamp_ms: null, created_digest: null, coin_name: "Sui", coin_symbol: "SUI", coin_decimals: 9, coin_icon_url: null, indexed: true };
client.setQueryData(["blast", "me", "vesting-eligibility", schedule.schedule_id, address], false);
// Controlled APIs only. Block all outgoing network reads, including wallet RPC.
window.fetch = async () => Response.json({ error: { code: "service_unavailable", message: "Controlled read failure" } }, { status: 503 });
createStore.reset({ phase: "ready", ownerId: "fixture", draftId: "fixture", draft: { ...filledSample(), fee_recipients: [{ self: true, label: "You", address: "", bps: 5000 }, { self: false, label: "Operations", address: `0x${"c".repeat(64)}`, bps: 5000 }] }, selfAddress: address, quotes: [CREATE_QUOTE_TYPE], publish: { available: true } });
const settings: SettingsViewProps = { mode: "error", settings: null, wallets: [{ address, kind: "embedded", linked_at_ms: 1 }], callsign: "fixture", celebrate: true, buyAlerts: true, explorer: "suiscan", onNotification: noop, onCelebrate: noop, onBuyAlerts: noop, onBlastConfirmation: noop, onPrivate: noop, onPublicPortfolio: noop, onExplorer: noop, onCopy: () => false, onLinkWallet: noop, onLogOut: noop, onSignIn: noop, onRetry: noop };
const portfolio: PortfolioViewData = { mode: "ready", portfolio: "ready", refreshFailed: true, lastUpdatedMs: 1793000000000, retryPortfolio: noop, figures: { total: 4760.34, coins: 3660.34, committed: 850, claimable: 250 }, today: { usd: 224.84, pct: 4.96 }, isPublic: false, coins: [], prices: new Map(), holdings: { created: [], positions: [], watchlist: [], coins: [], vestings: [] }, holdingsFailed: false, hidden: false, rewards: { status: "off", coins: [], latest: [], retry: noop } };
function Fixture() {
  const [view, setView] = useState(new URLSearchParams(location.search).get("view") ?? "settings");
  const [theme, setTheme] = useState("light");
  const [account, setAccount] = useState(probe.account);
  const state = useCreateState();
  return <div data-blast-ui data-theme={theme}>
    <header className="fixture-controls"><strong>Controlled audit fixture · zero financial effects</strong><label>Surface <select value={view} onChange={event => { setView(event.target.value); history.replaceState({}, "", `?view=${event.target.value}`); }}>{["settings", "settings-ready", "portfolio", "create", "vesting", "detail", "picker-unknown", "picker-known", "chart", "unknown", "legal", "position", "position-open"].map(value => <option key={value}>{value}</option>)}</select></label><button type="button" onClick={() => setTheme(theme === "light" ? "dark" : "light")}>Toggle theme</button><label>Signing observer <select defaultValue={probe.mode} onChange={event => { probe.mode = event.target.value; }}><option>pending</option><option>reject</option><option>lost</option></select></label></header>
    <label>Fixture account <select value={account} onChange={event => { probe.account = event.target.value; setAccount(probe.account); }}><option>A</option><option>B</option><option>signed-out</option></select></label>
    <main className="fixture-main">
      {view === "settings" ? <SettingsView {...settings} /> : null}
      {view === "settings-ready" ? <SettingsView {...settings} mode="account" settings={{ privacy: "public", sharing_since_ms: null, commit_too_coin_type: null, public_portfolio: false, explorer: "suiscan", sound: false, blast_mode_confirm_actions: false, notifications: DEFAULT_NOTIFICATION_PREFERENCES }} /> : null}
      {view === "portfolio" ? <PortfolioView data={portfolio} nowMs={nowMs} /> : null}
      {view === "create" ? <CreateView state={state} onLogo={noop} onList={noop} onPublish={noop} onRetry={noop} signIn={null} /> : null}
      {view === "vesting" ? <CreateVesting /> : null}
      {view === "detail" ? <VestingDetail initial={{ schedule, events: [], now_ms: nowMs }} /> : null}
      {view.startsWith("picker") ? <TokenPickerBody current={null} wallet={view === "picker-known" ? [coin] : []} pins={[]} hidden={false} listCoins={async () => PUBLIC_PREFERRED_COINS} onPick={noop} purpose="vesting" balancesKnown={view === "picker-known"} /> : null}
      {view === "chart" ? <div style={{ height: 420, display: "flex", flexDirection: "column" }}><ChartVisual observations={[{ at: 1792900800000, value: "0.00000000000015001", source: "curve" }, { at: 1792987200000, value: "0.00000000000015002", source: "curve" }]} intervalMs={86400000} units="SUI" label="Tiny price range" /></div> : null}
      {view === "unknown" ? <dl><dt>Raise</dt><dd><Unknown why="Confirmed raise unavailable" /></dd><dt>Close time</dt><dd><Unknown why="Close time unavailable" /></dd></dl> : null}
      {view === "legal" ? <LegalPage current="terms" title="Terms of use" description="Legal contrast verification" effectiveDate="2026-10-26" sections={[{ id: "one", label: "Using Blast" }, { id: "two", label: "Your account and assets" }]}><section id="one"><h2>Using Blast</h2><p>These are controlled fixture contents using the production legal component.</p></section><section id="two"><h2>Your account and assets</h2><p>Read every destination and transaction before approving it.</p></section></LegalPage> : null}
      {view.startsWith("position") ? <SalePage detail={sale} nowMs={nowMs} /> : null}
    </main>
  </div>;
}
Object.assign(window, { auditFixture: { client, coin, store: createStore } });
createRoot(document.getElementById("app")!).render(<LibraryProviders nonce={null}><QueryProvider client={client}><SocialViewerProvider signedIn callsign="fixture" accountId="fixture"><ShellActionsProvider><ToastProvider><Fixture /></ToastProvider></ShellActionsProvider></SocialViewerProvider></QueryProvider></LibraryProviders>);
