"use client";
import { DisclosureButton } from "#web/components/blast-ui/Button.tsx";

import { useEffect, useId, useRef, useState } from "react";
import { BlastMenu, BlastMenuTrigger, BlastMenuCheckboxItem, BlastMenuItem } from "#web/components/blast-ui/BlastMenu.tsx";
import { CheckIcon, GridIcon } from "#web/components/blast-ui/Icons.tsx";
import { Sheet, SheetClose, SheetHeading } from "#web/components/blast-ui/Sheet.tsx";
import { useWorkspace } from "./workspace-context";
import type { WorkspaceLayoutTriggerProps } from "./WorkspaceLayout";
import { openWorkspaceSearch } from "./workspace-search";
import { isTradeSubmitShortcut, tradeShortcut } from "./trade-shortcuts";
import type { WorkspaceStore } from "./model";
import styles from "./WorkspaceShortcuts.module.css";

export function WorkspaceShortcuts({ layoutDisabled, triggerRef, resized, onRestoreSizes, activityShown, onActivityShown }: WorkspaceLayoutTriggerProps) {
  const { dispatch: store, presentation } = useWorkspace();
  const [open, setOpen] = useState(false);
  const handingOffFocus = useRef(false);
  const heading = useId();
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (overlayBlocksShortcut(event)) return;
      if (document.hidden || ignoresShortcut(event)) return;
      const snapshot = store.getSnapshot();
      const id = snapshot.focused_panel_id;
      const panel = id && !presentation.data_covers_mobile_panel ? document.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(id)}"]`) : null;
      // A pending/disabled submit still owns its chord; do not insert spaces
      // into the amount or scroll the terminal, including held-key repeats.
      if (panel && isTradeSubmitShortcut(event, panel)) event.preventDefault();
      if (event.repeat) return;
      const button = panel ? tradeShortcut(event, panel) : null;
      if (button) {
        event.preventDefault(); event.stopPropagation();
        // Keep side/preset focus out of the field: Q → 1 → Shift+Space must
        // remain a shortcut sequence, while typed digits always stay literal.
        if (!event.shiftKey) button.focus({ preventScroll: true });
        button.click();
        return;
      }
      navigateShortcut(event, store, () => setOpen(true), presentation.data_covers_mobile_panel);
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [presentation.data_covers_mobile_panel, store]);
  return <>
    <BlastMenu
      anchored
      label="Layout"
      className={styles.menu}
      placement={() => ({ side: "bottom", align: "end", sideOffset: 8, avoid: "flip", originX: "100%" })}
      finalFocus={() => handingOffFocus.current ? false : triggerRef.current}
      onOpenChange={next => { if (next) handingOffFocus.current = false; }}
      trigger={<BlastMenuTrigger render={<DisclosureButton aria-label="Layout" leadingIcon={<GridIcon />} variant="secondary" size="chip">Layout</DisclosureButton>} ref={triggerRef} className={styles.trigger} />}
    >
      {/* The board never rearranges (owner, 2026-10-27): its splitters resize it a little, and this restores the board's sizes. */}
      <BlastMenuCheckboxItem className={styles.menuItem} checked={activityShown} disabled={layoutDisabled} onCheckedChange={onActivityShown}>
        Holders and activity
        <span aria-hidden="true" className={styles.check}>{activityShown ? <CheckIcon /> : null}</span>
      </BlastMenuCheckboxItem>
      {/* Shown only when there is something to restore: a disabled lone choice is an empty one (live audit F36). */}
      {resized ? <BlastMenuItem className={styles.menuItem} disabled={layoutDisabled} onClick={onRestoreSizes}>Restore default sizes</BlastMenuItem> : null}
      <BlastMenuItem className={styles.menuItem} onClick={() => { handingOffFocus.current = true; setOpen(true); }}>Keyboard shortcuts <kbd>?</kbd></BlastMenuItem>
    </BlastMenu>
    <Sheet open={open} labelledBy={heading} onRequestClose={() => setOpen(false)} onClosed={() => triggerRef.current?.focus({ preventScroll: true })}>
      <SheetClose onClick={() => setOpen(false)} />
      <SheetHeading id={heading} title="Keyboard shortcuts" />
      <dl className={styles.list}>
        <div><dt>Select Buy / Sell</dt><dd><kbd>Q</kbd> / <kbd>E</kbd></dd></div>
        <div><dt>Choose amount preset</dt><dd><kbd>1</kbd>–<kbd>4</kbd></dd></div>
        <div><dt>Submit trade or commitment</dt><dd><kbd>Shift</kbd> + <kbd>Space</kbd></dd></div>
        <div><dt>Discover coins and presales</dt><dd><kbd>/</kbd></dd></div>
        <div><dt>Previous / next coin</dt><dd><kbd>[</kbd> / <kbd>]</kbd></dd></div>
        <div><dt>Show shortcuts</dt><dd><kbd>?</kbd></dd></div>
        <div><dt>Exit Blast mode</dt><dd><kbd>B</kbd> / <kbd>Backspace</kbd></dd></div>
        <div><dt>Close overlay / exit Blast</dt><dd><kbd>Esc</kbd></dd></div>
      </dl>
      <p className={styles.note}>Shift+Space works in the amount field. Trade shortcuts pause in dialogs; other shortcuts pause while typing.</p>
    </Sheet>
  </>;
}

function navigateShortcut(event: KeyboardEvent, store: WorkspaceStore, help: () => void, covered: boolean) {
  if (event.composedPath().some(target => target instanceof Element && target.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"])'))) return;
  if (event.shiftKey && event.key !== "?") return;
  if (!["/", "?", "[", "]"].includes(event.key)) return;
  event.preventDefault(); event.stopPropagation();
  if (event.key === "?") { help(); return; }
  if (event.key === "/") { openWorkspaceSearch(store); return; }
  const snapshot = store.getSnapshot();
  if (!snapshot.focused_panel_id || covered) return;
  const index = snapshot.visible_order.indexOf(snapshot.focused_panel_id);
  const next = snapshot.visible_order[index + (event.key === "]" ? 1 : -1)];
  if (next) store.focus(next);
}


function ignoresShortcut(event: KeyboardEvent) {
  return event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey;
}

function overlayBlocksShortcut(event: KeyboardEvent) {
  if (!document.querySelector('dialog[open],[role="dialog"],[aria-modal="true"],[role="menu"],[role="listbox"],[data-blast-popover]')) return false;
  // Also consume held-key repeats before the generic repeat guard. Otherwise
  // native Space can activate a newly focused Cancel/Confirm button on keyup.
  if (event.shiftKey && event.code === "Space" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.isComposing) event.preventDefault();
  return true;
}
