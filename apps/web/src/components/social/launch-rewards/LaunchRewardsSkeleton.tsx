import type { ReactNode } from "react";

import { SkeletonText as Text } from "#web/components/blast-ui/Skeleton.tsx";
import styles from "../creator-earnings/CreatorEarnings.module.css";
import own from "./LaunchRewards.module.css";

function Amounts() {
  return (
    <span className={styles.amounts}>
      <span>
        <Text>123.456 COIN</Text>
      </span>
      <span>
        <Text>0.123 SUI</Text>
      </span>
    </span>
  );
}

/**
 * The shape of a launchpad row while its read is pending: the coin, then its first line — a
 * ledger's named figures, or a payout's amounts — two token amounts each. No controls: these rows
 * have none.
 */
/** A pending row's wrapper: a named status, or silent when a busy control already announces the read. */
function Pending({ label, silent, children }: Readonly<{ label: string; silent: boolean; children: ReactNode }>) {
  return silent ? (
    <div aria-hidden="true" className={styles.earning}>{children}</div>
  ) : (
    <div aria-busy="true" aria-label={label} className={styles.earning} role="status">{children}</div>
  );
}

function CoinName() {
  return (
    <div className={styles.name}>
      <span className={styles.skeletonMark} />
      <span>
        <b>
          <Text>Launch coin</Text>
        </b>
        <span>
          <Text>COIN · Live</Text>
        </span>
      </span>
    </div>
  );
}

/** A pending creator-rights row (LP-17): the coin, then its label and its claim button. */
export function CreatorRightsSkeleton({ label, silent = false }: Readonly<{ label: string; silent?: boolean }>) {
  return (
    <Pending label={label} silent={silent}>
      <div aria-hidden="true">
        <CoinName />
        <div className={styles.rows}>
          <div className={styles.action}>
            <span className={styles.label}>
              <Text>Creator rights</Text>
            </span>
            <div className={styles.control}>
              <div>
                <span className={styles.skeletonButton} />
              </div>
            </div>
          </div>
        </div>
      </div>
    </Pending>
  );
}

export function LaunchRewardsSkeleton({
  label,
  line,
  figures,
  silent = false,
}: Readonly<{ label: string; line: string; figures: readonly string[]; silent?: boolean }>) {
  return (
    <Pending label={label} silent={silent}>
      <div aria-hidden="true">
        <CoinName />
        <div className={styles.rows}>
          <div className={styles.action}>
            <span className={styles.label}>
              <Text>{line}</Text>
            </span>
            <div className={styles.value}>
              {figures.length === 0 ? (
                <Amounts />
              ) : (
                <div className={own.ledger}>
                  {figures.map((figure) => (
                    <div key={figure}>
                      <span className={own.figure}>
                        <Text>{figure}</Text>
                      </span>
                      <Amounts />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </Pending>
  );
}
