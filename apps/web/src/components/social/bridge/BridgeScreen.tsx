"use client";

import clsx from "clsx";
import { lazy, Suspense } from "react";

import { SkeletonBox, SkeletonRegion, SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";

import coinStyles from "../coins/coins.module.css";

import type { BridgeCardProps } from "./BridgeCard.tsx";
import styles from "./bridge.module.css";

// The Mayan SDK, ethers and web3.js load only when someone opens Bridge to Sui.
const BridgeCard = lazy(() => import("./BridgeCard.tsx"));

export function BridgeScreen(props: BridgeCardProps) {
  return (
    <Suspense fallback={<BridgeLoading />}>
      <BridgeCard {...props} />
    </Suspense>
  );
}

/** The card's own layout, so nothing moves when the chunk arrives. */
function BridgeLoading() {
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
