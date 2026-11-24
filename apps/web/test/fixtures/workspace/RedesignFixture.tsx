"use client";

import { useCallback, useState, useSyncExternalStore } from "react";
import { AppShell } from "../../../src/components/blast-ui/AppShell.tsx";
import { useShellActions } from "../../../src/components/blast-ui/shell-actions.tsx";
import { BlastModeHost } from "../../../src/components/social/blast-mode/BlastModeHost.tsx";
import { QueryProvider } from "../../../src/lib/query/provider.tsx";
import { bricolage, geist, geistMono } from "../../../src/components/blast-ui/fonts.ts";
import { useWorkspace, type WorkspaceOwnerResolver } from "../../../src/components/social/blast-mode/workspace/workspace-context.ts";
import { createWorkspaceStore } from "../../../src/components/social/blast-mode/workspace/model.ts";
import { encodeWorkspace } from "@blast/core/modules/social/blast-workspace/codec.ts";
import { coreCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { workspaceJournalKey } from "../../../src/components/social/blast-mode/workspace/journal.ts";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { CoinPanel } from "../../../src/components/social/blast-mode/workspace/panels/CoinPanel.tsx";
import { PresalePanel } from "../../../src/components/social/blast-mode/workspace/panels/PresalePanel.tsx";
import { CoinsData } from "../../../src/components/social/blast-mode/workspace/CoinsData.tsx";
import { PresalesData } from "../../../src/components/social/blast-mode/workspace/PresalesData.tsx";
import { TradersData } from "../../../src/components/social/blast-mode/workspace/TradersData.tsx";
import { ActivityData } from "../../../src/components/social/blast-mode/workspace/ActivityData.tsx";
import { FeedData } from "../../../src/components/social/blast-mode/workspace/FeedData.tsx";
import { PortfolioData } from "../../../src/components/social/blast-mode/workspace/PortfolioData.tsx";
import type { CoinReads } from "../../../src/components/social/blast-mode/workspace/panels/coin-reads.ts";
import type { PresaleReads } from "../../../src/components/social/blast-mode/workspace/panels/presale-reads.ts";
import { proofActivity, proofBonding, proofCoins, proofCoinTypes, proofHistory, proofHomeCoins, proofMarket, proofPresaleIds, proofPresales, proofThread, proofTraders, proofViewer } from "./redesign-fixtures";

/**
 * Visual proof for the Blast mode redesign: the production frame, panels and
 * Data views with invented sample people and coins. Reads are answered in the
 * page (panels through their read seams, Data views through a fetch stub for
 * the public Home routes, the coin market and the launchpad's curves). No
 * provider, signature or send path exists. `?view=` picks the Data view the
 * seeded workspace opens to.
 */
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }));
if (typeof window !== "undefined" && !(window as { __proofFetch?: boolean }).__proofFetch) {
  (window as { __proofFetch?: boolean }).__proofFetch = true;
  const original = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, window.location.href);
    const meta = { window: "24h", clock_ms: Date.now(), as_of: proofTraders.as_of, missing: [] };
    if (url.pathname === "/api/social/home") return json({ ...meta, coins: proofHomeCoins, page: 1, pages: 1, total: proofHomeCoins.length, ranked: proofHomeCoins.filter((coin) => coin.activity.events > 0).length, next_cursor: null });
    if (url.pathname === "/api/social/home/coins") {
      const ids = new Set(url.searchParams.getAll("presale"));
      return json({ ...meta, coins: proofHomeCoins.filter((coin) => ids.size === 0 || ids.has(coin.presale_id ?? "")), pool_volumes: {} });
    }
    if (url.pathname === "/api/social/home/traders") return json(proofTraders);
    if (url.pathname === "/api/social/home/activity-stream") return json(proofActivity);
    if (url.pathname === "/api/social/home/market") return json(proofMarket(url.searchParams.get("coin") ?? proofCoinTypes.KSTL));
    if (url.pathname === "/api/launchpad/discovery") return json(proofBonding(url.searchParams.get("sort") === "progress" ? "near_graduation" : url.searchParams.get("view") ?? "new"));
    return original(input, init);
  };
}

const inputs = [
  { panel_id: "A", coin_type: proofCoinTypes.KSTL, presale_id: null, namespace: "coin", tab: "overview" },
  { panel_id: "B", coin_type: proofCoinTypes.NOVA, presale_id: proofPresaleIds.NOVA, namespace: "presale", tab: "overview" },
  { panel_id: "C", coin_type: proofCoinTypes.LUMN, presale_id: null, namespace: "coin", tab: "activity" },
  { panel_id: "D", coin_type: proofCoinTypes.ORBT, presale_id: proofPresaleIds.ORBT, namespace: "presale", tab: "people" },
] as const;
function seed() {
  const store = createWorkspaceStore();
  for (const [index, input] of [...inputs.entries()].toReversed()) {
    store.add({ panel_id: input.panel_id, coin_type: input.coin_type, presale_id: input.presale_id, chain: "sui", network: "mainnet" }, index);
    const panel = store.getSnapshot().panels[input.panel_id]!;
    store.patchPanel(panel.panel_id, {
      active_namespace: input.namespace,
      coin: { ...panel.coin, tabs: { ...panel.coin.tabs, selected: input.namespace === "coin" ? input.tab : panel.coin.tabs.selected }, trade: { ...panel.coin.trade, buy: { typed: input.panel_id === "A" ? "42.00" : "1234567.891", mode: "typed" }, sell: { typed: "12400000.123456", mode: "typed" } } },
      presale: { ...panel.presale, tabs: { enabled: ["overview", "activity", "people", "posts"], selected: input.namespace === "presale" ? input.tab : panel.presale.tabs.selected }, commitment: { amount: input.panel_id === "B" ? "100.00" : "250000.000001", why: "", payment_coin_type: null } },
    });
  }
  const view = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("view");
  store.selectDataView(view === "Bonding" ? "Bonding" : "Coins");
  return store;
}
const coinFor = (asset: { coin_type: string }) => (asset.coin_type === proofCoinTypes.LUMN ? proofCoins.LUMN : proofCoins.KSTL);
const coinReads: CoinReads = {
  // A curated ecosystem coin opened from Coins has no record here, so its panel shows the missing-coin prompt.
  coin: async (asset) => (coreCoin(asset.coin_type) ? null : { ...coinFor(asset), price_as_of_ms: Date.now() }),
  chart: async (asset) => proofHistory(asset.coin_type, coinFor(asset).symbol === "KSTL"),
  holders: async (asset) => coinFor(asset).top_holders ?? null,
  activity: async (asset) => proofThread(coinFor(asset).symbol as "KSTL" | "LUMN"),
};
const saleFor = (asset: { presale_id: string | null }) => (asset.presale_id === proofPresaleIds.ORBT ? "ORBT" : "NOVA");
const presaleReads: PresaleReads = {
  detail: async (asset) => proofPresales[saleFor(asset)],
  viewer: async (asset) => proofViewer(saleFor(asset)),
};
const slots = {
  panel: ProofPanel,
  data: { Coins: CoinsData, Presales: PresalesData, Traders: TradersData, Activity: ActivityData, Feed: FeedData, Portfolio: PortfolioData },
};

const noSubscription = () => () => {};
const urlTheme = () => new URLSearchParams(window.location.search).get("theme") ?? "light";

export function RedesignFixture() {
  const [store] = useState(seed);
  const resolve = useCallback<WorkspaceOwnerResolver>(async () => ({ kind: "guest" }), []);
  // The server renders light; the client reads ?theme= without a hydration mismatch.
  const theme = useSyncExternalStore(noSubscription, urlTheme, () => "light");
  return (
    <div className={`${geist.variable} ${geistMono.variable} ${bricolage.variable}`} data-blast-ui="" data-theme={theme}>
      <QueryProvider>
        <AppShell signedIn={false} viewer={null} portfolio={{ status: "unavailable" }} signInHref="/sign-in" overlays={<BlastModeHost resolveOwner={resolve} ownerKey="redesign-guest" slots={slots} />}>
          <Entry seed={() => {
            const encoded = encodeWorkspace(store.getSnapshot());
            if (!encoded.ok) throw new Error(encoded.reason);
            localStorage.setItem(workspaceJournalKey({ actor: { kind: "guest" }, chain: "sui", network: "mainnet" }), encoded.bytes);
          }} />
        </AppShell>
      </QueryProvider>
    </div>
  );
}
function Entry({ seed }: Readonly<{ seed: () => void }>) {
  const run = useShellActions();
  return (
    <div id="view">
      <h1>Blast mode redesign proof</h1>
      <p>Invented sample people and coins · production components · no financial provider or send path.</p>
      <button className="btn btn-primary" id="proof-seed" type="button" onClick={() => { seed(); run("toggleBlastMode"); window.location.reload(); }}>Seed proof workspace</button>
      <button className="btn btn-quiet" id="proof-open" type="button" onClick={() => run("toggleBlastMode")}>Open Blast mode</button>
    </div>
  );
}
function ProofPanel({ panel }: Readonly<{ panel: PanelSetup }>) {
  const { dispatch, presentation } = useWorkspace();
  const visible = presentation.mode_open && presentation.document_visible && presentation.visible_panel_ids.includes(panel.panel_id);
  const actions = { authenticated: false, actor_key: "guest", confirmation: { status: "ready" as const, enabled: true }, signIn: () => {} };
  return panel.active_namespace === "coin" ? (
    <CoinPanel panel_id={panel.panel_id} asset={panel} coin_setup={panel.coin} onSetupChange={(coin) => dispatch.patchPanel(panel.panel_id, { coin })} onShowSui={() => dispatch.showSui(panel.panel_id)} onRemove={() => dispatch.remove(panel.panel_id)} effective_visibility={visible} actions={{ ...actions, trade: null }} reads={coinReads} />
  ) : (
    <PresalePanel panel_id={panel.panel_id} asset={panel} presale_setup={panel.presale} onSetupChange={(presale) => dispatch.patchPanel(panel.panel_id, { presale })} effective_visibility={visible} actions={{ ...actions, commit: null }} reads={presaleReads} />
  );
}
