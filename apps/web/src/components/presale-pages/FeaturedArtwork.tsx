import type { ReactNode } from "react";
import type { SocialSaleMetadata } from "@blast/core/web/contracts/sales.ts";
import { PresaleCover } from "./PresaleCover";
import styles from "./FeaturedPresales.module.css";

export function FeaturedArtwork({ cover, presaleId, children }: Readonly<{ cover?: SocialSaleMetadata["cover"]; presaleId?: string; children: ReactNode }>) {
  return <span className={styles.logoStage}>
    <PresaleCover className={styles.cover} cover={cover} presaleId={presaleId} />
    {children}
  </span>;
}
