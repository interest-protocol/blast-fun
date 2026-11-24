"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

import { FocusSurface } from "./FocusSurface";
import styles from "./LaunchpadTerminal.module.css";
import { CloseSearchContext } from "./terminal-search-model";

/** True when a key press belongs to something the user is typing in. */
function typing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

/**
 * The global search trigger at the top center of the launchpad header. It
 * opens `children` (the search slot) in a focused surface: full screen on
 * mobile, a centered panel on desktop. `/` opens it from anywhere but a
 * field being typed in.
 */
export function TerminalSearch({ children }: Readonly<{ children: ReactNode }>) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || typing(event.target)) return;
      event.preventDefault();
      // With nothing focused, the shortcut stands in for the trigger, so closing returns focus there.
      if (document.activeElement === document.body) triggerRef.current?.focus();
      setOpen(true);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <button
        ref={triggerRef}
        className={styles.searchTrigger}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-keyshortcuts="/"
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true" className={styles.searchGlyph}>⌕</span>
        Search coins
        <kbd aria-hidden="true" className={styles.searchKey}>/</kbd>
      </button>
      <FocusSurface
        open={open}
        onClose={() => setOpen(false)}
        title="Search"
        layout="responsive"
        returnFocusRef={triggerRef}
      >
        <CloseSearchContext value={() => setOpen(false)}>{children}</CloseSearchContext>
      </FocusSurface>
    </>
  );
}
