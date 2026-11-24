import { useContext, useState } from "react";
import { createRoot } from "react-dom/client";
import { QueryProvider } from "#web/lib/query/provider.tsx";
import { LibraryProviders } from "#web/components/ui-libraries/LibraryProviders.tsx";
import { Pager } from "#web/components/blast-ui/Pager.tsx";
import {
  BlastActionProvider,
  type ActionAccountSession,
} from "#web/components/social/blast-mode/workspace/BlastActionProvider.tsx";
import { WorkspaceSaveStatus } from "#web/components/social/blast-mode/workspace/WorkspaceSaveStatus.tsx";
import { WorkspaceHost } from "#web/components/social/blast-mode/workspace/WorkspaceHost.tsx";
import { CoinWorkspaceLayout } from "#web/components/social/blast-mode/workspace/WorkspaceLayout.tsx";
import { PanelHeaderSlotContext } from "#web/components/social/blast-mode/workspace/panels/panel-context.ts";
import { createWorkspaceStore } from "#web/components/social/blast-mode/workspace/model.ts";
import { useWorkspace } from "#web/components/social/blast-mode/workspace/workspace-context.ts";
import { useReportPanelIdentity } from "#web/components/social/blast-mode/workspace/panel-identities.ts";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import "#web/components/blast-ui/blast-ui.css";
import "#web/components/ui-libraries/library-csp.css";

// Controlled data at the host's public slots. No API, wallet or send adapter.
window.fetch = async () => Response.json({ fixture: null });
const store = createWorkspaceStore();
for (const id of ["ALPHA", "BETA", "GAMMA", "DELTA", "EPSILON"]) {
  store.add({
    panel_id: id,
    coin_type: `0x2::fixture::${id}`,
    presale_id: null,
    chain: "sui",
    network: "mainnet",
  });
}
store.setPresentation("focus");
store.focus("ALPHA");
store.setDataCollapsed(true);
const owner = async () => ({
  kind: "account" as const,
  account_id: "layout-fixture",
  store,
});
const account: ActionAccountSession = {
  status: "ready",
  sessionStatus: "authenticated",
  sessionIdentity: "layout-fixture",
  account: {
    account_id: "layout-fixture",
    kind: "new",
    callsign: "fixture",
    display_name: "A long account name for the header",
    avatar_url: null,
    x_handle: null,
    verified: false,
    onboarding: { shown: true, completed: true },
    privacy: "private",
    sharing_since_ms: null,
    wallets: [],
  },
};

function Panel({ panel }: Readonly<{ panel: PanelSetup }>) {
  const header = useContext(PanelHeaderSlotContext);
  useReportPanelIdentity(panel.coin_type, panel.panel_id, null, panel.panel_id);
  return (
    <CoinWorkspaceLayout
      sections={{
        chart: (
          <section aria-label={`${panel.panel_id} price chart`}>
            <div ref={header} />
            <h2>{panel.panel_id} chart</h2>
          </section>
        ),
        trade: (
          <section aria-label={`${panel.panel_id} trade`}>
            <label>
              Draft {panel.panel_id}
              <input aria-label={`Draft ${panel.panel_id}`} defaultValue="123.45" />
            </label>
          </section>
        ),
        activity: <section aria-label={`${panel.panel_id} activity`}>Recorded activity</section>,
        details: null,
      }}
    />
  );
}

function Data() {
  const { snapshot, dispatch } = useWorkspace();
  const controls = snapshot.data.controls.Coins;
  return (
    <>
      <p>Controlled discovery page {controls.page}</p>
      <Pager
        what="fixture coins"
        page={controls.page}
        pages={20}
        onPage={(page) => dispatch.patchDataControls("Coins", { ...controls, page })}
      />
    </>
  );
}

function Fixture() {
  const [open, setOpen] = useState(true);
  return (
    <div data-blast-ui data-theme="light">
      {open ? (
        <WorkspaceHost
          resolveOwner={owner}
          ownerKey="layout-fixture"
          entryGeneration={1}
          onExit={() => setOpen(false)}
          slots={{
            controls: <WorkspaceSaveStatus state="saving" retry={() => {}} />,
            panel: Panel,
            data: {
              Coins: Data,
              Presales: Data,
              Feed: Data,
              Traders: Data,
              Activity: Data,
              Portfolio: Data,
            },
          }}
        />
      ) : (
        <p role="status">Workspace closed</p>
      )}
    </div>
  );
}

createRoot(document.getElementById("app")!).render(
  <LibraryProviders nonce={null}>
    <QueryProvider>
      <BlastActionProvider accountState={account}>
        <Fixture />
      </BlastActionProvider>
    </QueryProvider>
  </LibraryProviders>,
);
