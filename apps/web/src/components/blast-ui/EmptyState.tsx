import clsx from "clsx";
import type { ReactNode } from "react";

import styles from "./EmptyState.module.css";

/**
 * The one empty, not-found and read-failure message (System board): a short
 * title, an optional sentence and the next useful action (a `size="sm"`
 * Button), centred in a quiet tonal box. `framed` puts it on its own card when
 * nothing else frames it. Show it only after a successful read confirms there
 * is nothing (or the read failed), never while loading.
 */
export function EmptyState({
  title,
  children,
  action,
  framed = false,
  compact = false,
  row = false,
  role,
  heading,
  listEmpty = false,
  className,
}: Readonly<{
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  framed?: boolean;
  /** A settled empty result inside an already compact data slot. */
  compact?: boolean;
  /** An empty result in a sidebar or short list. */
  row?: boolean;
  /** `alert` for a failure the person did not ask about; `status` for a result they did. */
  role?: "alert" | "status";
  /** Render the title as this heading level when the message is the page's (or a section's) heading, e.g. a not-found page. */
  heading?: 1 | 2 | 3;
  /** It stands in for a list's rows (empty or failed): the list drops its toolbar, and Home hides the section while lists are late. */
  listEmpty?: boolean;
  className?: string;
}>) {
  const Title = heading ? (`h${heading}` as const) : "p";
  return (
    <div className={clsx(styles.empty, compact && styles.compact, row && styles.row, framed && "card", className)} data-list-empty={listEmpty ? "" : undefined} role={role}>
      <Title className={styles.title}>{title}</Title>
      {children ? <p className={styles.body}>{children}</p> : null}
      {action ? <div className={styles.action}>{action}</div> : null}
    </div>
  );
}
