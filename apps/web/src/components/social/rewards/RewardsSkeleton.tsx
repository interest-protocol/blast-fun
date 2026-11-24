import { PendingPanel } from "#web/components/blast-ui/PendingPanel.tsx";
import clsx from "clsx";
import { SkeletonText as Text } from "#web/components/blast-ui/Skeleton.tsx";
import styles from "./Rewards.module.css";

export function PayoutSkeleton() {
  return (
    <div aria-hidden="true" className={clsx(styles.row, styles.c)}>
      <span className={styles.t}>
        <b>
          <Text>Round 123</Text>
        </b>
        <span>
          <Text>Today, 12:00</Text>
        </span>
      </span>
      <span className={styles.v}>
        <b>
          <Text>+123.45 COIN</Text>
        </b>
        <span>
          <Text>+0.12 SUI</Text>
        </span>
      </span>
      <span className={styles.skeletonLink}>
        <Text>↗</Text>
      </span>
    </div>
  );
}

export function RewardsSkeleton() {
  return <PendingPanel label="Loading rewards" />;
}
