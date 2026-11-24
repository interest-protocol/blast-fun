"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AppShell } from "../../../../src/components/blast-ui/AppShell.tsx";
import { useShellActions } from "../../../../src/components/blast-ui/shell-actions.tsx";
import { BlastModeHost } from "../../../../src/components/social/blast-mode/BlastModeHost.tsx";
import { SocialViewerProvider } from "../../../../src/components/social/SignInGate.tsx";
import { useWorkspace } from "../../../../src/components/social/blast-mode/workspace/workspace-context.ts";
import { createWorkspaceStore } from "../../../../src/components/social/blast-mode/workspace/model.ts";
import { workspaceJournalKey } from "../../../../src/components/social/blast-mode/workspace/journal.ts";
import type { SocialAccountState } from "../../../../src/components/social/social-account-client.ts";
import { FixtureData, FixturePanel } from "../adapters";
const slots = {
  panel: FixturePanel,
  data: {
    Coins: FixtureData,
    Presales: FixtureData,
    Traders: FixtureData,
    Activity: FixtureData,
    Feed: FixtureData,
    Portfolio: FixtureData,
  },
  controls: <Controls />,
};
export function SyncFixture() {
  const [identity, setIdentity] = useState<
    SocialAccountState & { sessionIdentity: string }
  >({
    status: "loading",
    account: null,
    sessionIdentity: "",
  });
  const principal = useRef("");
  const generation = useRef(0);
  const invalidate = useCallback(() => {
    generation.current++;
  }, []);
  const getAccessToken = useCallback(
    async () => sessionStorage.getItem("t013-token"),
    [],
  );
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    const token = await getAccessToken();
    if (current !== generation.current) return;
    if (!token) {
      principal.current = "";
      setIdentity({ status: "ready", account: null, sessionIdentity: "" });
      return;
    }
    const sessionIdentity = JSON.parse(
      atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")),
    ).sub as string;
    // Like Privy's user.id, the principal changes before its private me read finishes.
    if (principal.current !== sessionIdentity) {
      principal.current = sessionIdentity;
      setIdentity({ status: "loading", account: null, sessionIdentity });
    }
    try {
      const response = await fetch("/api/social/me", {
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!response.ok) {
        if (current === generation.current)
          setIdentity({ status: "error", account: null, sessionIdentity });
        return;
      }
      const value = await response.json();
      if (current === generation.current)
        setIdentity({
          status: "ready",
          account: value.account,
          sessionIdentity,
        });
    } catch {
      if (current === generation.current)
        setIdentity({ status: "error", account: null, sessionIdentity });
    }
  }, [getAccessToken]);
  useEffect(() => {
    let active = true;
    const update = () => {
      void refresh();
    };
    window.addEventListener("t013-auth-refresh", update);
    queueMicrotask(() => {
      if (active) void refresh();
    });
    return () => {
      active = false;
      invalidate();
      window.removeEventListener("t013-auth-refresh", update);
    };
  }, [invalidate, refresh]);
  return (
    <SocialViewerProvider
      signedIn={Boolean(identity.sessionIdentity)}
      sessionPending={identity.status === "loading"}
      sessionIdentity={identity.sessionIdentity}
      accountId={identity.account?.account_id}
      callsign={identity.account?.callsign}
      getAccessToken={getAccessToken}
    >
      <div data-blast-ui>
        <AppShell
          viewer={null}
          signedIn={Boolean(identity.sessionIdentity)}
          portfolio={{ status: "unavailable" }}
          signInHref="/sign-in"
          overlays={
            <BlastModeHost
              accountState={{
                ...identity,
                sessionStatus:
                  identity.status === "loading"
                    ? "pending"
                    : identity.status === "error"
                      ? "refused"
                      : identity.account
                        ? "authenticated"
                        : "signed_out",
              }}
              getAccessToken={getAccessToken}
              onRetryOwner={() => {
                void refresh();
              }}
              slots={slots}
            />
          }
        >
          <h1>Workspace sync test fixture</h1>
          <p>
            Real private auth routes and PostgreSQL. Auth issuer and
            asset/market adapters are simulated. No transaction provider.
          </p>
          <Entry identity={identity} refresh={refresh} />
        </AppShell>
      </div>
    </SocialViewerProvider>
  );
}
function Entry({
  identity,
  refresh,
}: {
  identity: SocialAccountState;
  refresh: () => Promise<void>;
}) {
  const run = useShellActions();
  async function login(n: number) {
    const response = await fetch(`/api/fixture/sync?account=${n}`);
    const value = await response.json();
    sessionStorage.setItem("t013-token", value.token);
    await refresh();
  }
  return (
    <div>
      <p aria-label="Fixture identity">
        {identity.status} · {identity.account?.account_id ?? "guest"}
      </p>
      {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((n) => (
        <button
          className="btn btn-quiet"
          key={n}
          onClick={() => {
            void login(n);
          }}
        >
          Account {n}
        </button>
      ))}
      <button
        className="btn btn-quiet"
        onClick={() => {
          sessionStorage.removeItem("t013-token");
          void refresh();
        }}
      >
        Guest / logout
      </button>
      <button
        className="btn btn-quiet"
        onClick={() => {
          sessionStorage.setItem("t013-wallet", "changed-wallet");
          void refresh();
        }}
      >
        Change wallet hint
      </button>
      <button className="btn btn-quiet" onClick={() => run("toggleBlastMode")}>
        Open workspace
      </button>
      <button
        className="btn btn-quiet"
        onClick={() => {
          localStorage.setItem(
            workspaceJournalKey({
              actor: { kind: "guest" },
              chain: "sui",
              network: "mainnet",
            }),
            JSON.stringify(mixed()),
          );
          location.reload();
        }}
      >
        Seed guest mixed setup
      </button>
      <button
        className="btn btn-quiet"
        onClick={async () => {
          const value = await (
            await fetch("/api/fixture/sync?account=1&expired")
          ).json();
          sessionStorage.setItem("t013-token", value.token);
        }}
      >
        Expire token
      </button>
    </div>
  );
}
function Controls() {
  const { snapshot, dispatch, owner } = useWorkspace();
  const [sends, setSends] = useState(0);
  return (
    <div style={{ maxHeight: 120, overflow: "auto" }}>
      <p>
        Simulated market adapters · Financial send observer:{" "}
        <span aria-label="Financial sends">{sends}</span>
      </p>
      <button
        className="btn btn-quiet"
        onClick={() => {
          for (let n = 0; n < 35; n++)
            dispatch.add({
              panel_id: `P${n}`,
              chain: "sui",
              network: "mainnet",
              coin_type: `0x2::t013::P${n}`,
              presale_id: n % 2 ? `0x${(n + 1).toString(16)}` : null,
            });
        }}
      >
        Add 35 mixed panels
      </button>
      <button
        className="btn btn-quiet"
        onClick={() => {
          for (const panel of Object.values(snapshot.panels))
            dispatch.patchPanel(panel.panel_id, {
              coin: {
                ...panel.coin,
                trade: { ...panel.coin.trade, side: "sell", slippage_bps: 125 },
              },
              presale: {
                ...panel.presale,
                trade: {
                  ...panel.presale.trade,
                  side: "sell",
                  buy: { typed: "00015.", mode: "typed" },
                  sell: { typed: "0.000000007", mode: "typed" },
                },
                commitment: {
                  ...panel.presale.commitment,
                  amount: "00025.000",
                  why: "Exact browser restore · 雪",
                },
              },
            });
        }}
      >
        Set mixed namespace drafts
      </button>
      <button
        className="btn btn-quiet"
        onClick={() => {
          const controls = snapshot.data.controls;
          dispatch.patchDataControls("Coins", {
            ...controls.Coins,
            source: "watchlist",
            sort: "newest",
            window: "1h",
            min_participants: 5,
            age: "7d",
            tradable: true,
            page: 7,
            rows: 20,
            live: false,
          });
          dispatch.patchDataControls("Presales", {
            ...controls.Presales,
            status: "ended",
            sort: "backed",
            scope: "following",
            view: "calendar",
            layout: "list",
            calendar_range: "past",
            page: 4,
            rows: 5,
          });
          dispatch.patchDataControls("Traders", {
            ...controls.Traders,
            search: "雪 trader",
            search_draft: "雪 trader draft",
            window: "1h",
            page: 8,
            rows: 20,
            live: false,
          });
          dispatch.patchDataControls("Activity", {
            ...controls.Activity,
            window: "1h",
            kinds: ["trade_sell", "presale_commit"],
            page: 3,
            rows: 5,
            cursors: [null, "activity-2", "activity-3"],
          });
          dispatch.patchDataControls("Feed", {
            ...controls.Feed,
            page: 2,
            rows: 20,
            cursors: [null, "feed-2"],
          });
          dispatch.patchDataControls("Portfolio", {
            ...controls.Portfolio,
            tab: "presales",
            coins: { search: "coins 雪", page: 6, hide_small: true },
            presales: { search: "presales exact", page: 9 },
          });
        }}
      >
        Set all Data controls
      </button>
      <button
        className="btn btn-quiet"
        onClick={() => {
          for (const view of snapshot.data.enabled_views)
            dispatch.setDataViewEnabled(view, false);
        }}
      >
        Hide all Data views
      </button>
      <button
        className="btn btn-quiet"
        onClick={() =>
          dispatch.patchDataControls("Portfolio", {
            ...snapshot.data.controls.Portfolio,
            tab: "presales",
            coins: { search: "exact portfolio", page: 3, hide_small: true },
          })
        }
      >
        Set Portfolio controls
      </button>
      <button
        className="btn btn-quiet"
        onClick={() => {
          for (const id of Object.keys(snapshot.panels)) dispatch.remove(id);
        }}
      >
        Remove all panels
      </button>
      <button className="btn btn-quiet" onClick={() => setSends((n) => n + 1)}>
        Explicit simulated financial action
      </button>
      <output aria-label="Workspace owner">{JSON.stringify(owner)}</output>
      <details>
        <summary>Fixture setup evidence</summary>
        <output aria-label="Workspace setup">{JSON.stringify(snapshot)}</output>
      </details>
    </div>
  );
}
function mixed() {
  const store = createWorkspaceStore();
  for (let n = 0; n < 35; n++) {
    const id = store.add({
      panel_id: `P${n}`,
      chain: "sui",
      network: "mainnet",
      coin_type: `0x2::t013::P${n}`,
      presale_id: n % 2 ? `0x${(n + 1).toString(16)}` : null,
    });
    const panel = store.getSnapshot().panels[id]!;
    store.patchPanel(id, {
      active_namespace: n % 2 ? "presale" : "coin",
      coin: {
        ...panel.coin,
        trade: {
          ...panel.coin.trade,
          buy: { typed: "00042.", mode: "typed" },
          sell: { typed: "0.00001", mode: "typed" },
        },
      },
    });
  }
  store.patchDataControls("Portfolio", {
    ...store.getSnapshot().data.controls.Portfolio,
    tab: "presales",
    coins: { search: "seed portfolio", page: 2, hide_small: true },
  });
  return store.getSnapshot();
}
