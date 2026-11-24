"use client";

import { useEffect, useId, useRef, type ReactNode, type RefObject } from "react";

import { captureFocusReturn } from "./focus-return";
import styles from "./LaunchpadTerminal.module.css";

/**
 * A focused modal surface (Search, mobile Trade) on the native `<dialog>`:
 * the rest of the page is inert, Escape closes it, and focus returns to the
 * control that opened it. When that control is gone or hidden, focus goes to
 * `returnFocusRef`, then `fallbackFocusRef` (for example the desktop Trade
 * rail after the viewport crosses the breakpoint).
 * `fullscreen` always covers the viewport; `responsive` covers it below the
 * desktop breakpoint and is a centered panel above it. An element marked
 * `data-autofocus` (such as the search field) takes focus when it opens.
 */
export function FocusSurface({
  open,
  onClose,
  title,
  layout,
  returnFocusRef,
  fallbackFocusRef,
  children,
}: Readonly<{
  open: boolean;
  onClose: () => void;
  title: string;
  layout: "fullscreen" | "responsive";
  returnFocusRef: RefObject<HTMLElement | null>;
  fallbackFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}>) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || !dialog) return;
    const restoreFocus = captureFocusReturn(document);
    // Resolved on close, deliberately: after a breakpoint change the fallback
    // (the desktop rail) exists only then.
    const fallbacks = [returnFocusRef, fallbackFocusRef];
    if (!dialog.open) dialog.showModal();
    // React sets no `autofocus` attribute on client renders, so a field asks for focus with `data-autofocus`.
    dialog.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    return () => {
      dialog.close();
      restoreFocus(...fallbacks.map((ref) => ref?.current ?? null));
    };
  }, [open, returnFocusRef, fallbackFocusRef]);

  return (
    <dialog
      ref={dialogRef}
      aria-hidden={!open || undefined}
      inert={!open || undefined}
      className={styles.surface}
      data-layout={layout}
      aria-labelledby={titleId}
      onClose={onClose}
    >
      <div className={styles.surfaceHeader}>
        <h2 className={styles.surfaceTitle} id={titleId}>{title}</h2>
        <button className={styles.surfaceClose} type="button" onClick={onClose}>
          Close
        </button>
      </div>
      <div className={styles.surfaceBody}>{children}</div>
    </dialog>
  );
}
