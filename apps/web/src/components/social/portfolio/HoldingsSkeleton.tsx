import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import { PendingPanel } from "#web/components/blast-ui/PendingPanel.tsx";
import { ChevIcon } from "../profile/icons";
import styles from "./Portfolio.module.css";

export function RowSkeletons({ label = "Loading your holdings", kind = "coins", nested = false, count = 2 }: Readonly<{
  label?: string;
  kind?: "coins" | "presales" | "vestings";
  nested?: boolean;
  count?: number;
}>) {
  if (kind !== "coins") return <PendingPanel label={label} />;
  return <div aria-busy="true" aria-label={label} className={nested ? undefined : styles.list} role="status">
    {Array.from({ length: count }, (_, key) => (
          <div aria-hidden="true" className={styles.row} key={key}>
            <span className={styles.loadingMark} />
            <span className={styles.t}>
              <b>
                <SkeletonText>Coin name</SkeletonText>
              </b>
              <span>
                <SkeletonText>Quantity</SkeletonText>
              </span>
            </span>
            <span className={styles.sp}>
              <span className={styles.spark} />
            </span>
            <span className={styles.v}>
              <b>
                <SkeletonText>Amount</SkeletonText>
              </b>
              <span>
                <SkeletonText>Change</SkeletonText>
              </span>
            </span>
            <ChevIcon className={styles.chev} />
          </div>
    ))}
  </div>;
}
