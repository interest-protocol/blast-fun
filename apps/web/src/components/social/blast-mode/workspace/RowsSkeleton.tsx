import { SkeletonBox, SkeletonRows, SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import styles from "./CoinsData.module.css";

/** A Discover list before its first read: rows of the list's own geometry, so the first row doesn't move when data lands. */
export function RowsSkeleton({ label, count = 8 }: Readonly<{ label?: string; count?: number }>) {
  return (
    <SkeletonRows className={styles.list} count={count} label={label} rowClassName={styles.row}>
      <div className={styles.head}>
        <SkeletonBox className={styles.tile} round />
        <span className={styles.text}>
          <span className={styles.t1}><SkeletonText>Coin name</SkeletonText></span>
          <span className={styles.t2}><SkeletonText>Market detail</SkeletonText></span>
        </span>
        <span className={styles.figs}>
          <span className={styles.figTop}><SkeletonText>$0.0000</SkeletonText></span>
          <span className={styles.figSub}><SkeletonText>+0.0%</SkeletonText></span>
        </span>
      </div>
    </SkeletonRows>
  );
}
