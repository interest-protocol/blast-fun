import clsx from "clsx";
import type { ReactNode } from "react";

import styles from "./Skeleton.module.css";

/** Inherit the destination's type metrics instead of guessing a placeholder height. */
export function SkeletonText({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <span aria-hidden="true" className={styles.text}>
      {children}
    </span>
  );
}

/**
 * A block standing in for content of a known size: a chart's plot, a card's
 * image, a control. The caller's class sets its width and height in rem (the
 * page's CSP allows no inline style), so the box is the final geometry.
 */
export function SkeletonBox({ className, round = false }: Readonly<{
  className?: string;
  /** A coin mark or avatar: a circle. */
  round?: boolean;
}>) {
  return <span aria-hidden="true" className={clsx(styles.box, round && styles.round, className)} />;
}

/**
 * Pending content in place: the skeleton is what people see, and assistive
 * technology hears the operation's name, as the loading ring said it. The
 * region is the content's own box, so nothing moves when the data arrives.
 */
export function SkeletonRegion({ label, className, children, inline = false, listPending = false }: Readonly<{
  label: string;
  className?: string;
  children: ReactNode;
  /** Inside a line of text (a count, a value): a span instead of a block. */
  inline?: boolean;
  /** Stands in for a list's rows before the first read: Home hides the section while lists are late. */
  listPending?: boolean;
}>) {
  const Tag = inline ? "span" : "div";
  return (
    <Tag aria-busy="true" aria-label={label} className={className} data-list-pending={listPending ? "" : undefined} role="status">
      {children}
      <span className="sr-only">{label}</span>
    </Tag>
  );
}

/**
 * A sentence still being worked out (a check, a read): its line is drawn as a
 * skeleton bar, and the operation's name is the bar's own text, so assistive
 * technology reads exactly what the loading ring used to say. Inside a parent
 * that is already a status, pass `status={false}`.
 */
export function SkeletonLine({ label, status = true }: Readonly<{ label: string; status?: boolean }>) {
  return status ? (
    <span aria-busy="true" aria-label={label} className={styles.text} role="status">
      {label}
    </span>
  ) : (
    <span className={styles.text}>{label}</span>
  );
}

/**
 * A list still loading: `count` copies of one row drawn with the list's own
 * row classes, so the first skeleton row sits where the first real row lands.
 */
export function SkeletonRows({ label, count, className, rowClassName, children }: Readonly<{
  /** The operation's name; leave it out when an enclosing SkeletonRegion already names it. */
  label?: string;
  count: number;
  /** The list's own class (its padding and gap). */
  className?: string;
  /** The row's own class (its height and padding). */
  rowClassName?: string;
  /** One row's skeleton, built from SkeletonBox and SkeletonText. */
  children: ReactNode;
}>) {
  const rows = Array.from({ length: count }, (_, row) => (
    <div aria-hidden="true" className={rowClassName} key={row}>
      {children}
    </div>
  ));
  return label ? (
    <SkeletonRegion className={className} label={label} listPending>
      {rows}
    </SkeletonRegion>
  ) : (
    <div className={className}>{rows}</div>
  );
}

/**
 * A read running over content already on screen: nothing is drawn (the data
 * stays put and a busy control already says so), and assistive technology
 * hears the operation's name.
 */
export function PendingStatus({ label }: Readonly<{ label: string }>) {
  return (
    <span aria-busy="true" aria-label={label} className="sr-only" role="status">
      {label}
    </span>
  );
}
