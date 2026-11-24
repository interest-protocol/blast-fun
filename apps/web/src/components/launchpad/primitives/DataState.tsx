import type { ReactNode } from "react";

import { SkeletonBox } from "#web/components/blast-ui/Skeleton.tsx";

import { dataStatePresentation, type DataStateKind, type SectionState } from "./data-state";
import { Glyph } from "./Glyph";
import styles from "./primitives.module.css";
import { capitalize } from "./data-state-model";

/** The labeled, shaped line that announces a non-ready state. */
export function StateLine({ kind, children }: Readonly<{ kind: DataStateKind; children: ReactNode }>) {
  const { label, glyph } = dataStatePresentation(kind);
  return (
    <p className={styles.stateLine} role="status">
      <span className={styles.stateLabel}>
        <Glyph shape={glyph} />
        {label}
      </span>{" "}
      <span className={styles.stateMessage}>{children}</span>
    </p>
  );
}

/**
 * One section's facts in their honest state. Loading, Empty, and Unavailable
 * never render `children`; Stale renders the last verified facts under an
 * explicit label. `subject` is the plural noun the section shows ("holders").
 */
export function DataState<T>({
  state,
  subject,
  loading,
  empty,
  action,
  recovery = "Reload the page to try again.",
  children,
}: Readonly<{
  state: SectionState<T>;
  subject: string;
  /** Names the operation while loading. Defaults to "Fetching {subject}…". */
  loading?: string;
  /** What an empty result means. Defaults to "No {subject} yet." */
  empty?: string;
  /** The next useful action when the section is empty. */
  action?: ReactNode;
  /** How to recover when the section is unavailable. */
  recovery?: ReactNode;
  children: (value: T) => ReactNode;
}>) {
  switch (state.status) {
    case "loading":
      return (
        <div className={styles.dataState} data-state="loading" aria-busy="true">
          <p className="sr-only" role="status">{dataStatePresentation("loading").label} {loading ?? `Fetching ${subject}…`}</p>
          <SkeletonBox className={styles.sectionSkeleton} />
          <SkeletonBox className={styles.sectionSkeleton} />
          <SkeletonBox className={styles.sectionSkeleton} />
        </div>
      );
    case "empty":
      return (
        <div className={styles.dataState} data-state="empty">
          <StateLine kind="empty">{empty ?? `No ${subject} yet.`}</StateLine>
          {action ? <p className={styles.stateAction}>{action}</p> : null}
        </div>
      );
    case "unavailable":
      return (
        <div className={styles.dataState} data-state="unavailable">
          <StateLine kind="unavailable">
            {capitalize(subject)} couldn’t load. {recovery}
          </StateLine>
        </div>
      );
    case "stale": {
      return (
        <div className={styles.dataState} data-state="stale">
          <StateLine kind="stale">
            {capitalize(subject)} may be out of date.
          </StateLine>
          {children(state.value)}
        </div>
      );
    }
    case "ready":
      return (
        <div className={styles.dataState} data-state="ready">
          {children(state.value)}
        </div>
      );
  }
}
