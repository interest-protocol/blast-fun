"use client";

import { useContext } from "react";
import { BondingCurves } from "#web/components/launchpad/discovery/BondingCurves.tsx";
import { addDiscoveryAsset, assetOnScreen, canonicalCoinType } from "./coin-row-model";
import { PanelIdentitiesContext } from "./panel-identities";
import { useWorkspaceLiveClock } from "./live-clock";
import { useWorkspace } from "./workspace-context";

export function BondingData() {
  const { snapshot, presentation, dispatch } = useWorkspace();
  const { now } = useWorkspaceLiveClock();
  const identities = useContext(PanelIdentitiesContext);
  if (!presentation.mode_open || !presentation.document_visible || snapshot.data.collapsed || snapshot.data.selected_view !== "Bonding") return null;
  const controls = snapshot.data.controls.Bonding;
  return (
    <BondingCurves
      view={controls.view}
      now={now}
      onViewChange={(view) => dispatch.patchDataControls("Bonding", { ...controls, view, navigation: { ...controls.navigation, scroll_top: 0 } })}
      onOpen={{
        // A curve's coin opens in the middle by its coin type, like a Coins row; the panel reads its chart and market from it.
        open: (row) => {
          if (canonicalCoinType(row.coinType) === null) return;
          if (row.symbol) identities?.report(row.coinType, { symbol: row.symbol, icon: row.iconUrl, name: row.name });
          addDiscoveryAsset(dispatch, { coin_type: row.coinType, presale_id: null, lifecycle: row.lifecycle });
        },
        isOpen: (row) => assetOnScreen(snapshot, canonicalCoinType(row.coinType)),
      }}
    />
  );
}
