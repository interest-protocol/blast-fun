"use client";

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ToastProvider } from "../../../../src/components/blast-ui/Toasts.tsx";
import { QueryProvider } from "../../../../src/lib/query/provider.tsx";
import { SocialViewerProvider } from "../../../../src/components/social/SignInGate.tsx";
import { useTradeHost } from "../../../../src/components/social/trade/TradeHost.tsx";
import { useCommitHost } from "../../../../src/components/social/commit/CommitHost.tsx";
import { useBalances } from "../../../../src/components/social/coins/balances.tsx";
import { CoinPanel } from "../../../../src/components/social/blast-mode/workspace/panels/CoinPanel.tsx";
import { PresalePanel } from "../../../../src/components/social/blast-mode/workspace/panels/PresalePanel.tsx";
import { createWorkspaceStore } from "../../../../src/components/social/blast-mode/workspace/model.ts";
import { encodeWorkspace } from "@blast/core/modules/social/blast-workspace/codec.ts";
import { fixtureCoinType } from "../../social/trade/trade-fixtures.ts";
import { presaleAsset } from "../presale-fixtures";
import { FixtureSignerScope } from "../acceptance-auth-stub";
import { createTransactionProvider } from "./provider";

const fixtureAccessToken = async () => "fixture-original-owner";

export function LifetimeFixture() {
  const [, redraw] = useState(0);
  const [provider] = useState(() => createTransactionProvider(() => redraw((value) => value + 1)));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const original = window.fetch;
    window.fetch = (input, init) => String(input).startsWith("/api/") ? provider.fetch(input, init) : original(input, init);
    let active = true;
    queueMicrotask(() => { if (active) setReady(true); });
    return () => { active = false; window.fetch = original; provider.finish(); };
  }, [provider]);
  return ready ? <QueryProvider><SocialViewerProvider signedIn callsign="t015" getAccessToken={fixtureAccessToken}><ToastProvider><LifetimeSurface provider={provider} /></ToastProvider></SocialViewerProvider></QueryProvider> : <p>Preparing controlled provider</p>;
}
export function LifetimeSurface({ provider }: { provider: ReturnType<typeof createTransactionProvider> }) {
  return <FixtureSignerScope signer={provider.signer}><LifetimeContent provider={provider} /></FixtureSignerScope>;
}
function LifetimeContent({ provider }: { provider: ReturnType<typeof createTransactionProvider> }) {
  const balances = useBalances(provider.moved);
  const trade = useTradeHost({ balances });
  const commit = useCommitHost({ presaleDeployed: true, balances });
  const [store] = useState(() => {
    const value = createWorkspaceStore();
    value.add({ panel_id: "coin", chain: "sui", network: "mainnet", coin_type: fixtureCoinType("KSTL"), presale_id: null });
    value.add({ panel_id: "presale", ...presaleAsset });
    const coin = value.getSnapshot().panels.coin!;
    value.patchPanel("coin", { coin: { ...coin.coin, trade: { ...coin.coin.trade, buy: { typed: "100", mode: "typed" }, sell: { typed: "1", mode: "typed" } } } });
    const presale = value.getSnapshot().panels.presale!;
    value.patchPanel("presale", { presale: { ...presale.presale, commitment: { ...presale.presale.commitment, amount: "100" } } });
    return value;
  });
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [presentation, setPresentation] = useState("visible");
  const [active, setActive] = useState("coin");
  const [actor, setActor] = useState("original");
  const [confirmation, setConfirmation] = useState(false);
  const reads = useMemo(() => ({ coin: async () => ({ coin_type: fixtureCoinType("KSTL"), symbol: "KSTL", name: "Kestrel", decimals: 9, price_usd: "0.0021", price_as_of_ms: Date.now() }), chart: async () => null, holders: async () => null, activity: async () => null }), []);
  const presaleReads = useMemo(() => ({ detail: async () => provider.detail, viewer: async () => null }), [provider]);
  const actions = { actor_key: actor, authenticated: true, confirmation: { status: "ready" as const, enabled: confirmation }, signIn() {} };
  const coin = snapshot.panels.coin!;
  const presale = snapshot.panels.presale!;
  const mounted = !["remove", "displace", "exit", "lifecycle"].includes(presentation);
  const visible = presentation === "visible";
  const encoded = encodeWorkspace(snapshot);
  return <main data-blast-ui data-theme="light" style={{ padding: 20, maxWidth: 1000, margin: "auto" }}>
    <h1>Submitted transaction lifetime</h1>
    <p>Controlled API, signer and sponsor fixture. Real shell hosts, kits, flows and panels. No chain transaction.</p>
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
      <button onClick={() => setActive("coin")}>Coin</button><button onClick={() => setActive("presale")}>Presale</button>
      <label>Presentation <select aria-label="Presentation" value={presentation} onChange={(e) => setPresentation(e.currentTarget.value)}>{["visible", "hide", "displace", "remove", "mobile", "Data", "exit", "lifecycle"].map((value) => <option key={value}>{value}</option>)}</select></label>
      <button onClick={() => provider.finish()}>Complete provider</button>
      <button onClick={() => setActor((value) => value === "original" ? "new" : "original")}>Change current account UI</button>
      <label>Confirmation <input type="checkbox" checked={confirmation} onChange={(e) => setConfirmation(e.currentTarget.checked)} /></label>
      <label>Provider outcome <select aria-label="Provider outcome" onChange={(e) => provider.setMode(e.currentTarget.value as "confirmed" | "unknown" | "cancelled")}><option>confirmed</option><option>unknown</option><option>cancelled</option></select></label>
    </div>
    <output data-counts style={{ display: "block", overflowWrap: "anywhere" }}>{JSON.stringify(provider.counts)}</output>
    <output data-logs style={{ display: "block", overflowWrap: "anywhere" }}>{JSON.stringify({ trades: [...provider.trades.values()].map((trade) => trade.status), intents: provider.intents.map((intent) => intent.status) })}</output>
    <output data-setup style={{ display: "none" }}>{encoded.ok ? encoded.bytes : "invalid"}</output>
    <p role="status">{presentation} · {actor}</p>
    {mounted && active === "coin" && <CoinPanel key={presentation === "visible" ? "shown-coin" : "hidden-coin"} panel_id="coin" asset={coin} coin_setup={coin.coin} onSetupChange={(coin) => store.patchPanel("coin", { coin })} effective_visibility={visible} actions={{ ...actions, trade: trade.tradeKit }} reads={reads} />}
    {mounted && active === "presale" && <PresalePanel panel_id="presale" asset={presale} presale_setup={presale.presale} onSetupChange={(presale) => store.patchPanel("presale", { presale })} effective_visibility={visible} actions={{ ...actions, commit: commit.overlays.commitKit! }} reads={presaleReads} />}
    {trade.node}{commit.node}
  </main>;
}
