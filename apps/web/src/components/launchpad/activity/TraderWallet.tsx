"use client";

import { EXPLORER_NAMES, explorerAccountUrl } from "@blast/core/lib/explorer.ts";
import { shortAddress } from "@blast/core/lib/format.ts";
import { CopyAddress } from "#web/components/blast-ui/CopyAddress.tsx";
import { TransactionLink } from "#web/components/blast-ui/TransactionLink.tsx";
import { useDevicePrefs } from "#web/components/blast-ui/device-prefs.ts";
import styles from "./Activity.module.css";

/** A wallet's page on the explorer the viewer chose in Settings, and the words for its link; null for no address. */
export function useWalletExplorer(address: string | null): Readonly<{ url: string; label: string }> | null {
  const { explorer } = useDevicePrefs();
  if (!address) return null;
  const url = explorerAccountUrl(explorer, address);
  return url ? { url, label: `View wallet ${shortAddress(address)} on ${EXPLORER_NAMES[explorer]}` } : null;
}

/** A trader's wallet: press the short address to copy the full one, or open it on the viewer's explorer. */
export function TraderWallet({ address }: Readonly<{ address: string }>) {
  const explorer = useWalletExplorer(address);
  return <span className={styles.traderWallet}>
    <CopyAddress value={address} label="Wallet" copyLabel="Copy wallet address" />
    {explorer && <TransactionLink href={explorer.url} label={explorer.label} />}
  </span>;
}
