import { SkeletonBox, SkeletonRows, SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import rows from "./CoinsData.module.css";
import styles from "./PortfolioData.module.css";

/** The drawer's real holding grid, including the two action slots. */
export function HoldingRowsSkeleton({ label = "Loading portfolio coins", quickTrade = true }: Readonly<{ label?: string; quickTrade?: boolean }>) {
  return <SkeletonRows label={label} count={4} className={rows.list} rowClassName={`${rows.row} ${styles.holding} ${quickTrade ? styles.quickHolding : ""}`}>
    <div className={rows.head} data-cols="holding">
      <SkeletonBox className={rows.tile} round />
      <span className={`${rows.text} ${styles.holdingText}`}><span className={rows.t1}><SkeletonText>Coin name</SkeletonText></span><span className={rows.t2}><SkeletonText>Balance</SkeletonText></span></span>
      <span className={`${rows.figs} ${styles.holdingFigures}`}><span className={rows.figTop}><SkeletonText>Value</SkeletonText></span><span className={rows.figSub}><SkeletonText>Change</SkeletonText></span></span>
      <span className={styles.actions}>{quickTrade && <SkeletonBox className={styles.buySkeleton} />}<SkeletonBox className={styles.sellSkeleton} /></span>
    </div>
  </SkeletonRows>;
}
