"use client";

import { useCallback, useState } from "react";
import { AppShell } from "../../../src/components/blast-ui/AppShell.tsx";
import { useShellActions } from "../../../src/components/blast-ui/shell-actions.tsx";
import { BlastModeHost } from "../../../src/components/social/blast-mode/BlastModeHost.tsx";
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
import { PresalePanel } from "../../../src/components/social/blast-mode/workspace/panels/PresalePanel.tsx";
import type { CoinReads } from "../../../src/components/social/blast-mode/workspace/panels/coin-reads.ts";
import type { PresaleReads } from "../../../src/components/social/blast-mode/workspace/panels/presale-reads.ts";
import { coinRows, history } from "./coin-fixtures";
import { presaleAsset, presaleDetail } from "./presale-fixtures";

const inputs = [
  { panel_id: "A", coin_type: coinRows[0]!.coin_type, presale_id: null },
  { panel_id: "B", ...presaleAsset },
  { panel_id: "C", coin_type: coinRows[1]!.coin_type, presale_id: null },
  {
    panel_id: "D",
    ...presaleAsset,
    coin_type: `0x${"8".repeat(64)}::lumen::LUMN`,
    presale_id: `0x${"9".repeat(64)}`,
  },
  { panel_id: "E", coin_type: "0x2::retained::FIRST", presale_id: null },
  { panel_id: "F", coin_type: "0x2::retained::SECOND", presale_id: null },
];
function seed(management = false) {
  const store = createWorkspaceStore();
  const assets = management
    ? [
        ...inputs.slice(0, 4),
        inputs[5]!,
        inputs[4]!,
        ...Array.from({ length: 29 }, (_, index) => ({
          panel_id: `History${index}`,
          coin_type:
            index < 2
              ? `0x${index + 3}::same::SAME`
              : `0x2::history::HISTORY${index}`,
          presale_id: null,
        })),
      ]
    : inputs;
  for (const input of assets.toReversed()) {
    store.add({ ...input, chain: "sui", network: "mainnet" }, management ? undefined : inputs.indexOf(input) < 4 ? inputs.indexOf(input) : null);
    const panel = store.getSnapshot().panels[input.panel_id]!;
    store.patchPanel(panel.panel_id, {
      active_namespace: panel.presale_id ? "presale" : "coin",
      coin: {
        ...panel.coin,
        trade: {
          ...panel.coin.trade,
          buy: {
            typed: `000${panel.panel_id === "A" ? "42" : "12"}.`,
            mode: "typed",
          },
          sell: { typed: ".000001", mode: "typed" },
        },
      },
      presale: {
        ...panel.presale,
        commitment: {
          amount: "123.450001",
          why: "Saved layout draft",
          payment_coin_type: null,
        },
      },
    });
  }
  store.patchDataControls("Portfolio", {
    ...store.getSnapshot().data.controls.Portfolio,
    tab: "presales",
    coins: { search: "preserved search", page: 2, hide_small: true },
  });
  store.selectDataView("Portfolio");
  return store;
}
const coinReads: CoinReads = {
  coin: async (asset) => ({
    ...coinRows[0]!,
    coin_type: asset.coin_type,
    symbol: asset.coin_type.endsWith("::SECOND") ? "A_TOKEN_SYMBOL_WITHOUT_ANY_BREAKS_0123456789" : asset.coin_type.split("::").at(-1)!,
    name: asset.coin_type.endsWith("::FIRST") ? "International Community Treasury Token — a deliberately long asset name for responsive verification" : "Controlled geometry coin",
    price_usd: asset.coin_type.endsWith("::FIRST") ? "0.00000000000000000012345" : coinRows[0]!.usd_price,
    price_as_of_ms: Date.now(),
  }),
  chart: async (asset) => history(asset.coin_type),
  holders: async () => null,
  activity: async () => null,
};
const presaleReads: PresaleReads = {
  detail: async (asset) => {
    const detail = presaleDetail();
    return {
      ...detail,
      presale: {
        ...detail.presale,
        presale_id: asset.presale_id!,
        sale_token: asset.coin_type,
        symbol: asset.coin_type.split("::").at(-1)!,
        name: "Controlled geometry presale",
      },
    };
  },
  viewer: async () => null,
};
const slots = {
  panel: LayoutPanel,
  data: {
    Coins: LayoutData,
    Presales: LayoutData,
    Traders: LayoutData,
    Activity: LayoutData,
    Feed: LayoutData,
    Portfolio: LayoutData,
  },
  controls: <LayoutProbe />,
};

export function LayoutFixture({
  management = false,
}: Readonly<{ management?: boolean }>) {
  const [store] = useState(() => seed(management));
  const resolve = useCallback<WorkspaceOwnerResolver>(
    async () => ({ kind: "guest" }),
    [],
  );
  return (
    <div data-blast-ui="" data-theme="light">
      <QueryProvider>
        <AppShell
          signedIn={false}
          viewer={null}
          portfolio={{ status: "unavailable" }}
          signInHref="/sign-in"
          overlays={
            <BlastModeHost
              resolveOwner={resolve}
              ownerKey="layout-guest"
              slots={
                management
                  ? { ...slots, controls: <LayoutProbe management /> }
                  : slots
              }
            />
          }
        >
          <Entry
            management={management}
            seed={() => {
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
            }}
          />
        </AppShell>
      </QueryProvider>
    </div>
  );
}
function Entry({
  seed,
  management,
}: Readonly<{ seed: () => void; management: boolean }>) {
  const run = useShellActions();
  return (
    <div id="view">
      <h1>Mixed panel layout fixture</h1>
      <p>
        Controlled typed readers · real CoinPanel and PresalePanel · no
        financial provider or send path.
      </p>
      <button
        className="btn btn-primary"
        type="button"
        onClick={() => {
          seed();
          run("toggleBlastMode");
          window.location.reload();
        }}
      >
        {management ? "Seed panel management" : "Seed mixed layout"}
      </button>
      <button
        className="btn btn-quiet"
        type="button"
        onClick={() => run("toggleBlastMode")}
      >
        Resume layout
      </button>
    </div>
  );
}
function LayoutPanel({ panel }: Readonly<{ panel: PanelSetup }>) {
  const { dispatch, presentation } = useWorkspace();
  const visible =
    presentation.mode_open &&
    presentation.document_visible &&
    presentation.visible_panel_ids.includes(panel.panel_id);
  const actions = {
    authenticated: false,
    actor_key: "guest",
    confirmation: {status:"ready" as const, enabled:true},
    signIn: () => {},
  };
  return panel.active_namespace === "coin" ? (
    <CoinPanel
      panel_id={panel.panel_id}
      asset={panel}
      coin_setup={panel.coin}
      onSetupChange={(coin) => dispatch.patchPanel(panel.panel_id, { coin })}
      effective_visibility={visible}
      actions={{ ...actions, trade: null }}
      reads={coinReads}
    />
  ) : (
    <PresalePanel
      panel_id={panel.panel_id}
      asset={panel}
      presale_setup={panel.presale}
      onSetupChange={(presale) =>
        dispatch.patchPanel(panel.panel_id, { presale })
      }
      effective_visibility={visible}
      actions={{ ...actions, commit: null }}
      reads={presaleReads}
    />
  );
}
function LayoutProbe({
  management = false,
}: Readonly<{ management?: boolean }>) {
  const { snapshot, presentation, dispatch } = useWorkspace();
  return (
    <>
      {management && (
        <div
          style={{ display: "flex", flexWrap: "wrap", gap: 8, flexShrink: 0 }}
        >
          {["E", "B", "D"].map((id) => (
            <button
              className="btn btn-quiet btn-sm"
              key={id}
              onClick={() => {
                const input = inputs.find((asset) => asset.panel_id === id)!;
                dispatch.add({
                  ...input,
                  panel_id: `new-${id}`,
                  chain: "sui",
                  network: "mainnet",
                });
              }}
              type="button"
            >
              Add {id}
            </button>
          ))}
          <span style={{ alignSelf: "center", fontSize: 12 }}>
            Controlled fixture · send paths: 0
          </span>
        </div>
      )}
      <details
        data-layout-fixture=""
        style={{ lineHeight: "20px", flexShrink: 0 }}
      >
        <summary>Controlled layout evidence · no transaction provider</summary>
        <output aria-label="Presentation facts">
          {JSON.stringify(presentation)}
        </output>
        <output aria-label="Saved setup">{JSON.stringify(snapshot)}</output>
      </details>
    </>
  );
}
function LayoutData() {
  const { snapshot, dispatch } = useWorkspace();
  const controls = snapshot.data.controls.Portfolio;
  return (
    <div>
      <p>Controlled {snapshot.data.selected_view} Data · saved controls</p>
      <label>
        Portfolio search
        <input
          aria-label="Portfolio search"
          value={controls.coins.search}
          onChange={(event) =>
            dispatch.patchDataControls("Portfolio", {
              ...controls,
              coins: { ...controls.coins, search: event.currentTarget.value },
            })
          }
        />
      </label>
      {Array.from({ length: 28 }, (_, index) => (
        <p key={index}>Controlled Data row {index + 1}</p>
      ))}
    </div>
  );
}
