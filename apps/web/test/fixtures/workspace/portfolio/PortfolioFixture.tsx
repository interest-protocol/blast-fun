"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "../../../../src/components/blast-ui/AppShell.tsx";
import { useShellActions } from "../../../../src/components/blast-ui/shell-actions.tsx";
import { setShellPref } from "../../../../src/components/blast-ui/use-shell-prefs.ts";
import { QueryProvider, useAppQueryClient } from "../../../../src/lib/query/provider.tsx";
import { invalidateAfter } from "../../../../src/lib/query/invalidate.ts";
import { BlastModeHost } from "../../../../src/components/social/blast-mode/BlastModeHost.tsx";
import { SocialViewerProvider } from "../../../../src/components/social/SignInGate.tsx";
import { FeedOverlaysProvider } from "../../../../src/components/social/feed-ui/shell-bridge.tsx";
import { createWorkspaceStore } from "../../../../src/components/social/blast-mode/workspace/model.ts";
import { encodeWorkspace } from "@blast/core/modules/social/blast-workspace/codec.ts";
import { workspaceJournalKey } from "../../../../src/components/social/blast-mode/workspace/journal.ts";
import { useWorkspace } from "../../../../src/components/social/blast-mode/workspace/workspace-context.ts";
import type { ActionAccountSession } from "../../../../src/components/social/blast-mode/workspace/BlastActionProvider.tsx";
import type { TradeKit } from "../../../../src/components/social/trade/trade-kit.ts";
import { fixtureCoinType, fixtureTradeQuote, fixtureWallet } from "../../social/trade/trade-fixtures.ts";

type FixtureState = { choose: (n: number) => Promise<void>; identity: ActionAccountSession; mode: string; setMode: (value: string) => void; sends: number; lastActor: string };
const Context = createContext<FixtureState | null>(null);
const FIXTURE_HELD_ATOMS = 600000000000001n;
const NO_ATOMS = 0n;
const guest: ActionAccountSession = { status: "ready", account: null, sessionIdentity: "", sessionStatus: "signed_out" };
export function PortfolioFixture() { return <QueryProvider><Fixture /></QueryProvider>; }
function Fixture() {
  const client = useAppQueryClient();
  const [identity, setIdentity] = useState<ActionAccountSession>(guest);
  const token = useRef<string | null>(null);
  const generation = useRef(0);
  const [mode, setMode] = useState("valid");
  const [sends, setSends] = useState(0);
  const [lastActor, setLastActor] = useState("");
  const getAccessToken = useCallback(async () => token.current, []);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    token.current = sessionStorage.getItem("t020-token");
    if (!token.current) { setIdentity(guest); return; }
    const principal = JSON.parse(atob(token.current.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"))).sub;
    setIdentity({ status: "loading", account: null, sessionIdentity: principal, sessionStatus: "pending" });
    try {
      const response = await fetch("/api/social/me", { headers: { authorization: `Bearer ${token.current}` }, cache: "no-store" });
      const result = response.ok ? await response.json() : null;
      if (generation.current === current) setIdentity(result ? { status: "ready", account: result.account, sessionIdentity: principal, sessionStatus: "authenticated" } : { status: "error", account: null, sessionIdentity: principal, sessionStatus: "refused" });
    } catch { if (generation.current === current) setIdentity({ status: "error", account: null, sessionIdentity: principal, sessionStatus: "refused" }); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const choose = async (n: number) => {
    if (n) { const response = await fetch(`/api/fixture/portfolio?account=${n}`); const { token: value } = await response.json(); sessionStorage.setItem("t020-token", value); }
    else sessionStorage.removeItem("t020-token");
    await refresh();
  };
  const accountId = identity.account?.account_id;
  const signedIn = identity.status === "ready" && !!accountId;
  const kit = useMemo<TradeKit>(() => {
    const wallet = fixtureWallet("sponsored", { kstl: accountId?.endsWith("1") ? FIXTURE_HELD_ATOMS : NO_ATOMS });
    return { signedIn, signIn() {}, wallet: async () => mode === "insufficient" ? fixtureWallet("sponsored", { kstl: NO_ATOMS }) : wallet,
      quote: async request => {
        if (mode === "route-missing") return { status: "error" };
        const quote = fixtureTradeQuote(request, { signedIn, fee: "blast", nowMs: Date.now(), wallet });
        return { status: "ok", quote: mode === "expired" ? { ...quote, expires_at_ms: 1 } : quote };
      },
      send: async input => {
        setSends(n => n + 1); setLastActor(`${accountId}:privy:${input.quote.side}:${input.quote.amount_in}`);
        if (mode === "refused") return { status: "refused", code: "wallet_refused", message: "Controlled wallet refusal. No chain transaction." };
        await invalidateAfter(client, { kind: "trade" });
        return { status: "traded", title: "Controlled fixture result. No chain transaction." };
      },
    };
  }, [signedIn, accountId, mode, client]);
  return <SocialViewerProvider signedIn={signedIn} sessionPending={identity.status === "loading"} sessionIdentity={identity.sessionIdentity} accountId={accountId} callsign={identity.account?.callsign} getAccessToken={getAccessToken}>
    <Context value={{ choose, identity, mode, setMode, sends, lastActor }}><FeedOverlaysProvider value={{ tradeKit: kit }}><div data-blast-ui data-theme="light"><AppShell viewer={null} signedIn={signedIn} portfolio={{ status: "unavailable" }} signInHref="/sign-in" overlays={<BlastModeHost accountState={identity} getAccessToken={getAccessToken} onRetryOwner={() => void refresh()} slots={{ controls: <><Controls /><SetupProbe /></> }} />}><Entry /></AppShell></div></FeedOverlaysProvider></Context>
  </SocialViewerProvider>;
}
function Controls() {
  const value = useContext(Context)!;
  return <div data-fixture-controls>
    <p>Portfolio test fixture · Real private routes and isolated PostgreSQL · controlled issuer, quotes and financial observer · zero chain effects.</p>
    <p>Observer sends <span data-sends>{value.sends}</span> · <span data-last-actor>{value.lastActor}</span></p>
    <p data-identity>{value.identity.status} · {value.identity.account?.callsign ?? "guest"}</p>
    {["Guest", "Account A", "Account B", "Empty account"].map((label, n) => <button className="btn btn-quiet btn-sm" type="button" key={label} onClick={() => void value.choose(n)}>{label}</button>)}
    <label>Final facts <select aria-label="Final facts" value={value.mode} onChange={event => value.setMode(event.currentTarget.value)}>{["valid", "expired", "insufficient", "route-missing", "refused"].map(mode => <option key={mode}>{mode}</option>)}</select></label>
    <button className="btn btn-quiet btn-sm" type="button" onClick={() => setShellPref("amountsHidden", true)}>Hide global amounts</button>
    <button className="btn btn-quiet btn-sm" type="button" onClick={() => setShellPref("amountsHidden", false)}>Show global amounts</button>
  </div>;
}
function SetupProbe() {
  const { snapshot, owner } = useWorkspace();
  return <details><summary>Setup evidence</summary><p data-layout-owner>{owner.kind}</p><output data-setup>{JSON.stringify(snapshot)}</output></details>;
}
function Entry() {
  const run = useShellActions();
  const [arrangement, setArrangement] = useState("absent");
  useEffect(() => {
    if (!sessionStorage.getItem("t020-open-seed")) return;
    sessionStorage.removeItem("t020-open-seed");
    run("toggleBlastMode");
  }, [run]);
  return <div id="view"><h1>Portfolio private-read and Sell fixture</h1><Controls />
    <label>Initial held panel <select aria-label="Initial held panel" value={arrangement} onChange={event => setArrangement(event.currentTarget.value)}>{["absent", "visible", "retained"].map(option => <option key={option}>{option}</option>)}</select></label>
    <button className="btn btn-primary" type="button" onClick={() => {
      const store = createWorkspaceStore(); store.setCapacity(1); store.selectDataView("Portfolio");
      store.patchDataControls("Portfolio", { ...store.getSnapshot().data.controls.Portfolio, tab: "coins" });
      if (arrangement !== "absent") {
        store.add({ panel_id: "held-KSTL", chain: "sui", network: "mainnet", coin_type: fixtureCoinType("KSTL"), presale_id: null });
        const panel = store.getSnapshot().panels["held-KSTL"]!;
        store.patchPanel(panel.panel_id, { coin: { ...panel.coin, trade: { ...panel.coin.trade, buy: { mode: "typed", typed: "100" }, sell: { mode: "typed", typed: "1.000000001" } } } });
        if (arrangement === "retained") store.add({ panel_id: "other", chain: "sui", network: "mainnet", coin_type: fixtureCoinType("LUMN"), presale_id: null });
      }
      const encoded = encodeWorkspace(store.getSnapshot()); if (!encoded.ok) throw new Error(encoded.reason);
      localStorage.setItem(workspaceJournalKey({ actor: { kind: "guest" }, chain: "sui", network: "mainnet" }), encoded.bytes);
      sessionStorage.removeItem("t020-token");
      sessionStorage.setItem("t020-open-seed", "1");
      window.location.reload();
    }}>Open seeded guest Portfolio</button>
    <button className="btn btn-line" type="button" onClick={() => run("toggleBlastMode")}>Resume workspace</button>
  </div>;
}
