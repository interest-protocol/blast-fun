"use client";

import { SegmentedLinks } from "#web/components/blast-ui/Segmented.tsx";
import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { connectionsPagePath, type ConnectionTab, type SocialConnectionCounts } from "@blast/core/web/contracts/connections.ts";
import styles from "./Connections.module.css";

const MODES = ["followers", "following"] as const;

/**
 * Followers and Following are places (the shared `SegmentedLinks`). Hovering
 * or focusing a tab reads its first page ahead; a client navigation selects
 * it at once (the link prevented the browser's own navigation).
 */
export function ConnectionTabs({ callsign, tab, counts, countsLoading = false, prefetch, select }: Readonly<{
  callsign: string;
  tab: ConnectionTab;
  /** Absent while loading (a skeleton) or when private or failed (then no number at all). */
  counts?: SocialConnectionCounts;
  countsLoading?: boolean;
  prefetch?: (tab: ConnectionTab) => void;
  select?: (tab: ConnectionTab) => void;
}>) {
  return <div className={styles.tabsHost}>
    <SegmentedLinks className={styles.tabs} label="Profile connections" items={MODES.map((mode) => ({
      href: connectionsPagePath(callsign, mode),
      current: tab === mode,
      onFocus: () => prefetch?.(mode),
      onMouseEnter: () => prefetch?.(mode),
      onNavigate: () => select?.(mode),
      label: <>{mode === "followers" ? "Followers" : "Following"}{counts ? <span className="num">{counts[mode].toLocaleString("en-US")}</span> : countsLoading ? <span aria-label="Count loading"><SkeletonText>00</SkeletonText></span> : null}</>,
    }))} />
  </div>;
}
