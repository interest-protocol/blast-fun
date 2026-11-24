"use client";


import clsx from "clsx";
import { useLayoutEffect, useRef, type ReactNode } from "react";

import styles from "./CoinHome.module.css";
import { RowsPick } from "./HomeControls";
import { Pager } from "#web/components/blast-ui/Pager.tsx";
import { TABLE_PAGE_MOTION_EVENT, TABLE_PAGE_SETTLED_EVENT } from "./use-table-page-motion";

/**
 * A Home table's card (the Main board's 22px card, 8px inset): its surface is
 * a layer of its own, so a page turn can resize the card with a transform
 * (`use-table-page-motion.ts`) while the rows inside never scale.
 */
export function TableCard({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return <div className={clsx(styles.tableCard, className)}>
    <span aria-hidden="true" className={styles.sectionSurface} data-table-surface="" />
    {children}
  </div>;
}

/**
 * The same controls for each Home table: rows per page and the count on the left, the
 * pager on the right; pagination never changes another table. `alwaysShow` keeps a
 * single page's pager (the Main board's ranked traders, "‹ 1 ›").
 */
export function TableFooter({ what, rows, page, pages, onRows, onPage, count, alwaysShow = false, pending = false }: Readonly<{
  what: string;
  rows: number;
  page: number;
  pages: number;
  onRows: (rows: number) => void;
  onPage: (page: number) => void;
  /** The table's total in words ("45 coins", "4 traders ranked"); nothing while unknown. */
  count?: ReactNode;
  alwaysShow?: boolean;
  pending?: boolean;
}>) {
  const footer = useRef<HTMLDivElement>(null);
  const pointer = useRef(false);
  const changing = () => footer.current?.dispatchEvent(new CustomEvent(TABLE_PAGE_MOTION_EVENT, { bubbles: true, detail: pointer.current }));
  useLayoutEffect(() => {
    const node = footer.current;
    return () => { node?.dispatchEvent(new CustomEvent(TABLE_PAGE_SETTLED_EVENT, { bubbles: true })); };
  }, []);
  useLayoutEffect(() => {
    if (!pending) footer.current?.dispatchEvent(new CustomEvent(TABLE_PAGE_SETTLED_EVENT, { bubbles: true }));
  }, [page, rows, pages, pending]);
  return <div ref={footer} className={styles.tableFooter} data-table-footer=""
    onClickCapture={(event) => { pointer.current = event.detail > 0; }}
    onKeyDownCapture={() => { pointer.current = false; }}>
    <div className={styles.footStart}>
      <RowsPick rows={rows} onRows={(next) => { if (next !== rows) { changing(); onRows(next); } }} what={what} />
      {count ? <span className={clsx("num", styles.footCount)}>{count}</span> : null}
    </div>
    <Pager alwaysShow={alwaysShow} what={what} page={page} pages={pages} onPage={(next) => { if (next !== page) { changing(); onPage(next); } }} />
  </div>;
}
