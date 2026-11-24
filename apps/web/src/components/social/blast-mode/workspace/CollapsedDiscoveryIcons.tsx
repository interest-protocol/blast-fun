"use client";

import { IconButton } from "#web/components/blast-ui/Button.tsx";
import { AlertCircleIcon, CoinVerifiedMark } from "#web/components/blast-ui/Icons.tsx";
import { CoinMark } from "#web/components/blast-ui/CoinMark.tsx";
import { Tooltip, TooltipSurface } from "#web/components/blast-ui/Tooltip.tsx";
import { coreCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { useWorkspace } from "./workspace-context";
import { addDiscoveryAsset, assetOnScreen } from "./coin-row-model";
import { useDiscoverRailCoins } from "./discover-rail-read";
import { discoveryScope, useDiscoveryPreview, useReportDiscoveryCoins } from "./discovery-preview";
import styles from "./WorkspaceHost.module.css";

const PLACEHOLDERS = 8;

/**
 * The collapsed Discover rail (audit 04). Its marks come from the shortcuts cache, which outlives a
 * reload; with none for this view, the rail reads Discover itself (the Coins list), drawing fixed
 * placeholders until the marks arrive and a labelled retry if the read fails.
 */
export function CollapsedDiscoveryIcons() {
  const { snapshot, dispatch } = useWorkspace();
  const preview = useDiscoveryPreview();
  const view = snapshot.data.selected_view;
  const scoped = !!view && preview.scope === discoveryScope(snapshot.data, view) && preview.coins.length > 0;
  if (!view) return null;
  if (!scoped) return view === "Coins" && snapshot.data.controls.Coins.source === "discover" ? <RailLoader /> : null;
  return (
    <nav aria-label={`${view} shortcuts`} className={styles.discoveryIcons}>
      {preview.coins.map(coin => {
        const current = assetOnScreen(snapshot, coin.coin_type) && snapshot.panels[snapshot.focused_panel_id ?? ""]?.coin_type === coin.coin_type;
        const label = `Open ${coin.symbol} ${view === "Presales" ? "presale" : "coin"}`;
        return <Tooltip.Root key={coin.coin_type}>
          <Tooltip.Trigger render={<IconButton variant="ghost" size="md" aria-label={label} aria-current={current ? "true" : undefined}
            onClick={() => addDiscoveryAsset(dispatch, coin)} />}>
            {!coin.icon_url && !coreCoin(coin.coin_type)
              ? <span aria-hidden="true" className={styles.railMonogram}>{initials(coin.symbol)}</span>
              : <CoinMark coin={{ key: coin.coin_type, coinType: coin.coin_type, symbol: coin.symbol, iconUrl: coin.icon_url, round: true }} size={28} />}
          </Tooltip.Trigger>
          <TooltipSurface positioner={{ side: "right", sideOffset: 8, className: styles.railTipLayer }} popup={{ className: styles.railTip }}>{coin.symbol}{coin.verified_team ? <CoinVerifiedMark size="sm" /> : null}</TooltipSurface>
        </Tooltip.Root>;
      })}
    </nav>
  );
}

/** Two letters of the ticker, so coins without artwork stay tellable apart in the rail. */
function initials(symbol: string): string {
  return Array.from(symbol.replace(/[^\p{L}\p{N}]/gu, "") || symbol).slice(0, 2).join("").toUpperCase();
}

function RailLoader() {
  const read = useDiscoverRailCoins(true);
  useReportDiscoveryCoins("Coins", read.data?.coins ?? [], read.isSuccess, true);
  if (read.isError) return <nav aria-label="Coins shortcuts" className={styles.discoveryIcons}>
    <IconButton variant="ghost" size="md" aria-label="Coins shortcuts could not load. Retry" title="Coins shortcuts could not load. Retry" onClick={() => void read.refetch()}>
      <AlertCircleIcon />
    </IconButton>
  </nav>;
  if (read.isSuccess) return null;
  return <nav aria-busy="true" aria-label="Loading Coins shortcuts" className={styles.discoveryIcons}>
    {Array.from({ length: PLACEHOLDERS }, (_, index) => <span aria-hidden="true" className={styles.railPlaceholder} data-rail-placeholder="" key={index} />)}
  </nav>;
}
