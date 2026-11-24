"use client";
import { queryKeys } from "#web/lib/query/keys.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";

import { useMemo } from "react";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import { useTradeKit } from "#web/components/social/feed-ui/shell-bridge.tsx";
import { useAppQueryClient } from "#web/lib/query/provider.tsx";
import type { HomeCoinsPage } from "@blast/core/web/contracts/home.ts";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { createCoinPnlReader } from "./coin-pnl";
import { useCurrentBlastAccount, useCurrentBlastActions } from "../BlastActionProvider";
import { useWorkspace } from "../workspace-context";
import { CoinPanel } from "./CoinPanel";
import { createCoinReads } from "./coin-reads";

/** The host adapter owns layout dispatch; the existing shell kit owns every financial action. */
export function WorkspaceCoinPanel({ panel }: Readonly<{ panel: PanelSetup }>) {
  const { dispatch, presentation, snapshot } = useWorkspace();
  const run = useShellActions();
  const trade = useTradeKit();
  const client = useAppQueryClient();
  const reads = useMemo(
    () =>
      createCoinReads(() =>
        client
          .getQueryCache()
          .findAll({ queryKey: queryKeys.home.discoveries })
          .flatMap((query) => {
            const page = query.state.data as HomeCoinsPage | undefined;
            return page ? [{ coins: page.coins, window: page.window, read_ms: query.state.dataUpdatedAt }] : [];
          }),
      ),
    [client],
  );
  const authority = useCurrentBlastActions();
  const { getAccessToken } = useCurrentBlastAccount();
  const pnl = useMemo(() => createCoinPnlReader(client, getAccessToken), [client, getAccessToken]);
  const authenticated = authority.authenticated && trade?.signedIn === true;
  const actions = {
    trade,
    pnl,
    authenticated,
    actor_key: authority.actor_key,
    confirmation: authority.confirmation,
    signIn: () => {
      if (trade) trade.signIn();
      else run("openSignIn");
    },
  };
  if (panel.active_namespace !== "coin")
    return (
      <div>
        <Button variant="secondary" size="sm"

          type="button"
          onClick={() =>
            dispatch.patchPanel(panel.panel_id, { active_namespace: "coin" })
          }
        >
          Open coin view
        </Button>
      </div>
    );
  return (
    <CoinPanel
      focus={snapshot.presentation === "focus"}
      panel_id={panel.panel_id}
      asset={panel}
      coin_setup={panel.coin}
      onSetupChange={(coin) => dispatch.patchPanel(panel.panel_id, { coin })}
      onPresaleAvailable={presaleId => dispatch.resolvePresale(panel.panel_id, presaleId)}
      onShowSui={() => dispatch.showSui(panel.panel_id)}
      onRemove={() => dispatch.remove(panel.panel_id)}
      effective_visibility={
        presentation.mode_open &&
        presentation.document_visible &&
        presentation.visible_panel_ids.includes(panel.panel_id)
      }
      actions={actions}
      reads={reads}
    />
  );
}
