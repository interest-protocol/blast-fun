import clsx from "clsx";
import type { ReactNode } from "react";

import styles from "./LoadingIndicator.module.css";

/** The ring used by trade and purchase actions, shared with other pending UI. */
export function Spinner() {
  return <span aria-hidden="true" className={styles.spinner} />;
}

export function LoadingIndicator({ label, children, className, loading = true }: Readonly<{
  label: string;
  loading?: boolean;
  children?: ReactNode;
  className?: string;
}>) {
  if (!loading) return children;
  return (
    <span aria-label={label} className={clsx(styles.indicator, children && styles.action, className)} role="status">
      <Spinner />
      {children ? <span aria-hidden="true" className={styles.actionLabel}>{children}</span> : null}
      <span className={styles.srOnly}>{label}</span>
    </span>
  );
}
