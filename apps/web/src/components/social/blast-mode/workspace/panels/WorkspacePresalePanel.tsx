"use client";

import { useMemo } from "react";
import { useShellActions } from "#web/components/blast-ui/shell-actions.tsx";
import {
  useCommitKit,
  useShellClaimPath,
} from "#web/components/social/feed-ui/shell-bridge.tsx";
import { useSocialViewer } from "#web/components/social/SignInGate.tsx";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { useCurrentBlastActions } from "../BlastActionProvider";
import { useWorkspace } from "../workspace-context";
import { PresalePanel } from "./PresalePanel";
import { createPresaleReads } from "./presale-reads";

export function WorkspacePresalePanel({
  panel,
}: Readonly<{ panel: PanelSetup }>) {
  const { dispatch, presentation, presale_history } = useWorkspace();
  const authority = useCurrentBlastActions();
  const commit = useCommitKit();
  const claimPath = useShellClaimPath();
  const viewer = useSocialViewer();
  const run = useShellActions();
  const reads = useMemo(
    () => createPresaleReads(viewer.getAccessToken),
    [viewer.getAccessToken],
  );
  return (
    <PresalePanel
      inspectHistory={presale_history?.has(panel.panel_id) === true}
      panel_id={panel.panel_id}
      asset={panel}
      presale_setup={panel.presale}
      onSetupChange={(presale) =>
        dispatch.patchPanel(panel.panel_id, { presale })
      }
      onTradingAvailable={() =>
        dispatch.patchPanel(panel.panel_id, { active_namespace: "coin" })
      }
      effective_visibility={
        presentation.mode_open &&
        presentation.document_visible &&
        presentation.visible_panel_ids.includes(panel.panel_id)
      }
      actions={{
        commit,
        claimPath,
        authenticated: authority.authenticated && commit?.signedIn === true,
        actor_key: authority.actor_key,
        confirmation: authority.confirmation,
        signIn: () => {
          if (commit) commit.signIn();
          else run("openSignIn");
        },
      }}
      reads={reads}
    />
  );
}
