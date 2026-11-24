"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useListOrigin } from "#web/components/blast-ui/list-restoration.ts";
import { SegmentedLinks } from "#web/components/blast-ui/Segmented.tsx";
import { portfolioPath, portfolioTabs } from "#web/components/blast-ui/portfolio-navigation.ts";
import styles from "./Portfolio.module.css";

/** A public vesting keeps its parent category available without duplicating the portfolio summary. */
export function PortfolioDetailNavigation() {
  const route = usePathname() ?? "";
  const origin = useListOrigin(route);
  const claimsPath = portfolioPath("claims");
  const fromPortfolio = origin && new URL(origin).pathname === claimsPath;
  return <div className={styles.detailContext}>
    <SegmentedLinks className={styles.sectionLinks} items={portfolioTabs().map(([key, label]) => ({ href: portfolioPath(key), label, current: key === "claims" }))} label="Portfolio sections" stretch />
    <Link href={claimsPath} onClick={event => {
      if (!fromPortfolio || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); window.history.back();
    }}>← Back to claims</Link>
  </div>;
}
