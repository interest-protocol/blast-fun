import clsx from "clsx";
import { SkeletonRegion, SkeletonText } from "./Skeleton";
import styles from "./EmptyState.module.css";

/** Unknown list cardinality: reserve the empty/error panel, then grow for real rows. */
export function PendingPanel({ label, framed = false }: Readonly<{ label: string; framed?: boolean }>) {
  return <SkeletonRegion label={label} className={clsx(styles.empty, framed && "card")} listPending>
    <span aria-hidden="true" className={styles.title}><SkeletonText>Checking for content</SkeletonText></span>
  </SkeletonRegion>;
}
