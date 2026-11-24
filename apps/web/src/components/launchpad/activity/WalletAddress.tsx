"use client";

import type { ReactNode } from "react";
import type { ActivityRow } from "@blast/core/modules/launchpad-contract/activity.ts";
import { shortAddress } from "@blast/core/lib/format.ts";
import { InspectValue } from "#web/components/blast-ui/InspectValue.tsx";
import { useLaunchWallet } from "./wallet-trades";
import { tradeWalletLabels, WALLET_LABELS, type WalletLabel } from "./wallet-labels";
import { WalletLabelIcon } from "./WalletLabelIcon";
import styles from "./Activity.module.css";

export function WalletAddress({ address, row, label, children, onInspect }: Readonly<{
  address: string;
  row?: ActivityRow;
  label: string;
  children?: ReactNode;
  onInspect?: (open: boolean) => void;
}>) {
  const deployer = useLaunchWallet();
  const labels: readonly WalletLabel[] = row ? tradeWalletLabels(row, deployer) : address === deployer ? ["deployer"] : [];
  const tags = labels.map((key) => WALLET_LABELS[key]);
  const description = tags.map(({ name, detail }) => `${name}. ${detail}`).join(" ");
  return <InspectValue value={address} label={label} description={description} onOpenChange={onInspect}>
    {children ?? shortAddress(address)}
    {tags.length > 0 && <span className={styles.walletIcons} aria-hidden="true">{labels.map(key => <WalletLabelIcon key={key} label={key} />)}</span>}
  </InspectValue>;
}
