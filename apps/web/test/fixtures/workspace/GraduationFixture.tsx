"use client";

import { createTestQueryClient } from "#web/lib/query/test-client.ts";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import {
  decodeWorkspace,
  encodeWorkspace,
} from "@blast/core/modules/social/blast-workspace/codec.ts";
import { createCommitQuotes } from "../../../src/components/social/commit/commit-quote.ts";
import type {
  CommitFacts,
  CommitKit,
} from "../../../src/components/social/commit/commit-kit.ts";
import type { TradeKit } from "../../../src/components/social/trade/trade-kit.ts";
import type { SocialAccountState } from "../../../src/components/social/social-account-client.ts";
import { NOTIFICATION_PREFERENCE_KEYS } from "@blast/core/modules/social/contracts/settings.ts";
import {
  presaleAsset,
  presaleDetail,
  presaleFacts,
  presaleId,
} from "./presale-fixtures";
import { history } from "./coin-fixtures";
import {
  fixtureTradeQuote,
  fixtureWallet,
} from "../social/trade/trade-fixtures.ts";

const identity: SocialAccountState = {
  status: "ready",
  account: {
    account_id: "t016-observer",
    kind: "new",
    callsign: "t016",
    display_name: null,
    avatar_url: null,
    x_handle: null,
    verified: false,
    onboarding: { shown: true, completed: true },
    privacy: "private",
    sharing_since_ms: null,
    wallets: [],
  },
};
const token = async () => "controlled-fixture";
const MODES = [
  "open",
  "timer-ended",
  "funded",
  "trading",
  "metadata-missing",
  "read-error",
  "wrong-identity",
];
const ROUTES = ["supported", "missing", "unsupported", "error"];

function seed() {
  const saved =
    typeof window === "undefined" ? null : sessionStorage.getItem("t016-setup");
  const decoded = saved ? decodeWorkspace(saved) : null;
  if (decoded?.ok) return createWorkspaceStore(decoded.workspace);
  const store = createWorkspaceStore();
  store.setCapacity(2);
  store.setDataCollapsed(true);
  store.add({ panel_id: "P", ...presaleAsset });
  const panel = store.getSnapshot().panels.P!;
  store.patchPanel("P", {
    coin: {
      ...panel.coin,
      chart: {
        renderer: "recharts",
        window: "launch",
        viewport: { from_ms: 1790337660000, to_ms: 1790337840000 },
      },
      trade: {
        ...panel.coin.trade,
        buy: { typed: "00042.", mode: "typed" },
        sell: { typed: ".000001", mode: "typed" },
      },
    },
    presale: {
      ...panel.presale,
      tabs: {
        selected: "activity",
        enabled: ["activity", "overview", "people"],
      },
      commitment: {
        amount: "123.450001",
        why: "Presale-only saved commitment",
        payment_coin_type: null,
      },
    },
  });
  store.add({
    panel_id: "other",
    ...presaleAsset,
    coin_type: "0x2::other::OTHER",
    presale_id: null,
  });
  return store;
}

function lifecycleResponse(mode: string) {
  if (mode === "read-error") return new Response(null, { status: 503 });
  const phase =
    mode === "funded"
      ? "funded"
      : mode === "timer-ended"
        ? "closed"
        : ["trading", "metadata-missing", "wrong-identity"].includes(mode)
          ? "trading"
          : "open";
  const detail = presaleDetail(phase);
  return Response.json({
    ...detail,
    terms: mode === "metadata-missing" ? null : detail.terms,
    presale: {
      ...detail.presale,
      end_ms: mode === "timer-ended" ? 1 : detail.presale.end_ms,
      fill_bps: mode === "funded" ? 10000 : detail.presale.fill_bps,
      sale_token:
        mode === "wrong-identity"
          ? "0x2::other::KSTL"
          : detail.presale.sale_token,
    },
  });
}

/** Controlled HTTP/kit boundaries; the lazy host, adapters, journal model and renderers are production code. */
export function GraduationFixture() {
  const [store] = useState(seed);
  const [mode, setMode] = useState("open");
  const [route, setRoute] = useState("supported");
  const [counts, setCounts] = useState({ detail: 0, quote: 0, sends: 0 });
  const modeRef = useRef(mode);
  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const original = window.fetch;
    window.fetch = async (input, init) => {
      const path = String(input).split("?")[0];
      if (path === `/api/social/presales/${presaleId}`) {
        setCounts((value) => ({ ...value, detail: value.detail + 1 }));
        return lifecycleResponse(modeRef.current);
      }
      if (path === "/api/social/me/settings")
        return Response.json({
          privacy: "private",
          sharing_since_ms: null,
          commit_too_coin_type: null,
          public_portfolio: false,
          explorer: "suiscan",
          sound: false,
          blast_mode_confirm_actions: false,
          notifications: Object.fromEntries(
            NOTIFICATION_PREFERENCE_KEYS.map((key) => [key, false]),
          ),
        });
      if (path === "/api/social/home/coins")
        return Response.json({
          coins: [
            {
              coin_type: presaleAsset.coin_type,
              name: "Kestrel",
              symbol: "KSTL",
              decimals: 9,
              price_usd: "0.0021",
              top_holders: { share_bps: null, holders: [] },
            },
          ],
          missing: [],
          as_of: {},
          clock_ms: Date.now(),
        });
      if (path === "/api/social/prices")
        return Response.json({
          prices: [history(presaleAsset.coin_type)],
          as_of: {},
        });
      if (path === "/api/social/home/activity")
        return Response.json({
          presale_id: presaleId,
          participants: [],
          totals: {},
          as_of: {},
          next_cursor: null,
          window: "24h",
          clock_ms: Date.now(),
        });
      return original(input, init);
    };
    queueMicrotask(() => setReady(true));
    return () => {
      window.fetch = original;
    };
  }, []);
  const kits = useMemo(() => {
    const observed = () => {
      setCounts((value) => ({ ...value, sends: value.sends + 1 }));
      return {
        status: "refused" as const,
        code: null,
        message: "Controlled wallet refusal; nothing submitted",
      };
    };
    const quotes = createCommitQuotes<CommitFacts>({
      client: createTestQueryClient(),
      viewer: "t016",
      read: async () => presaleFacts(),
    });
    const commitKit: CommitKit = {
      signedIn: true,
      signIn() {},
      deposit() {},
      quotes,
      quotePayment: async () => ({ status: "error" }),
      send: async () => observed(),
    };
    const tradeKit: TradeKit = {
      signedIn: true,
      signIn() {},
      wallet: async () => fixtureWallet(),
      quote: async (request) => {
        setCounts((value) => ({ ...value, quote: value.quote + 1 }));
        if (route === "error") return { status: "error" };
        const quote = fixtureTradeQuote(request, {
          signedIn: true,
          fee: "blast",
          nowMs: Date.now(),
          wallet: fixtureWallet(),
        });
        return {
          status: "ok",
          quote: {
            ...quote,
            slippage_bps: request.slippage_bps ?? 50,
            ...(route === "supported"
              ? {}
              : {
                  quote_id: null,
                  expires_at_ms: null,
                  amount_out: null,
                  min_out: null,
                  route_label:
                    route === "unsupported"
                      ? "Unsupported trading route"
                      : "No trading route",
                }),
          },
        };
      },
      send: async () => observed(),
    };
    return { commitKit, tradeKit };
  }, [route]);
  useEffect(() => () => kits.commitKit.quotes.dispose(), [kits]);
  const resolve = useCallback<WorkspaceOwnerResolver>(
    async () => ({ kind: "account", account_id: "t016-observer", store }),
    [store],
  );
  return (
    <div data-blast-ui data-theme="light">
      <QueryProvider>
        <FeedOverlaysProvider value={kits}>
          <AppShell
            signedIn
            viewer={null}
            portfolio={{ status: "unavailable" }}
            signInHref="/sign-in"
            overlays={
              ready ? (
                <BlastModeHost
                  accountState={identity}
                  getAccessToken={token}
                  resolveOwner={resolve}
                  ownerKey="t016-observer"
                  slots={{
                    controls: (
                      <Controls
                        mode={mode}
                        route={route}
                        setMode={setMode}
                        setRoute={setRoute}
                        counts={counts}
                      />
                    ),
                  }}
                />
              ) : null
            }
          >
            <Entry ready={ready} />
          </AppShell>
        </FeedOverlaysProvider>
      </QueryProvider>
    </div>
  );
}

function Entry({ ready }: Readonly<{ ready: boolean }>) {
  const run = useShellActions();
  return (
    <div id="view">
      <h1>Presale graduation fixture</h1>
      <p>
        Controlled lifecycle, metadata and trading provider. No database or
        chain transaction.
      </p>
      <button
        className="btn btn-primary"
        disabled={!ready}
        onClick={() => run("toggleBlastMode")}
      >
        Open graduation workspace
      </button>
    </div>
  );
}

function Controls({
  mode,
  route,
  setMode,
  setRoute,
  counts,
}: Readonly<{
  mode: string;
  route: string;
  setMode: (value: string) => void;
  setRoute: (value: string) => void;
  counts: { detail: number; quote: number; sends: number };
}>) {
  const { snapshot, dispatch } = useWorkspace();
  useEffect(() => {
    const encoded = encodeWorkspace(snapshot);
    if (encoded.ok) sessionStorage.setItem("t016-setup", encoded.bytes);
  }, [snapshot]);
  return (
    <details>
      <summary>
        Controlled lifecycle · sends <span data-sends>{counts.sends}</span>
      </summary>
      <label>
        Authoritative read{" "}
        <select
          aria-label="Authoritative read"
          value={mode}
          onChange={(event) => setMode(event.currentTarget.value)}
        >
          {MODES.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>{" "}
      <label>
        Trading route{" "}
        <select
          aria-label="Trading route"
          value={route}
          onChange={(event) => setRoute(event.currentTarget.value)}
        >
          {ROUTES.map((value) => (
            <option key={value}>{value}</option>
          ))}
        </select>
      </label>{" "}
      <button
        className="btn btn-quiet btn-sm"
        onClick={() => dispatch.setCapacity(1)}
      >
        Retain presale
      </button>{" "}
      <button
        className="btn btn-quiet btn-sm"
        onClick={() =>
          dispatch.add({
            panel_id: "readded",
            ...presaleAsset,
            presale_id: null,
          })
        }
      >
        Present coin identity
      </button>{" "}
      <button
        className="btn btn-quiet btn-sm"
        onClick={() => {
          const panel = snapshot.panels.P!;
          dispatch.patchPanel("P", {
            coin: {
              ...panel.coin,
              tabs: { selected: "activity", enabled: ["activity", "overview"] },
            },
          });
        }}
      >
        Remember Trades tab
      </button>
      <output data-counts style={{ display: "block" }}>
        {JSON.stringify(counts)}
      </output>
      <pre data-setup hidden>
        {JSON.stringify(snapshot)}
      </pre>
    </details>
  );
}
