"use client";

import { createTestQueryClient } from "#web/lib/query/test-client.ts";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { bricolage, geist, geistMono } from "../../../src/components/blast-ui/fonts.ts";
import { AppShell } from "../../../src/components/blast-ui/AppShell.tsx";
import { useShellActions } from "../../../src/components/blast-ui/shell-actions.tsx";
import {
  setShellPref,
  useShellPrefs,
} from "../../../src/components/blast-ui/use-shell-prefs.ts";
import { BlastModeHost } from "../../../src/components/social/blast-mode/BlastModeHost.tsx";
import {
  FeedOverlaysProvider,
  useShellClaimPath,
} from "../../../src/components/social/feed-ui/shell-bridge.tsx";
import { QueryProvider } from "../../../src/lib/query/provider.tsx";
import {
  useWorkspace,
  type WorkspaceOwnerResolver,
} from "../../../src/components/social/blast-mode/workspace/workspace-context.ts";
import { createWorkspaceStore } from "../../../src/components/social/blast-mode/workspace/model.ts";
import { encodeWorkspace } from "@blast/core/modules/social/blast-workspace/codec.ts";
import { workspaceJournalKey } from "../../../src/components/social/blast-mode/workspace/journal.ts";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { PresalePanel } from "../../../src/components/social/blast-mode/workspace/panels/PresalePanel.tsx";
import { createPresaleReads } from "../../../src/components/social/blast-mode/workspace/panels/presale-reads.ts";
import { createCommitQuotes } from "../../../src/components/social/commit/commit-quote.ts";
import type {
  CommitKit,
  CommitFacts,
} from "../../../src/components/social/commit/commit-kit.ts";
import type { PresalePhase } from "@blast/core/modules/social/contracts/presales.ts";
import {
  presaleAsset,
  presaleDetail,
  presaleFacts,
  presaleViewer,
} from "./presale-fixtures";
import {
  fixtureTradeQuote,
  fixtureWallet,
} from "../social/trade/trade-fixtures.ts";

const MODES = [
  "production",
  "open",
  "utc-zero",
  "pending",
  "closed",
  "funded",
  "cancelled",
  "trading",
  "delayed",
  "missing",
  "metadata-incomplete",
  "error",
  "read-pending",
  "quote-failure",
  "refused",
  "gas-change",
  "wallet-missing",
  "insufficient",
  "route-missing",
  "route-wallet-fee",
  "send-pending",
  "send-error",
];
type FixtureState = {
  mode: string;
  setMode: (value: string) => void;
  signedIn: boolean;
  setSignedIn: (value: boolean) => void;
  kit: CommitKit;
  sends: number;
  signIns: number;
  claims: number;
  pending: (() => void) | null;
  setPending: (value: (() => void) | null) => void;
};
const Fixture = createContext<FixtureState | null>(null);
function detailFor(mode: string) {
  const detail = presaleDetail(
    ["pending", "closed", "funded", "cancelled", "trading"].includes(mode)
      ? (mode as PresalePhase)
      : "open",
  );
  if (mode === "utc-zero") {
    const wholeSecond = (at: number) => Math.floor(at / 1000) * 1000;
    return {
      ...detail,
      presale: {
        ...detail.presale,
        end_ms: wholeSecond(detail.presale.end_ms),
      },
      as_of: {
        ...detail.as_of,
        timestamp_ms: wholeSecond(detail.as_of.timestamp_ms),
      },
      raise: {
        ...detail.raise!,
        markers: detail.raise!.markers.map((event) => ({
          ...event,
          t: wholeSecond(event.t),
        })),
      },
    };
  }
  if (mode === "delayed")
    return {
      ...detail,
      as_of: {
        ...detail.as_of,
        timestamp_ms: Date.now() - 3600000,
        lag_ms: 3600000,
      },
    };
  if (mode === "metadata-incomplete") return { ...detail, terms: null };
  return detail;
}
function factsFor(mode: string): CommitFacts {
  const facts = presaleFacts(detailFor(mode));
  if (mode === "wallet-missing")
    return { ...facts, wallet: null, blockers: ["wallet_missing"] };
  if (mode === "insufficient")
    return {
      ...facts,
      viewer: { ...facts.viewer, usdc: 1 },
      wallet: fixtureWallet("sponsored", { usdc: 1000000n }),
    };
  return facts;
}
function seed() {
  const store = createWorkspaceStore();
  store.setDataCollapsed(true);
  store.setCapacity(1);
  store.add({ panel_id: "P", ...presaleAsset });
  const panel = store.getSnapshot().panels.P!;
  store.patchPanel("P", {
    presale: {
      ...panel.presale,
      commitment: { ...panel.presale.commitment, amount: "123.450001" },
    },
  });
  return store;
}
export function PresaleFixture() {
  const [store] = useState(seed);
  const [mode, setMode] = useState("production");
  const [signedIn, setSignedIn] = useState(true);
  const [sends, setSends] = useState(0);
  const [signIns, setSignIns] = useState(0);
  const [claims, setClaims] = useState(0);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const kit = useMemo(
    () =>
      createFixtureKit(mode, signedIn, { setSignIns, setSends, setPending }),
    [signedIn, mode],
  );
  useEffect(() => () => kit.quotes.dispose(), [kit]);
  const resolve = useMemo<WorkspaceOwnerResolver>(
    () => async () =>
      signedIn
        ? { kind: "account", account_id: "presale-observer", store }
        : { kind: "guest" },
    [signedIn, store],
  );
  const claimPath = useMemo(
    () =>
      Object.assign(
        async () => {
          setClaims((value) => value + 1);
          return { status: "failed" as const, code: "rejected" };
        },
        { kinds: ["claim_refund" as const, "claim_tokens" as const] },
      ),
    [],
  );
  const state = {
    mode,
    setMode,
    signedIn,
    setSignedIn,
    kit,
    sends,
    signIns,
    claims,
    pending,
    setPending,
  };
  return (
    <div className={`${geist.variable} ${geistMono.variable} ${bricolage.variable}`} data-blast-ui="" data-theme="light">
      <QueryProvider>
        <Fixture value={state}>
          <FeedOverlaysProvider value={{ commitKit: kit, claimPath }}>
            <AppShell
              signedIn={signedIn}
              viewer={null}
              portfolio={{ status: "unavailable" }}
              signInHref="/sign-in"
              overlays={
                <BlastModeHost
                  resolveOwner={resolve}
                  ownerKey={signedIn ? "observer" : "guest"}
                  slots={{
                    ...(mode === "production"
                      ? {}
                      : { panel: ControlledPresale }),
                    controls: <Controls />,
                  }}
                />
              }
            >
              <Entry
                guest={() => {
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
        </Fixture>
      </QueryProvider>
    </div>
  );
}
function Entry({ guest }: Readonly<{ guest: () => void }>) {
  const run = useShellActions();
  const state = useContext(Fixture)!;
  return (
    <div id="view">
      <h1>Presale panel fixture</h1>
      <p>
        Controlled presale read/provider fixture · observer only · no financial
        transaction.
      </p>
      <button
        className="btn btn-primary"
        type="button"
        onClick={() => run("toggleBlastMode")}
      >
        Open presale workspace
      </button>
      <button className="btn btn-quiet" type="button" onClick={guest}>
        Use confirmed guest journal
      </button>
      <button
        className="btn btn-quiet"
        type="button"
        onClick={() => state.setSignedIn(false)}
      >
        Resume confirmed guest journal
      </button>
      <p>
        Observer sends {state.sends} · sign-in requests {state.signIns} · claims{" "}
        {state.claims}
      </p>
    </div>
  );
}
function Controls() {
  const state = useContext(Fixture)!;
  const { snapshot, dispatch } = useWorkspace();
  const { amountsHidden } = useShellPrefs();
  return (
    <details>
      <summary>
        Controlled observer · sends <span data-sends="">{state.sends}</span> ·
        sign-ins <span data-signins="">{state.signIns}</span> · claims{" "}
        <span data-claims="">{state.claims}</span>
      </summary>
      <label>
        Presale fixture
        <select
          aria-label="Presale fixture"
          value={state.mode}
          onChange={(event) => state.setMode(event.currentTarget.value)}
        >
          {MODES.map((mode) => (
            <option key={mode}>{mode}</option>
          ))}
        </select>
      </label>
      <button
        className="btn btn-quiet btn-sm"
        type="button"
        onClick={() => setShellPref("amountsHidden", !amountsHidden)}
      >
        {amountsHidden ? "Show amounts" : "Hide amounts"}
      </button>
      <button
        className="btn btn-quiet btn-sm"
        type="button"
        onClick={() => {
          const panel = snapshot.panels.P!;
          dispatch.patchPanel("P", {
            presale: {
              ...panel.presale,
              tabs: { selected: null, enabled: [] },
            },
          });
        }}
      >
        Hide all presale tabs
      </button>
      {state.pending && (
        <button
          className="btn btn-quiet btn-sm"
          type="button"
          onClick={state.pending}
        >
          Resolve observer refusal
        </button>
      )}
      <pre data-setup="" style={{ display: "none" }}>
        {JSON.stringify(snapshot)}
      </pre>
    </details>
  );
}
function ControlledPresale({ panel }: Readonly<{ panel: PanelSetup }>) {
  const state = useContext(Fixture)!;
  const { dispatch, presentation } = useWorkspace();
  const reads = useMemo(() => controlledPresaleReads(state.mode), [state.mode]);
  const path = useShellClaimPath();
  return (
    <PresalePanel
      panel_id={panel.panel_id}
      asset={panel}
      presale_setup={panel.presale}
      onSetupChange={(presale) =>
        dispatch.patchPanel(panel.panel_id, { presale })
      }
      onRemove={() => dispatch.remove(panel.panel_id)}
      effective_visibility={
        presentation.mode_open &&
        presentation.document_visible &&
        presentation.visible_panel_ids.includes(panel.panel_id)
      }
      actions={{
        commit: state.kit,
        confirmation: { status: "ready", enabled: true },
        authenticated: state.signedIn,
        actor_key: state.signedIn ? "account:presale-observer" : "guest",
        signIn: state.kit.signIn,
        claimPath: path,
      }}
      reads={reads}
    />
  );
}

function createFixtureKit(
  mode: string,
  signedIn: boolean,
  {
    setSignIns,
    setSends,
    setPending,
  }: Readonly<{
    setSignIns: Dispatch<SetStateAction<number>>;
    setSends: Dispatch<SetStateAction<number>>;
    setPending: Dispatch<SetStateAction<(() => void) | null>>;
  }>,
): CommitKit {
  const quotes = createCommitQuotes<CommitFacts>({
    client: createTestQueryClient(),
    viewer: "observer",
    read: async () =>
      mode === "quote-failure"
        ? null
        : mode === "metadata-incomplete"
          ? presaleFacts()
          : factsFor(mode),
  });
  return {
    signedIn,
    signIn: () => setSignIns((value) => value + 1),
    deposit: () => setSignIns((value) => value + 1),
    quotes: {
      ...quotes,
      fresh: async (id) => {
        const facts = await quotes.fresh(id);
        return mode === "gas-change" && facts
          ? { ...facts, wallet: fixtureWallet("wallet") }
          : facts;
      },
    },
    quotePayment: async (request) => {
      if (mode === "route-missing")
        return { status: "error", code: "route_unavailable" };
      const quoted = fixtureTradeQuote(request, {
        signedIn: true,
        fee: mode === "route-wallet-fee" ? "wallet" : "blast",
        nowMs: Date.now(),
        wallet: fixtureWallet(),
      });
      const out = (BigInt(request.amount_in ?? "0") * 2n) / 1000n;
      return {
        status: "ok",
        httpStatus: 200,
        body: {
          ...quoted,
          amount_out: out.toString(),
          min_out: ((out * 995n) / 1000n).toString(),
          route_label: "SUI → USDC · controlled route",
          price_impact_bps: 0,
        },
      };
    },
    send: async (_facts, _order, options) => {
      setSends((value) => value + 1);
      if (mode === "send-error") throw new Error("Controlled network error");
      if (mode === "send-pending") {
        options?.onPhase?.("signing");
        return new Promise((resolve) =>
          setPending(() => () => {
            setPending(null);
            resolve({
              status: "refused",
              message: "Observer wallet refusal. Nothing was submitted.",
            });
          }),
        );
      }
      return {
        status: "refused",
        message: "Send observer reached once. No transaction submitted.",
      };
    },
  };
}

function controlledPresaleReads(mode: string) {
  let detailReads = 0;
  return {
    ...createPresaleReads(),
    detail: async (_asset: unknown, signal: AbortSignal) => {
      if (mode === "missing") return null;
      if (mode === "error") throw new Error("Controlled read failure");
      if (mode === "read-pending")
        return new Promise<never>((_, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new Error("Stopped fixture")),
            { once: true },
          ),
        );
      detailReads++;
      return mode === "metadata-incomplete" && detailReads > 1
        ? presaleDetail()
        : detailFor(mode);
    },
    viewer: async () => presaleViewer,
  };
}
