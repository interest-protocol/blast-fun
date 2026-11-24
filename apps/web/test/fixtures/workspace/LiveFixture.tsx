"use client";

import { createTestQueryClient } from "#web/lib/query/test-client.ts";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "../../../src/components/blast-ui/AppShell.tsx";
import { useShellActions } from "../../../src/components/blast-ui/shell-actions.tsx";
import { BlastModeHost } from "../../../src/components/social/blast-mode/BlastModeHost.tsx";
import { workspaceSession } from "../../../src/components/social/blast-mode/workspace/session.ts";
import { WorkspaceLiveProvider } from "../../../src/components/social/blast-mode/workspace/live-clock.tsx";
import { useWorkspace, type WorkspaceOwnerResolver } from "../../../src/components/social/blast-mode/workspace/workspace-context.ts";
import { FeedOverlaysProvider } from "../../../src/components/social/feed-ui/shell-bridge.tsx";
import { SocialViewerProvider } from "../../../src/components/social/SignInGate.tsx";
import { QueryProvider } from "../../../src/lib/query/provider.tsx";
import { createCommitQuotes } from "../../../src/components/social/commit/commit-quote.ts";
import type { CommitFacts, CommitKit } from "../../../src/components/social/commit/commit-kit.ts";
import type { TradeKit } from "../../../src/components/social/trade/trade-kit.ts";
import type { SocialAccountState } from "../../../src/components/social/social-account-client.ts";
import { handClock } from "./live-clock";
import { liveStore } from "./live-fixtures";

const token = async () => "controlled-fixture";
const identity: SocialAccountState = { status: "ready", account: { account_id: "t017", kind: "new", callsign: "t017", display_name: null, avatar_url: null, x_handle: null, verified: false, onboarding: { shown: true, completed: true }, privacy: "private", sharing_since_ms: null, wallets: [] } };
type Event = { path: string; phase: "request" | "answer" | "aborted" };

/** Production lazy host, clients and adapters; real loopback HTTP, controlled financial boundaries. */
export function LiveFixture() {
  const [store] = useState(liveStore);
  const [time] = useState(() => handClock(Date.now()));
  const [events] = useState<Event[]>([]);
  const [ready, setReady] = useState(false);
  const controls = useRef({ hold: "", fail: "", releases: [] as (() => void)[], sends: 0 });
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const path = String(input);
      if (!path.startsWith("/api/social/") && !path.startsWith("/kit/")) return original(input, init);
      events.push({ path, phase: "request" });
      const response = await original(`/api/fixture/live?path=${encodeURIComponent(path)}`, init);
      // A provider that ignores cancellation is intentional late-answer evidence.
      if (controls.current.hold && path.includes(controls.current.hold)) await new Promise<void>((resolve) => controls.current.releases.push(resolve));
      events.push({ path, phase: init?.signal?.aborted ? "aborted" : "answer" });
      return controls.current.fail && path.includes(controls.current.fail) ? new Response(null, { status: 503 }) : response;
    };
    const inspect = () => ({ events: [...events], timers: [...time.timers.values()].map(({ at }) => at - time.clock.now()), sends: controls.current.sends, setup: store.getSnapshot() });
    const api = {
      inspect, clear: () => { events.length = 0; }, advance: time.advance,
      document: (shown: boolean) => { Object.defineProperty(document, "visibilityState", { configurable: true, value: shown ? "visible" : "hidden" }); document.dispatchEvent(new window.Event("visibilitychange")); },
      mobile: store.selectMobile, data: (open: boolean) => store.setDataCollapsed(!open),
      mode: (open: boolean) => open ? workspaceSession().open({ path: "/live", scroll_x: 0, scroll_y: 0, main_scroll_top: 0 }) : workspaceSession().close(),
      tab: (id: string, selected: "overview" | "people" | "activity") => { const panel = store.getSnapshot().panels[id]!; store.patchPanel(id, { coin: { ...panel.coin, tabs: { ...panel.coin.tabs, selected } } }); },
      hold: (path: string) => { controls.current.hold = path; }, fail: (path: string) => { controls.current.fail = path; },
      release: () => { controls.current.hold = ""; for (const release of controls.current.releases.splice(0)) release(); },
    };
    Object.assign(window, { liveFixture: api });
    queueMicrotask(() => setReady(true));
    return () => { api.release(); window.fetch = original; };
  }, [controls, events, store, time]);
  const kits = useMemo(() => {
    const quotes = createCommitQuotes<CommitFacts>({ client: createTestQueryClient(), viewer: "t017", read: async (id) => (await fetch(`/kit/commit-facts?presale=${id}`)).json() });
    const send = async () => { controls.current.sends++; return { status: "refused" as const, code: null, message: "Controlled refusal; nothing submitted" }; };
    const commitKit: CommitKit = { signedIn: true, signIn() {}, deposit() {}, quotes, send, quotePayment: async () => ({ status: "error" }) };
    const tradeKit: TradeKit = { signedIn: true, signIn() {}, wallet: async () => (await fetch("/kit/wallet")).json(), quote: async (request) => (await fetch("/kit/trade-quote", { method: "POST", body: JSON.stringify(request) })).json(), send };
    return { tradeKit, commitKit };
  }, [controls]);
  useEffect(() => () => kits.commitKit.quotes.dispose(), [kits]);
  const resolve = useCallback<WorkspaceOwnerResolver>(async () => ({ kind: "account", account_id: "t017", store }), [store]);
  return <div data-blast-ui data-theme="light"><QueryProvider><SocialViewerProvider signedIn callsign="t017" getAccessToken={token}><WorkspaceLiveProvider clock={time.clock}><FeedOverlaysProvider value={kits}>
    <AppShell signedIn viewer={null} portfolio={{ status: "unavailable" }} signInHref="/sign-in" overlays={ready ? <BlastModeHost accountState={identity} getAccessToken={token} resolveOwner={resolve} ownerKey="t017" slots={{ controls: <Observations /> }} /> : null}><Entry ready={ready} /></AppShell>
  </FeedOverlaysProvider></WorkspaceLiveProvider></SocialViewerProvider></QueryProvider></div>;
}
function Entry({ ready }: Readonly<{ ready: boolean }>) {
  const run = useShellActions();
  return <div id="view"><h1>Live ownership fixture</h1><p>Four mixed panels, 31 retained. Controlled provider; no database or chain effects.</p><button disabled={!ready} onClick={() => run("toggleBlastMode")}>Open live workspace</button></div>;
}
function Observations() {
  const { snapshot, presentation } = useWorkspace();
  return <output hidden data-live-presentation>{JSON.stringify({ presentation, retained: snapshot.retained_order.length })}</output>;
}
