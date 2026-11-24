import clsx from "clsx";

import { SkeletonText } from "#web/components/blast-ui/Skeleton.tsx";
import styles from "./coins.module.css";

export function CoinRowsLoading({ label = "Loading coins", count = 3 }: Readonly<{
  label?: string;
  count?: number;
}>) {
  return (
    <div aria-busy="true" aria-label={label} className={styles.coinList} role="status">
      {Array.from({ length: count }, (_, row) => (
        <div aria-hidden="true" className={clsx(styles.lrow, styles.coinRow)} key={row}>
          <span className={styles.pickerIdentity}>
            <span className={styles.identity}>
              <span className={styles.skeleton} data-coin-mark="" data-coin-size={28} />
              <span className={styles.identityText}>
                <b><SkeletonText>COIN</SkeletonText></b>
                <span><SkeletonText>Coin name</SkeletonText></span>
              </span>
            </span>
          </span>
          <span className={styles.v}>
            <b className="num"><SkeletonText>$000.00</SkeletonText></b>
            <span><SkeletonText>0.00 COIN</SkeletonText></span>
          </span>
          <span className={styles.qtick} />
        </div>
      ))}
    </div>
  );
}
