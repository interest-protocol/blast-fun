"use client";

import clsx from "clsx";

import { Button, IconButton } from "./Button";
import { NextIcon, PreviousIcon } from "./Icons";
import { pageItems } from "./pager-model";
import styles from "./Pager.module.css";

type PagerProps = Readonly<{
  /** What the pages hold, for the landmark name: "coins" → "Pages of coins". */
  what: string;
  page: number;
  onPage: (page: number) => void;
  pending?: boolean;
  /** Keep the pager (both steps disabled) when everything fits on one page, as the Main board's ranked traders. */
  alwaysShow?: boolean;
  className?: string;
}> & (Readonly<{ pages: number; hasMore?: never }> | Readonly<{ hasMore: boolean; pages?: never }>);

/**
 * The one pager (System board): Previous, the page numbers when the total is
 * known (or the current page when the list only knows whether more follow),
 * and Next, as 32px ghost buttons 2px apart with the current page in ink. It
 * renders nothing when everything fits on one page, unless `alwaysShow`. A
 * page is a button, never a link: it is a view state, not a place.
 */
export function Pager({ what, page, onPage, pending = false, alwaysShow = false, className, ...count }: PagerProps) {
  const pages = count.pages;
  const last = pages ?? (count.hasMore ? page + 1 : page);
  if (last <= 1 && !alwaysShow) return null;
  return (
    <nav aria-label={`Pages of ${what}`} className={clsx(styles.pager, className)}>
      <IconButton aria-label="Previous page" className={styles.step} disabled={pending || page <= 1} onClick={() => onPage(page - 1)} size="sm">
        <PreviousIcon />
      </IconButton>
      {pages === undefined ? (
        <span className={clsx(styles.current, "num")}>Page {page}</span>
      ) : (
        pageItems(page, pages).map((item, index) => item === null
          ? <span aria-hidden="true" className={styles.gap} key={`gap-${index}`}>…</span>
          : (
            <Button
              aria-current={item === page ? "page" : undefined}
              aria-label={`Page ${item}`}
              className={clsx(styles.page, "num")}
              disabled={pending}
              key={item}
              onClick={() => { if (item !== page) onPage(item); }}
              size="sm"
              variant="ghost"
            >
              {item}
            </Button>
          ))
      )}
      <IconButton aria-label="Next page" className={styles.step} disabled={pending || page >= last} onClick={() => onPage(page + 1)} size="sm">
        <NextIcon />
      </IconButton>
    </nav>
  );
}
