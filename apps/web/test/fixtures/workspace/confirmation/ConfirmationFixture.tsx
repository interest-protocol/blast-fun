"use client";

import { createTestQueryClient } from "#web/lib/query/test-client.ts";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { AppShell } from "../../../../src/components/blast-ui/AppShell.tsx";
import { useShellActions } from "../../../../src/components/blast-ui/shell-actions.tsx";
import { QueryProvider } from "../../../../src/lib/query/provider.tsx";
import { BlastModeHost } from "../../../../src/components/social/blast-mode/BlastModeHost.tsx";
import { SocialViewerProvider } from "../../../../src/components/social/SignInGate.tsx";
import { SocialAccountContext } from "../../../../src/components/social/use-social-account.ts";
import { SettingsScreen } from "../../../../src/components/social/settings/SettingsScreen.tsx";
import { FeedOverlaysProvider } from "../../../../src/components/social/feed-ui/shell-bridge.tsx";
import { createWorkspaceStore } from "../../../../src/components/social/blast-mode/workspace/model.ts";
import { encodeWorkspace } from "@blast/core/modules/social/blast-workspace/codec.ts";
import { workspaceJournalKey } from "../../../../src/components/social/blast-mode/workspace/journal.ts";
import type { ActionAccountSession } from "../../../../src/components/social/blast-mode/workspace/BlastActionProvider.tsx";
import { createCommitQuotes } from "../../../../src/components/social/commit/commit-quote.ts";
import type {
  CommitFacts,
  CommitKit,
} from "../../../../src/components/social/commit/commit-kit.ts";
import type { TradeKit } from "../../../../src/components/social/trade/trade-kit.ts";
import { presaleAsset, presaleDetail, presaleFacts } from "../presale-fixtures";
import { coinTypes } from "../coin-fixtures";
import {
  fixtureTradeQuote,
  fixtureWallet,
} from "../../social/trade/trade-fixtures.ts";

const Context = createContext<{
  choose(n: number): Promise<void>;
  mode: string;
  setMode(mode: string): void;
  sends: number;
  identity: ActionAccountSession;
} | null>(null);
function seed() {
  const store = createWorkspaceStore();
  store.setCapacity(2);
  store.setDataCollapsed(true);
  store.add({
    panel_id: "C",
    chain: "sui",
    network: "mainnet",
    coin_type: coinTypes[0]!,
    presale_id: null,
  });
  const coin = store.getSnapshot().panels.C!;
  store.patchPanel("C", {
    coin: {
      ...coin.coin,
      trade: {
        ...coin.coin.trade,
        buy: { mode: "typed", typed: "100" },
        sell: { mode: "typed", typed: "1" },
      },
    },
  });
  store.add({ panel_id: "P", ...presaleAsset });
  const sale = store.getSnapshot().panels.P!;
  store.patchPanel("P", {
    presale: {
      ...sale.presale,
      commitment: { ...sale.presale.commitment, amount: "123.450001" },
    },
  });
  return store;
}
export function ConfirmationFixture() {
  return (
    <QueryProvider>
      <Fixture />
    </QueryProvider>
  );
}
function Fixture() {
  const [identity, setIdentity] = useState<ActionAccountSession>({
    status: "ready",
    account: null,
    sessionIdentity: "",
    sessionStatus: "signed_out",
  });
  const [mode, setMode] = useState("valid");
  const [sends, setSends] = useState(0);
  const getAccessToken = useCallback(
    async () => sessionStorage.getItem("t014-token"),
    [],
  );
  const loadIdentity = useCallback(async (token: string | null) => {
    if (!token) {
      setIdentity({
        status: "ready",
        account: null,
        sessionIdentity: "",
        sessionStatus: "signed_out",
      });
      return;
    }
    const principal = JSON.parse(
      atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")),
    ).sub;
    setIdentity({
      status: "loading",
      account: null,
      sessionIdentity: principal,
      sessionStatus: "pending",
    });
    try {
      const response = await fetch("/api/social/me", {
        headers: { authorization: `Bearer ${token}` },
        cache: "no-store",
      });
      if (!response.ok) {
        setIdentity({
          status: "error",
          account: null,
          sessionIdentity: principal,
          sessionStatus: "refused",
        });
        return;
      }
      const { account } = await response.json();
      setIdentity({
        status: "ready",
        account,
        sessionIdentity: principal,
        sessionStatus: "authenticated",
      });
    } catch {
      setIdentity({
        status: "error",
        account: null,
        sessionIdentity: principal,
        sessionStatus: "refused",
      });
    }
  }, []);
  const refresh = useCallback(async () => {
    await loadIdentity(await getAccessToken());
  }, [getAccessToken, loadIdentity]);
  useEffect(() => {
    void getAccessToken().then(loadIdentity);
  }, [getAccessToken, loadIdentity]);
  const choose = async (n: number) => {
    if (n) {
      const response = await fetch(`/api/fixture/confirmation?account=${n}`);
      const { token } = await response.json();
      sessionStorage.setItem("t014-token", token);
    } else sessionStorage.removeItem("t014-token");
    await refresh();
  };
  const signedIn = !!identity.account && identity.status === "ready";
  const kits = useMemo(() => {
    // Fixed terms within this mounted provider; scenario controls change only the final public boundary.
    const facts = presaleFacts(presaleDetail());
    const wallet = fixtureWallet();
    const observed = async () => {
      setSends((n) => n + 1);
      return {
        status: "refused" as const,
        message: "Observer wallet refusal. No chain transaction submitted.",
      };
    };
    const trade: TradeKit = {
      signedIn,
      signIn() {},
      wallet: async () =>
        mode === "insufficient"
          ? fixtureWallet("sponsored", { usdc: BigInt(0) })
          : wallet,
      quote: async (request) => {
        if (mode === "route-missing") return { status: "error" };
        const quote = fixtureTradeQuote(request, {
          signedIn,
          fee: "blast",
          nowMs: Date.now(),
          wallet,
        });
        return {
          status: "ok",
          quote: mode === "expired" ? { ...quote, expires_at_ms: 1 } : quote,
        };
      },
      send: async () => {
        const result = await observed();
        return mode === "gas"
          ? { status: "fee_required", feeMist: "1000", payable: true }
          : { ...result, code: "wallet_refused" };
      },
    };
    const quotes = createCommitQuotes<CommitFacts>({
      client: createTestQueryClient(),
      viewer: identity.sessionIdentity ?? "guest",
      read: async () => facts,
    });
    const commit: CommitKit = {
      signedIn,
      signIn() {},
      deposit() {},
      quotes: {
        ...quotes,
        fresh: async () =>
          mode === "terms-changed"
            ? {
                ...facts,
                sale: {
                  ...facts.sale!,
                  presalePrice: facts.sale!.presalePrice! * 2,
                },
              }
            : mode === "gas"
              ? { ...facts, wallet: fixtureWallet("wallet") }
              : facts,
      },
      quotePayment: async () => ({ status: "error" }),
      send: observed,
    };
    return { trade, commit };
  }, [signedIn, identity.sessionIdentity, mode]);
  useEffect(() => () => kits.commit.quotes.dispose(), [kits]);
  return (
    <SocialViewerProvider
      signedIn={signedIn}
      sessionPending={identity.status === "loading"}
      sessionIdentity={identity.sessionIdentity}
      accountId={identity.account?.account_id}
      callsign={identity.account?.callsign}
      getAccessToken={getAccessToken}
    >
      <SocialAccountContext value={{ ...identity, refresh }}>
        <Context value={{ choose, mode, setMode, sends, identity }}>
          <FeedOverlaysProvider
            value={{ tradeKit: kits.trade, commitKit: kits.commit }}
          >
            <div data-blast-ui data-theme="light">
              <AppShell
                viewer={null}
                signedIn={signedIn}
                portfolio={{ status: "unavailable" }}
                signInHref="/sign-in"
                overlays={
                  <BlastModeHost
                    accountState={identity}
                    getAccessToken={getAccessToken}
                    slots={{ controls: <Controls /> }}
                  />
                }
              >
                <Entry />
              </AppShell>
            </div>
          </FeedOverlaysProvider>
        </Context>
      </SocialAccountContext>
    </SocialViewerProvider>
  );
}
function Controls() {
  const fixture = useContext(Context)!;
  return (
    <div data-fixture-controls>
      <p>
        Test fixture · Real authenticated Settings and PostgreSQL · controlled
        issuer and market/send boundaries · sends{" "}
        <span data-sends>{fixture.sends}</span>
      </p>
      <button
        type="button"
        className="btn btn-quiet btn-sm"
        onClick={() => void fixture.choose(1)}
      >
        Account A
      </button>
      <button
        type="button"
        className="btn btn-quiet btn-sm"
        onClick={() => void fixture.choose(2)}
      >
        Account B
      </button>
      <button
        type="button"
        className="btn btn-quiet btn-sm"
        onClick={() => void fixture.choose(0)}
      >
        Guest
      </button>
      <label>
        Final facts{" "}
        <select
          aria-label="Final facts"
          value={fixture.mode}
          onChange={(event) => fixture.setMode(event.currentTarget.value)}
        >
          {[
            "valid",
            "route-missing",
            "expired",
            "insufficient",
            "terms-changed",
            "gas",
          ].map((mode) => (
            <option key={mode}>{mode}</option>
          ))}
        </select>
      </label>
      <p data-identity>
        {fixture.identity.status} ·{" "}
        {fixture.identity.account?.callsign ?? "guest"}
      </p>
      <details>
        <summary>Account Settings</summary>
        <SettingsScreen />
      </details>
    </div>
  );
}
function Entry() {
  const run = useShellActions();
  return (
    <div id="view">
      <h1>Blast action confirmation fixture</h1>
      <Controls />
      <button
        className="btn btn-primary"
        type="button"
        onClick={() => {
          const encoded = encodeWorkspace(seed().getSnapshot());
          if (!encoded.ok) throw new Error(encoded.reason);
          localStorage.setItem(
            workspaceJournalKey({
              actor: { kind: "guest" },
              chain: "sui",
              network: "mainnet",
            }),
            encoded.bytes,
          );
          run("toggleBlastMode");
        }}
      >
        Open seeded guest workspace
      </button>
    </div>
  );
}
