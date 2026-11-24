"use client";

import { workspaceScrollOwner } from "./scroll-owner";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useWorkspace } from "./workspace-context";
import styles from "./CoinsData.module.css";

/** Restore after private rows arrive, falling back to the nearest surviving row. */
export function PortfolioRows({ children, label }: Readonly<{ children: ReactNode; label: string }>) {
  const { snapshot, dispatch } = useWorkspace();
  const controls = snapshot.data.controls.Portfolio;
  const list = useRef<HTMLOListElement>(null);
  useLayoutEffect(() => {
    const localBody = list.current?.closest<HTMLElement>("#workspace-data-panel");
    const body = localBody ? workspaceScrollOwner(localBody) : null;
    if (!body) return;
    const rows = [...list.current!.querySelectorAll<HTMLElement>("[data-workspace-portfolio]")];
    const anchor = controls.navigation.anchor;
    const exact = anchor && rows.find(row => row.dataset.workspacePortfolio === anchor.row_id);
    const row = exact || (anchor && rows[Math.min(anchor.index, rows.length - 1)]);
    if (!anchor || !row) { body.scrollTop = controls.navigation.scroll_top; return; }
    body.scrollTop += row.getBoundingClientRect().top - body.getBoundingClientRect().top - anchor.offset;
    if (!exact) dispatch.patchDataControls("Portfolio", { ...controls, navigation: { ...controls.navigation, anchor: { ...anchor, row_id: row.dataset.workspacePortfolio!, index: rows.indexOf(row) } } });
  });
  return <ol className={styles.list} aria-label={label} ref={list}>{children}</ol>;
}
