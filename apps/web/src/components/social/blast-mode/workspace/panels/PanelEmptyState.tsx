import type { ReactNode } from "react";

import { EmptyState } from "#web/components/blast-ui/EmptyState.tsx";
import styles from "./FocusPanel.module.css";

/** An empty lower-context list, shown only after a successful read confirms there is nothing. */
export function PanelEmptyState({ title, children }: Readonly<{ title: string; children?: ReactNode }>) {
  return <EmptyState compact role="status" title={title}>{children}</EmptyState>;
}

/** A tab with no list to filter: the head's Following only and With thesis hide (FocusPanel.module.css), so no control sits over nothing. */
export function NoRows({ children }: Readonly<{ children: ReactNode }>) {
  return <div className={styles.noRows} data-no-rows="">{children}</div>;
}
