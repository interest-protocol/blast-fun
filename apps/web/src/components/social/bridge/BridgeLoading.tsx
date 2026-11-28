"use client";

import clsx from "clsx";

import { SkeletonBox, SkeletonRegion, SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";

import coinStyles from "../coins/coins.module.css";

import styles from "./bridge.module.css";

/** The card's own layout, so nothing moves when the chunk or the wallets arrive. */
export function BridgeLoading() {
  return (
    <SkeletonRegion className={styles.form} label="Loading Bridge to Sui">
      <SkeletonBox className={styles.chainsLoading} />
      <div aria-hidden="true" className={styles.panels}>
        {["You send", "You get on Sui"].map((label, index) => (
          <div className={clsx(coinStyles.amt, index === 1 && coinStyles.amtOut)} key={label}>
            <div className={coinStyles.amtTop}><span><SkeletonText>{label}</SkeletonText></span></div>
            <div className={coinStyles.amtRow}><b className={coinStyles.amtVal}><SkeletonText>0</SkeletonText></b></div>
            <div className={coinStyles.amtFoot}><SkeletonText>Your Blast wallet</SkeletonText></div>
          </div>
        ))}
      </div>
      <SkeletonBox className={styles.actionLoading} />
    </SkeletonRegion>
  );
}
