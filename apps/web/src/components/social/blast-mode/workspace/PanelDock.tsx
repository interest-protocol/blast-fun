"use client";
import { useLayoutEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { IconButton, Button } from "#web/components/blast-ui/Button.tsx";

import { BlastMenu, BlastMenuTrigger, BlastMenuRadioGroup, BlastMenuRadioItem, BlastMenuRadioItemIndicator } from "#web/components/blast-ui/BlastMenu.tsx";
import { SearchIcon } from "#web/components/blast-ui/Icons.tsx";
import type { WorkspaceStore } from "./model";
import type { WorkspaceV1 } from "@blast/core/modules/social/blast-workspace/setup.ts";
import { usePanelIdentities, panelIdentityLabel, panelSymbol } from "./panel-identities";
import { PanelMark } from "./PanelMark";
import { MorePanels } from "./TrackedPanels";
import styles from "./PanelDock.module.css";

/**
 * The workspace's panels as coin chips. On a phone, where one card shows at a
 * time, each chip selects its card. On a desktop the cards on screen already
 * name themselves, so only focus view keeps chips, for the other open coins
 * (compare view pages through the rest with its own Previous and Next).
 * Recent panels sit behind one control with their marks.
 */
export function PanelDock({
  snapshot,
  dispatch,
  mobile,
}: Readonly<{ snapshot: WorkspaceV1; dispatch: WorkspaceStore; mobile: boolean }>) {
  const identities = usePanelIdentities();
  const selected = mobile ? (snapshot.mobile_panel_id ?? snapshot.visible_order[0]) : snapshot.focused_panel_id;
  const chips = useRef<HTMLUListElement>(null);
  // A desktop's focus view shows the chosen coin in the middle; its chip would only repeat it.
  const shown = mobile ? snapshot.visible_order
    : snapshot.presentation === "focus" ? snapshot.visible_order.filter(id => id !== selected) : [];
  // The chosen coin scrolls into its own place in the strip.
  useLayoutEffect(() => revealChip(chips.current), [selected]);
  return (
    <nav data-presentation={snapshot.presentation} aria-label="Workspace panels" className={styles.dock}>
      {shown.length > 0 && (
        <ul className={styles.chips} ref={chips}>
          {shown.map((id) => {
            const panel = snapshot.panels[id]!;
            const symbol = panelSymbol(panel, identities);
            const presale = panel.active_namespace === "presale";
            return (
              <li key={id}>
                <Button variant="ghost" size="chip"
                  aria-label={`${symbol}${presale ? " presale" : ""} panel · ${panelIdentityLabel(panel)}`}
                  aria-pressed={mobile ? selected === id : undefined}
                  className={styles.chip}
                  data-selected={mobile ? selected === id : undefined}
                  data-panel-chip={id}
                  onClick={() => {
                    if (mobile) {
                      dispatch.selectMobile(id);
                      dispatch.focus(id);
                      return;
                    }
                    // The card must be shown before it can take focus; this chip leaves the strip once its coin is current.
                    flushSync(() => dispatch.focus(id));
                    document.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
                  }}
                  type="button"
                >
                  <PanelMark identities={identities} panel={panel} />
                  <span className={styles.symbol}>{symbol}</span>
                  {snapshot.visible_order.some(other => other !== id && panelSymbol(snapshot.panels[other]!, identities) === symbol) && <small>{panelIdentityLabel(panel)}</small>}
                  {presale ? <span className={styles.kind}>Presale</span> : null}
                </Button>
              </li>
            );
          })}
        </ul>
      )}
      <MorePanels dispatch={dispatch} snapshot={snapshot} />
    </nav>
  );
}

/** Scrolls an overflowing chip strip so the selected chip's own place (between its neighbours) is in view. */
function revealChip(list: HTMLUListElement | null) {
  const item = list?.querySelector("[data-selected=\"true\"]")?.parentElement;
  if (!list || !item || list.scrollWidth <= list.clientWidth) return;
  const { left: origin } = list.getBoundingClientRect();
  const prev = item.previousElementSibling?.getBoundingClientRect();
  const next = item.nextElementSibling?.getBoundingClientRect();
  const start = prev ? prev.right - origin + list.scrollLeft : 0;
  const end = (next ? next.left - origin + list.scrollLeft : list.scrollWidth) + Number.parseFloat(getComputedStyle(list).paddingInlineEnd || "0");
  if (start < list.scrollLeft) list.scrollLeft = start;
  else if (end > list.scrollLeft + list.clientWidth) list.scrollLeft = end - list.clientWidth;
}

const LAYOUTS: Readonly<Record<number, string>> = {
  1: "M4 4h16v16H4z",
  2: "M4 4h7v16H4zM13 4h7v16h-7z",
  3: "M4 4h7v16H4zM13 4h7v7h-7zM13 13h7v7h-7z",
  4: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
};

function LayoutGlyph({ count }: Readonly<{ count: number }>) {
  return (
    <svg aria-hidden="true" fill="none" stroke="currentColor" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24">
      <path d={LAYOUTS[count]} />
    </svg>
  );
}

const capacityLabel = (count: number) => `${count} ${count === 1 ? "tracked asset" : "tracked assets"}`;

/** How many cards share the desktop screen, set rarely, so one menu showing the current layout; further panels stay saved. */
export function LayoutPicker({ snapshot, dispatch }: Readonly<{ snapshot: WorkspaceV1; dispatch: WorkspaceStore }>) {
  const current = snapshot.desktop_capacity;
  return (
    <BlastMenu
      anchored
      className={styles.layoutMenu}
      label="Tracked asset limit"
      placement={() => ({ side: "bottom", align: "end", sideOffset: 6, avoid: "flip", originX: "100%" })}
      trigger={
        <BlastMenuTrigger render={<IconButton aria-label={`Tracked asset limit: ${current}`} variant="ghost" size="sm" />} aria-label={`Tracked asset limit: ${current}`} className={styles.layoutTrigger} title="Tracked asset limit; visible cards adapt to the space">
          <LayoutGlyph count={current} />
        </BlastMenuTrigger>
      }
    >
      <BlastMenuRadioGroup value={String(current)} onValueChange={(value) => dispatch.setCapacity(Number(value))}>
        {[1, 2, 3, 4].map((count) => (
          <BlastMenuRadioItem className={styles.layoutItem} closeOnClick key={count} value={String(count)}>
            <LayoutGlyph count={count} />
            {capacityLabel(count)}
            <BlastMenuRadioItemIndicator className={styles.layoutCheck}> ✓</BlastMenuRadioItemIndicator>
          </BlastMenuRadioItem>
        ))}
      </BlastMenuRadioGroup>
    </BlastMenu>
  );
}

/** The header's search (BlastMode.dc.html): opens Discover with its search field focused; `/` from anywhere. */
export function WorkspaceSearch({ open, onSearch }: Readonly<{ open: boolean; onSearch: () => void }>) {
  return (
    <Button variant="secondary" size="chip" aria-label="Search coins and presales" aria-keyshortcuts="/" aria-controls="workspace-data" aria-expanded={open} className={styles.search} data-add-chart="" onClick={onSearch} type="button">
      <SearchIcon />
      <span className={styles.searchHint} aria-hidden="true">Search</span>
      <kbd className={styles.searchKey} aria-hidden="true">/</kbd>
    </Button>
  );
}
