"use client";

import { lazy, Suspense, useCallback, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { setFixtureDataPosition } from "./tabs-probe";
import { QueryProvider } from "../../../src/lib/query/provider.tsx";
import { AppShell } from "../../../src/components/blast-ui/AppShell.tsx";
import {
  useShellAction,
  useShellActions,
} from "../../../src/components/blast-ui/shell-actions.tsx";
import { BlastModeHost } from "../../../src/components/social/blast-mode/BlastModeHost.tsx";
import { ShellPrefsBoot } from "../../../src/components/blast-ui/ShellPrefsBoot.tsx";
import { bricolage, geist, geistMono } from "../../../src/components/blast-ui/fonts.ts";
import { WorkspaceRestoreCover } from "../../../src/components/social/blast-mode/workspace/WorkspaceRestoreCover.tsx";
import type { WorkspaceOwnerResolver } from "../../../src/components/social/blast-mode/workspace/workspace-context.ts";

const Panel = lazy(() =>
  import("./adapters").then((module) => ({ default: module.FixturePanel })),
);
const Data = lazy(() =>
  import("./adapters").then((module) => ({ default: module.FixtureData })),
);
const Controls = lazy(() =>
  import("./adapters").then((module) => ({ default: module.FixtureControls })),
);
const slots = {
  panel: Panel,
  data: {
    Coins: Data,
    Presales: Data,
    Bonding: Data,
    Traders: Data,
    Activity: Data,
    Feed: Data,
    Portfolio: Data,
  },
  controls: (
    <Suspense fallback={null}>
      <Controls />
    </Suspense>
  ),
};

export function WorkspaceFixture() {
  const [auth, setAuth] = useState("guest");
  const resolve = useCallback<WorkspaceOwnerResolver>(
    async (signal) => {
      if (auth === "error") throw new Error("Simulated failed account read");
      if (auth === "pending")
        return new Promise((_, reject) =>
          signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          ),
        );
      return auth === "account"
        ? { kind: "account", account_id: "simulated-account" }
        : { kind: "guest" };
    },
    [auth],
  );
  return (
    <QueryProvider>
      <div className={`${bricolage.variable} ${geist.variable} ${geistMono.variable}`} data-blast-ui="" data-theme="light" suppressHydrationWarning>
        <ShellPrefsBoot nonce={null} />
        <WorkspaceRestoreCover />
        <AppShell
          overlays={
            <>
              <BlastModeHost
                accountState={
                  auth === "guest"
                    ? {
                        status: "signed_out",
                        account: null,
                        sessionStatus: "signed_out",
                        sessionIdentity: "",
                      }
                    : undefined
                }
                resolveOwner={auth === "guest" ? undefined : resolve}
                ownerKey={auth}
                slots={slots}
              />
              <SignInSimulation />
            </>
          }
          portfolio={{ status: "unavailable" }}
          signInHref="/sign-in"
          signedIn={false}
          viewer={null}
        >
          <FixturePage auth={auth} setAuth={setAuth} />
        </AppShell>
      </div>
    </QueryProvider>
  );
}

function FixturePage({
  auth,
  setAuth,
}: Readonly<{ auth: string; setAuth: (value: string) => void }>) {
  const path = usePathname();
  const run = useShellActions();
  return (
    <div id="view">
      <h1>
        {path === "/" ? "Home" : path === "/presale" ? "Presales" : "Portfolio"}
      </h1>
      <p role="note">
        Test fixture · API and asset outcomes are simulated. No transaction send
        path is mounted.
      </p>
      <p>
        <Link prefetch={false} href="/">
          Home
        </Link>{" "}
        ·{" "}
        <Link prefetch={false} href="/presale?status=live#next">
          Presales
        </Link>{" "}
        ·{" "}
        <Link prefetch={false} href="/portfolio?tab=coins#holdings">
          Portfolio
        </Link>
      </p>
      <p>
        <button
          className="btn btn-primary"
          id="fixture-open"
          onClick={() => run("toggleBlastMode")}
          type="button"
        >
          Blast mode
        </button>{" "}
        <button
          className="btn btn-quiet"
          onClick={() => void seedMixedSetup(() => run("toggleBlastMode"))}
          type="button"
        >
          Seed mixed setup and enter
        </button>
      </p>
      <label>
        Simulated identity{" "}
        <select
          onChange={(event) => setAuth(event.currentTarget.value)}
          value={auth}
        >
          <option value="guest">Confirmed guest</option>
          <option value="pending">Pending</option>
          <option value="error">Failed</option>
          <option value="account">Account (adapter absent)</option>
        </select>
      </label>
      <p>
        <input aria-label="Origin input" placeholder="B is text here" />{" "}
        <button
          className="btn btn-quiet"
          onClick={() => run("openSignIn")}
          type="button"
        >
          Open sign-in simulation
        </button>
      </p>
      <div aria-hidden="true">
        {Array.from({ length: 32 }, (_, index) => (
          <p key={index}>Origin page content row {index + 1}</p>
        ))}
      </div>
    </div>
  );
}

function SignInSimulation() {
  const [open, setOpen] = useState(false);
  useShellAction("openSignIn", () => setOpen(true));
  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Simulated sign-in"
      style={{
        position: "fixed",
        inset: "25%",
        zIndex: 100,
        background: "white",
        padding: 24,
        border: "1px solid",
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <p>Simulated sign-in overlay · no authentication request</p>
      <button autoFocus onClick={() => setOpen(false)} type="button">
        Close sign-in simulation
      </button>
    </div>
  );
}

async function seedMixedSetup(open: () => void) {
  const [{ createWorkspaceStore }, { encodeWorkspace }, { workspaceJournalKey }] = await Promise.all([
    import("../../../src/components/social/blast-mode/workspace/model.ts"),
    import("@blast/core/modules/social/blast-workspace/codec.ts"),
    import("../../../src/components/social/blast-mode/workspace/journal.ts"),
  ]);
  const store = createWorkspaceStore();
  store.add({
    panel_id: "A",
    chain: "sui",
    network: "mainnet",
    coin_type: "0x2::coin::A",
    presale_id: null,
  });
  store.add({
    panel_id: "B",
    chain: "sui",
    network: "mainnet",
    coin_type: "0x2::coin::B",
    presale_id: "fixture-presale",
  });
  for (const [index, view] of store.getSnapshot().data.enabled_views.entries()) {
    setFixtureDataPosition(store, view, (index + 1) * 11);
  }
  store.patchDataControls("Presales", { ...store.getSnapshot().data.controls.Presales, status: "ended", sort: "recent", scope: "watch", layout: "cards" });
  for (const id of ["A", "B"]) {
    const panel = store.getSnapshot().panels[id]!;
    store.patchPanel(id, {
      coin: { ...panel.coin, trade: { ...panel.coin.trade, buy: { typed: "0007.", mode: "typed" }, sell: { typed: "2.5", mode: "typed" } } },
      presale: { ...panel.presale, commitment: { ...panel.presale.commitment, amount: "0012.", why: "kept hidden-tab draft" } },
    });
  }
  store.selectDataView("Presales");
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
  open();
  window.location.reload();
}
