import { SkeletonBox, SkeletonRegion } from "#web/components/blast-ui/Skeleton.tsx";
import { HoldingRowsSkeleton } from "./HoldingRowsSkeleton";
import styles from "./PortfolioData.module.css";

/** The portfolio before its account (or its code) is ready: the tool row or section tabs, then holdings rows, where they will render. */
export function PortfolioPending({ label, quickTrade }: Readonly<{ label: string; quickTrade: boolean }>) {
  return (
    <SkeletonRegion label={label}>
      <div className={quickTrade ? styles.tools : styles.tabs}>
        <SkeletonBox className={quickTrade ? styles.toolsSkeleton : styles.tabsSkeleton} />
      </div>
      <HoldingRowsSkeleton quickTrade={quickTrade} />
    </SkeletonRegion>
  );
}
