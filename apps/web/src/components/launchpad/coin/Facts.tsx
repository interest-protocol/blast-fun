import type { ReactNode } from "react";

import styles from "./Coin.module.css";

/** Labeled facts, one term and its value per row. */
export function Facts({ children, label }: Readonly<{ children: ReactNode; label?: string }>) {
  return (
    <dl className={styles.facts} aria-label={label}>
      {children}
    </dl>
  );
}

export function Fact({ term, children }: Readonly<{ term: string; children: ReactNode }>) {
  return (
    <div className={styles.fact}>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** A full identifier: wraps anywhere, copyable as one string. */
export function Id({ children }: Readonly<{ children: string }>) {
  return <code className={styles.id}>{children}</code>;
}
