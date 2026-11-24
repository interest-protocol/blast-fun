import type { ReactNode } from "react";

import { DiscoveryRail } from "./discovery/DiscoveryRail";
import type { TerminalSlots } from "./LaunchpadTerminal";
import styles from "./LaunchpadTerminal.module.css";

function Pending({ children }: Readonly<{ children: ReactNode }>) {
  return <p className={styles.pending}>{children}</p>;
}

/**
 * The terminal's slots: Discover is connected (DiscoveryRail); the rest is
 * honest interim content that feature slices replace one entry each. Nothing
 * interim shows market data, prices, or people.
 */
export function placeholderTerminalSlots(launchId: string | null): TerminalSlots {
  return {
    discovery: <DiscoveryRail selectedLaunchId={launchId} />,
    market: launchId ? (
      <div className={styles.marketHeader}>
        <p className={styles.regionLabel}>Selected coin</p>
        <h1 className={styles.marketTitle}>Coin</h1>
        <p className={styles.launchIdLabel}>Launch ID</p>
        <code className={styles.launchId}>{launchId}</code>
      </div>
    ) : (
      <div className={styles.marketHeader}>
        <p className={styles.regionLabel}>Selected coin</p>
        <h1 className={styles.marketTitle}>Trading terminal</h1>
        <Pending>No coin selected. Choose a launch from Discover.</Pending>
      </div>
    ),
    chart: <Pending>The price chart is not connected yet.</Pending>,
    overview: <Pending>The coin overview is not connected yet.</Pending>,
    theses: <Pending>Thesis are not connected yet.</Pending>,
    activity: <Pending>Trade activity is not connected yet.</Pending>,
    holders: <Pending>Holder data is not connected yet.</Pending>,
    execution: <Pending>Trading is not open yet. Buy and sell controls will appear here.</Pending>,
  };
}
