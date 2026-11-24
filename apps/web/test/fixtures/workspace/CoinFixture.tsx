"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from "react";
import { Button } from "../../../src/components/blast-ui/Button.tsx";
import { setShellPref } from "../../../src/components/blast-ui/use-shell-prefs.ts";
import { AppShell } from "../../../src/components/blast-ui/AppShell.tsx";
import { useShellActions } from "../../../src/components/blast-ui/shell-actions.tsx";
import { BlastModeHost } from "../../../src/components/social/blast-mode/BlastModeHost.tsx";
import { FeedOverlaysProvider } from "../../../src/components/social/feed-ui/shell-bridge.tsx";
import { QueryProvider } from "../../../src/lib/query/provider.tsx";
import {
  useWorkspace,
  type WorkspaceOwnerResolver,
} from "../../../src/components/social/blast-mode/workspace/workspace-context.ts";
import { createWorkspaceStore } from "../../../src/components/social/blast-mode/workspace/model.ts";
import { encodeWorkspace } from "@blast/core/modules/social/blast-workspace/codec.ts";
import { workspaceJournalKey } from "../../../src/components/social/blast-mode/workspace/journal.ts";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { CoinPanel } from "../../../src/components/social/blast-mode/workspace/panels/CoinPanel.tsx";
import {
  createCoinReads,
  nativeCoinChartReader,
} from "../../../src/components/social/blast-mode/workspace/panels/coin-reads.ts";
import { browserMarketDependencies } from "../../../src/components/launchpad/blast-infra-browser.ts";
import type { TradeKit } from "../../../src/components/social/trade/trade-kit.ts";
import {
  fixtureTradeQuote,
  fixtureWallet,
} from "../social/trade/trade-fixtures.ts";
import curve from "../../../../../packages/core/test/fixtures/modules/launchpad-contract/fixtures/v1-pool-candles-curve.json";
import venue from "../../../../../packages/core/test/fixtures/modules/launchpad-contract/fixtures/v1-pool-candles-cetus.json";
import { coinTypes, denseChartHistory, history, saleId } from "./coin-fixtures";

type FixtureState = Readonly<{
  mode: string;
  setMode: (mode: string) => void;
  kit: TradeKit;
  signedIn: boolean;
  sends: number;
  signIns: number;
}>;
const FixtureContext = createContext<FixtureState | null>(null);
const useFixture = () => useContext(FixtureContext)!;

function seededStore() {
  const store = createWorkspaceStore();
  store.setCapacity(2);
  store.setDataCollapsed(true);
  coinTypes.forEach((coin_type, index) => {
    const panel_id = index ? "B" : "A";
    store.add({
      panel_id,
      chain: "sui",
      network: "mainnet",
      coin_type,
      presale_id: index ? saleId : null,
    });
    const panel = store.getSnapshot().panels[panel_id]!;
    store.patchPanel(panel_id, {
      active_namespace: "coin",
      coin: {
        ...panel.coin,
        trade: { ...panel.coin.trade, buy: { typed: "100", mode: "typed" } },
      },
    });
  });
  return store;
}

export function CoinFixture() {
  const [store] = useState(seededStore);
  const [signedIn, setSignedIn] = useState(true);
  const [mode, setMode] = useState("production");
  const [sends, setSends] = useState(0);
  const [signIns, setSignIns] = useState(0);
  const kit = useMemo<TradeKit>(
    () => ({
      signedIn,
      signIn: () => setSignIns((value) => value + 1),
      wallet: async () => fixtureWallet(),
      quote: async (request, signal) => {
        if (mode === "trade-pending")
          return new Promise<never>((_, reject) =>
            signal?.addEventListener(
              "abort",
              () => reject(new Error("Fixture cancelled")),
              { once: true },
            ),
          );
        if (mode === "trade-error") return { status: "error" };
        return {
          status: "ok",
          quote: {
            ...fixtureTradeQuote(request, {
              signedIn,
              fee: "blast",
              nowMs: Date.now(),
              wallet: fixtureWallet(),
            }),
            slippage_bps: request.slippage_bps ?? 50,
            ...(mode === "trade-missing"
              ? {
                  quote_id: null,
                  expires_at_ms: null,
                  amount_out: null,
                  min_out: null,
                  fee_amount: null,
                  blast_fee_amount: null,
                  network_fee: null,
                  price_impact_bps: null,
                }
              : {}),
          },
        };
      },
      send: async (input) => {
        setSends((value) => value + 1);
        if (mode === "trade-fee" && !input.acceptFee)
          return {
            status: "fee_required",
            feeMist: "1234567",
            requiredMist: "2000000",
            payable: true,
          };
        return {
          status: "pending",
          title:
            "Send observer only: awaiting confirmation; no transaction submitted",
        };
      },
    }),
    [signedIn, mode],
  );
  const resolve = useCallback<WorkspaceOwnerResolver>(
    async () =>
      signedIn
        ? { kind: "account", account_id: "sandbox-observer", store }
        : { kind: "guest" },
    [signedIn, store],
  );
  const slots = {
    ...(mode === "production" ? {} : { panel: ControlledPanel }),
    controls: <FixtureControls />,
  };
  return (
    <div data-blast-ui="" data-theme="light">
      <QueryProvider>
        <FixtureContext
          value={{ mode, setMode, kit, signedIn, sends, signIns }}
        >
          <FeedOverlaysProvider value={{ tradeKit: kit }}>
            <AppShell
              signedIn={signedIn}
              viewer={null}
              portfolio={{ status: "unavailable" }}
              signInHref="/sign-in"
              overlays={
                <BlastModeHost
                  resolveOwner={resolve}
                  ownerKey={signedIn ? "observer" : "guest"}
                  slots={slots}
                />
              }
            >
              <Entry
                onResumeGuest={() => setSignedIn(false)}
                onGuest={() => {
                  const encoded = encodeWorkspace(store.getSnapshot());
                  if (!encoded.ok) throw new Error(encoded.reason);
                  localStorage.setItem(
                    workspaceJournalKey({
                      actor: { kind: "guest" },
                      chain: "sui",
                      network: "mainnet",
                    }),
                    encoded.bytes,
                  );
                  setSignedIn(false);
                }}
              />
            </AppShell>
          </FeedOverlaysProvider>
        </FixtureContext>
      </QueryProvider>
    </div>
  );
}

function Entry({
  onGuest,
  onResumeGuest,
}: Readonly<{ onGuest: () => void; onResumeGuest: () => void }>) {
  const run = useShellActions();
  const state = useFixture();
  return (
    <div id="view">
      <h1>Coin panel fixture</h1>
      <p>
        Controlled read/provider fixture · financial send observer only · no
        network transaction
      </p>
      <button
        className="btn btn-primary"
        type="button"
        onClick={() => run("toggleBlastMode")}
      >
        Open coin workspace
      </button>
      <button className="btn btn-quiet" type="button" onClick={onGuest}>
        Use confirmed guest journal
      </button>
      <button className="btn btn-quiet" type="button" onClick={onResumeGuest}>
        Resume confirmed guest journal
      </button>
      <p>
        Observer sends {state.sends} · sign-in requests {state.signIns}
      </p>
    </div>
  );
}

function FixtureControls() {
  const state = useFixture();
  const { snapshot, dispatch, presentation } = useWorkspace();
  return (
    <details data-coin-fixture="">
      <summary>
        Controlled provider · observer only · sends{" "}
        <span data-sends="">{state.sends}</span> · sign-in requests{" "}
        <span data-signins="">{state.signIns}</span>
      </summary>
      <p>
        Controlled provider reads · send observer only · no transaction · sends{" "}
        <span>{state.sends}</span> · sign-in requests{" "}
        <span>{state.signIns}</span>
      </p>
      <Button size="sm" onClick={() => setShellPref("theme", "light")}>Fixture light theme</Button>
      <Button size="sm" onClick={() => setShellPref("theme", "dark")}>Fixture dark theme</Button>
      <label>
        Read fixture{" "}
        <select
          aria-label="Read fixture"
          value={state.mode}
          onChange={(event) => state.setMode(event.currentTarget.value)}
        >
          {[
            "production",
            "dense-synthetic",
            "pending",
            "quote-only",
            "one",
            "none",
            "error",
            "unknown",
            "native",
            "trade-pending",
            "trade-error",
            "trade-missing",
            "trade-fee",
          ].map((mode) => (
            <option key={mode}>{mode}</option>
          ))}
        </select>
      </label>
      <label>
        Mobile panel
        <select
          aria-label="Mobile panel"
          value={snapshot.mobile_panel_id ?? ""}
          onChange={(event) => dispatch.selectMobile(event.currentTarget.value)}
        >
          {snapshot.visible_order.map((id) => (
            <option key={id}>{id}</option>
          ))}
        </select>
      </label>
      <button
        className="btn btn-quiet btn-sm"
        type="button"
        onClick={() => dispatch.setDataCollapsed(!snapshot.data.collapsed)}
      >
        Toggle Data coverage
      </button>
      <button
        className="btn btn-quiet btn-sm"
        type="button"
        onClick={() =>
          dispatch.patchPanel("A", {
            coin: {
              ...snapshot.panels.A!.coin,
              tabs: {
                ...snapshot.panels.A!.coin.tabs,
                selected: "overview",
                enabled: snapshot.panels.A!.coin.tabs.enabled.includes("people")
                  ? ["overview", "activity"]
                  : ["overview", "activity", "people"],
              },
            },
          })
        }
      >
        Toggle A holders tab
      </button>
      <output
        data-presentation=""
        style={{ display: "block", overflowWrap: "anywhere" }}
      >
        {JSON.stringify(presentation)}
      </output>
      <pre data-setup="" style={{ display: "none" }}>
        {JSON.stringify(snapshot)}
      </pre>
    </details>
  );
}

function ControlledPanel({ panel }: Readonly<{ panel: PanelSetup }>) {
  const state = useFixture();
  const { dispatch, presentation } = useWorkspace();
  const { chain, network, coin_type, presale_id } = panel;
  const asset = useMemo(
    () => ({ chain, network, coin_type, presale_id }),
    [chain, network, coin_type, presale_id],
  );
  const reads = useMemo(() => {
    const production = createCoinReads();
    const at = curve.provenance.timestamp_ms + 400;
    const fetcher: typeof fetch = async (input) => {
      const path = String(input);
      const body = path.includes("/cetus/") ? venue : curve;
      return Response.json(
        path.endsWith("/status")
          ? {
              provenance: { ...curve.provenance, observed_ms: at, lag_ms: 400 },
            }
          : {
              ...body,
              provenance: { ...body.provenance, observed_ms: at, lag_ms: 400 },
            },
      );
    };
    const native = nativeCoinChartReader({
      asset: { ...asset, network: "localnet" },
      source: {
        expected: null,
        curvePoolKey: curve.migration.curve_pool_key,
        venuePoolKey: curve.migration.venue_pool_key,
        migration: null,
        symbol: "C",
        quoteSymbol: "SUI",
        memeDecimals: 6,
        quoteDecimals: 9,
      },
      dependencies: browserMarketDependencies(null, fetcher, () => at),
      now: () => at,
    });
    return {
      ...production,
      coin: state.mode === "unknown" ? async () => null : production.coin,
      chart: async (...args: Parameters<typeof production.chart>) => {
        if (state.mode === "pending")
          return new Promise<never>((_, reject) =>
            args[2].addEventListener(
              "abort",
              () => reject(new Error("Fixture cancelled")),
              { once: true },
            ),
          );
        if (state.mode === "dense-synthetic")
          return denseChartHistory(asset.coin_type, args[1], args[3] as "5m" | "1h" | "1d" | undefined);
        if (state.mode === "error")
          throw new Error("Controlled unavailable source");
        if (state.mode === "native")
          return native({ ...args[0], network: "localnet" }, args[1], args[2]);
        return history(
          asset.coin_type,
          state.mode === "quote-only",
          state.mode === "none" ? 0 : state.mode === "one" ? 1 : 4,
        );
      },
    };
  }, [asset, state.mode]);
  return (
    <CoinPanel
      panel_id={panel.panel_id}
      asset={
        state.mode === "native" ? { ...panel, network: "localnet" } : panel
      }
      coin_setup={panel.coin}
      onSetupChange={(coin) => dispatch.patchPanel(panel.panel_id, { coin })}
      effective_visibility={
        presentation.document_visible &&
        presentation.mode_open &&
        presentation.visible_panel_ids.includes(panel.panel_id)
      }
      actions={{
        trade: state.kit,
        authenticated: state.signedIn,
        actor_key: `${state.signedIn ? "observer" : "guest"}:${state.mode}`,
        signIn: state.kit.signIn,
      }}
      reads={reads}
    />
  );
}
