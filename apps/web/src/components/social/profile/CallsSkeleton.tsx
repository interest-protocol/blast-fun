import clsx from "clsx";
import { SkeletonText as Text } from "#web/components/blast-ui/Skeleton.tsx";
import styles from "./Profile.module.css";

/** The sections card's rows while they load: the board's 68px rows, mark, two lines and the figure. */
export function CallsSkeleton({ created = false }: Readonly<{ created?: boolean }>) {
  return (
    <div aria-busy="true" aria-label={created ? "Loading created presales" : "Loading presale calls"} className={styles.rows} role="status">
      {[0, 1, 2].map((row) => (
        <div aria-hidden="true" className={styles.prow} key={row}>
          <span className={clsx(styles.mk, styles.skeleton)} />
          <span className={styles.t}>
            <b><Text>Presale name</Text></b>
            <span><Text>{created ? "COIN · 00% filled" : "$000 at $0.0000 · now $0.0000"}</Text></span>
          </span>
          <span className={styles.v}>
            {created ? <span className="status"><Text>Trading</Text></span> : <><b><Text>0.0×</Text></b><span><Text>since presale</Text></span></>}
          </span>
        </div>
      ))}
    </div>
  );
}
