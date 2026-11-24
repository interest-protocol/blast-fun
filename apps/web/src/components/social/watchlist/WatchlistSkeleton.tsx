import clsx from "clsx";

import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import styles from "../profile/Profile.module.css";
import { ChevIcon } from "../profile/icons";

export function WatchlistRowsSkeleton() {
  return [0, 1, 2].map((key) => (
    <div aria-hidden="true" className={styles.lrow} key={key}>
      <span className={styles.mk} />
      <span className={styles.t}>
        <b>
          <SkeletonText>Presale name</SkeletonText>
        </b>
        <span>
          <SkeletonText>Presale status</SkeletonText>
        </span>
      </span>
      <ChevIcon className={styles.chev} />
    </div>
  ));
}

export function PortfolioRailLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading watchlist"
      className={clsx("card", styles.listCard)}
      data-route-loading="rail"
    >
      <h3 className={styles.lcH}>
        <span>Watchlist</span>
      </h3>
      <WatchlistRowsSkeleton />
    </div>
  );
}
