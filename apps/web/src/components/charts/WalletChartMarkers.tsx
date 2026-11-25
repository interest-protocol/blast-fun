"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { explorerAccountUrl } from "@blast/core/lib/explorer.ts";
import { countWords, shortAddress } from "@blast/core/lib/format.ts";
import { profilePagePath } from "@blast/core/modules/social/contracts/profiles.ts";
import { traderProfileKey, type TraderProfileRequest } from "@blast/core/modules/social/contracts/trader-profiles.ts";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { Popover, PopoverSurface } from "#web/components/blast-ui/Popover.tsx";
import { dyn } from "#web/components/blast-ui/csp-style.ts";
import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import { WalletLabelIcon } from "#web/components/launchpad/activity/WalletLabelIcon.tsx";
import { WALLET_LABELS } from "#web/components/launchpad/activity/wallet-labels.ts";
import { loadTraderProfiles } from "#web/components/launchpad/activity/trader-profiles.ts";
import type { walletMarkerBadges } from "./wallet-markers";
import styles from "./PoolCandleChart.module.css";

type Badge = ReturnType<typeof walletMarkerBadges>[number];
type Selection = Readonly<{ badge: string; address: string; controller: AbortController }>;
const loadingLabel = "Opening wallet";

export function WalletChartMarkers({ badges }: Readonly<{ badges: readonly Badge[] }>) {
  const { explorer } = useDevicePrefs();
  const active = useRef<Selection | null>(null);
  const [pending, setPending] = useState<Selection | null>(null);

  useLayoutEffect(() => () => {
    active.current?.controller.abort();
    active.current = null;
  }, []);

  async function openWallet(badge: string, wallet: TraderProfileRequest) {
    if (active.current) return;
    const explorerUrl = explorerAccountUrl(explorer, wallet.address);
    if (!explorerUrl) return;
    const selection = { badge, address: wallet.address, controller: new AbortController() };
    active.current = selection;
    setPending(selection);
    const timeout = setTimeout(() => selection.controller.abort(), 15_000);
    const profiles = await loadTraderProfiles([wallet], selection.controller.signal).catch(() => null);
    clearTimeout(timeout);
    if (active.current !== selection) return;
    active.current = null;
    setPending(null);
    const profile = profiles?.[traderProfileKey(wallet)];
    location.assign(profile ? profilePagePath(profile.callsign) : explorerUrl);
  }

  function cancelWallet(badge: string) {
    if (active.current?.badge !== badge) return;
    active.current.controller.abort();
    active.current = null;
    setPending(null);
  }

  return <div className={styles.walletOverlay}>
    {badges.map((badge) => {
      const key = badge.side + badge.slot;
      const side = badge.side === "buy" ? "buyer" : "seller";
      const single = badge.wallets.size === 1 ? badge.wallets.entries().next().value : undefined;
      const action = single ? `Open ${side} wallet ${shortAddress(single[0])}` : `Choose from ${badge.wallets.size} ${side} wallets`;
      const openingSingle = Boolean(single && pending?.badge === key);
      const target = <Button
        variant="ghost"
        size="glyph"
        className={styles.walletMark}
        {...dyn({ left: badge.left, top: badge.top, width: badge.badgeWidth, height: badge.badgeHeight })}
        title={`${countWords(badge.count, badge.side, `${badge.side}s`)} · ${badge.labels.map(label => WALLET_LABELS[label].name).join(", ")}`}
        aria-label={openingSingle ? loadingLabel : action}
        disabled={Boolean(single && pending)}
        focusableDisabled
        loading={openingSingle}
        loadingLabel={loadingLabel}
        onClick={single ? () => void openWallet(key, { address: single[0], timestampMs: single[1] }) : undefined}
      >
        <span aria-hidden="true" className={styles.walletGlyphs}>
          <b>{badge.side === "buy" ? "↑" : "↓"}</b>
          {badge.labels.map(label => <WalletLabelIcon key={label} label={label} />)}
          {badge.count > 1 && <small>×{badge.count > 99 ? "99+" : badge.count}</small>}
        </span>
      </Button>;
      return <div key={key} data-side={badge.side}>
        <svg className={styles.walletDots} aria-hidden="true">
          {badge.points.map(point => <circle key={point.key} cx={point.x} cy={point.y} r={3.7} />)}
        </svg>
        {single ? target : <Popover.Root onOpenChange={open => { if (!open) cancelWallet(key); }}>
          <Popover.Trigger render={target} />
          <PopoverSurface
            positioner={{ className: styles.exactLayer, side: "top", sideOffset: 4, collisionPadding: 12 }}
            popup={{ className: `${styles.exactValues} ${styles.walletChoices}` }}
          >
            <Popover.Title>Choose a wallet</Popover.Title>
            {[...badge.wallets].map(([address, timestampMs]) => {
              const opening = pending?.badge === key && pending.address === address;
              const name = shortAddress(address);
              return <Button
                key={address}
                variant="ghost"
                className={styles.walletChoice}
                aria-label={opening ? loadingLabel : name}
                disabled={Boolean(pending)}
                focusableDisabled
                loading={opening}
                loadingLabel={loadingLabel}
                onClick={() => void openWallet(key, { address, timestampMs })}
              >{name}</Button>;
            })}
          </PopoverSurface>
        </Popover.Root>}
      </div>;
    })}
  </div>;
}
