"use client";

import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import type { PanelSetup } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { coinTypeIdentity, usePanelIdentities, panelIdentityLabel, panelSymbol, type PanelIdentities } from "./panel-identities";
import styles from "./WorkspaceHost.module.css";

/** A panel's coin mark at chip size: its icon once a panel has read it, else the generated mark. */
export function PanelMark({ panel, identities, size = 28 }: Readonly<{ panel: PanelSetup; identities: PanelIdentities | null; size?: 18 | 28 }>) {
  const identity = identities?.get(panel.coin_type, panel.network);
  return (
    <CoinMark
      coin={{
        key: panel.coin_type,
        coinType: panel.coin_type,
        network: panel.network,
        symbol: identity?.symbol ?? panelSymbol(panel, identities),
        iconUrl: identity?.icon ?? coinTypeIdentity(panel.coin_type).icon,
        round: false,
      }}
      size={size}
    />
  );
}

export function AssetChoice({ panel }: Readonly<{ panel: PanelSetup }>) {
  const identities = usePanelIdentities();
  return <span className={styles.assetChoice}><PanelMark panel={panel} identities={identities} size={28} /><span><strong>{panelSymbol(panel, identities)}</strong><small>{panelIdentityLabel(panel)}</small></span></span>;
}
