"use client";
import { IntentLink } from "#web/components/blast-ui/NavigationLink.tsx";
import { Button } from "#web/components/blast-ui/Button.tsx";
import { HelmetMark } from "#web/components/blast-ui/Icons.tsx";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { AccountAvatar } from "#web/components/social/AccountAvatar.tsx";
import { useCurrentBlastAccount } from "./workspace/BlastActionProvider";
import { coverShell } from "./blast-mode-shell";
import { coverPage } from "./live/mode-cover";
import type { WorkspaceOrigin } from "./workspace/session";
import styles from "./workspace/WorkspaceHost.module.css";

import { WorkspaceToolbarTarget, WorkspaceStatusTarget, WorkspaceStatusSlot } from "./workspace/frame-targets";

/** Widgets that may read letters or Backspace themselves; `B` and Backspace never exit from inside one. */
const TYPING_WIDGET = '[role="textbox"], [role="combobox"], [role="searchbox"], [role="slider"], [role="spinbutton"]';
/** How long after an Escape closes a layer a further Escape is still read as closing, never as Exit. */
export const ESCAPE_SETTLE_MS = 500;
/** An open popover, menu or dialog layer: Base UI marks open popups `data-open`; our own popups say `data-open="true"`. */
const OPEN_LAYER = '[data-open]:not([data-open="false"]):is([role="dialog"], [role="menu"], [role="listbox"], [role="region"][data-blast-popover])';

export function WorkspaceFrame({
  children,
  onExit,
  origin,
}: Readonly<{
  children: ReactNode;
  onExit: () => void;
  origin?: WorkspaceOrigin | null;
}>) {
  const frame = useRef<HTMLElement>(null);
  const [toolbarTarget, setToolbarTarget] = useState<HTMLElement | null>(null);
  const [statusTarget, setStatusTarget] = useState<HTMLElement | null>(null);
  const exit = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    document.querySelector("[data-workspace-boot]")?.remove();
    const uncover = coverShell(document, origin, frame.current);
    const uncoverPage = coverPage();
    exit.current?.focus({ preventScroll: true });
    return () => {
      uncoverPage();
      uncover();
    };
  }, [origin]);
  useEffect(() => {
    // When an Escape last closed a layer: the frame never exits on that key, nor on another within ESCAPE_SETTLE_MS (audit F4).
    let layerClosedAt = -Infinity;
    // The Escape that found a layer open: that layer owns the key, so the frame neither dismisses nor exits on it.
    let layerEscape: KeyboardEvent | null = null;
    // The last Escape the frame's own listener received; one that never arrives was stopped by a layer.
    let reached: KeyboardEvent | null = null;
    // The last Escape that found no layer open: a layer that handled and stopped it never reached the frame,
    // which only shows once dispatch ends, so the next Escape settles it before it is read.
    let pending: KeyboardEvent | null = null;
    const noteLayer = (event: KeyboardEvent) => {
      if (isExitKey(event)) {
        if (!event.defaultPrevented && !document.querySelector(`${OPEN_LAYER}, dialog[open], [aria-modal="true"]`)) { event.preventDefault(); onExit(); }
        return;
      }
      if (event.key !== "Escape") return;
      if (pending?.defaultPrevented && pending !== reached) layerClosedAt = Math.max(layerClosedAt, pending.timeStamp);
      pending = null;
      if (document.querySelector(OPEN_LAYER)) {
        layerClosedAt = event.timeStamp;
        layerEscape = event;
        return;
      }
      pending = event;
    };
    const escape = (event: KeyboardEvent) => {
      // Safari reports an IME's candidate-cancelling Escape as keyCode 229, sometimes with isComposing already false.
      if (event.isComposing || event.keyCode === 229 || event.repeat || event === layerEscape) return;
      event.preventDefault();
      const problem = frame.current?.querySelector<HTMLDetailsElement>("[data-workspace-save-problem][open]");
      if (problem) { problem.open = false; problem.querySelector("summary")?.focus(); layerClosedAt = event.timeStamp; return; }
      const dismiss = Array.from(frame.current?.querySelectorAll<HTMLButtonElement>("[data-workspace-escape]") ?? []).filter(isVisible).at(-1);
      if (dismiss) { dismiss.click(); layerClosedAt = event.timeStamp; }
      else if (event.timeStamp - layerClosedAt >= ESCAPE_SETTLE_MS) onExit();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") reached = event;
      if (event.key === "Escape" && event.defaultPrevented) layerClosedAt = event.timeStamp;
      if (
        event.defaultPrevented ||
        event
          .composedPath()
          .some(
            (target) =>
              target instanceof Element &&
              target.matches('dialog[open], [aria-modal="true"]'),
          ) ||
        document.querySelector('dialog[open], [aria-modal="true"]')
      )
        return;
      if (event.key === "Escape") escape(event);
      if (event.key !== "Tab") return;
      const targets = Array.from(
        frame.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]',
        ) ?? [],
      ).filter(
        (element) =>
          element.tabIndex >= 0 && !element.closest("[inert], [hidden]") &&
          isVisible(element) &&
          !element.closest('[data-focus-hidden="true"]'),
      );
      const first = targets[0];
      const last = targets.at(-1);
      if (!frame.current?.contains(document.activeElement)) { event.preventDefault(); first?.focus(); }
      else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", noteLayer, true);
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", noteLayer, true);
      document.removeEventListener("keydown", keydown);
    };
  }, [onExit]);
  return (
    <WorkspaceToolbarTarget value={toolbarTarget}>
    <WorkspaceStatusTarget value={statusTarget}>
    <WorkspaceStatusSlot value={setStatusTarget}>
    <section
      aria-label="Blast mode workspace"
      className={styles.frame}
      data-workspace-host=""
      ref={frame}
    >
      <header className={styles.header}>
        <div className={styles.brand}>
          <HelmetMark className={styles.brandMark} />
          <strong>Blast mode</strong>
        </div>
        <div data-workspace-toolbar="" className={styles.headerToolbar} ref={setToolbarTarget} />
        <WorkspaceViewer onExit={onExit} />
        <Button variant="secondary" size="chip"
          aria-keyshortcuts="Escape B Backspace"
          title="Exit Blast mode (Esc, B or Backspace)"
          className={styles.exit}
          onClick={onExit}
          ref={exit}
          type="button"
        >
          Exit <kbd>Esc</kbd>
        </Button>
      </header>
      {children}
    </section>
    </WorkspaceStatusSlot>
    </WorkspaceStatusTarget>
    </WorkspaceToolbarTarget>
  );
}

/** Who is signed in to act here: the same avatar and name as the rest of Blast. Nothing for a guest. */
function WorkspaceViewer({ onExit }: Readonly<{ onExit: () => void }>) {
  const account = useCurrentBlastAccount().accountState?.account;
  if (!account) return null;
  const name = (account.display_name ?? "").trim() || account.callsign;
  return (
    <IntentLink aria-label={`Signed in as ${name}`} href={`/@${account.callsign}`} onNavigate={onExit} className={styles.viewer} title={`Signed in as @${account.callsign}`}>
      <span className={styles.viewerAvatar}><AccountAvatar accountId={account.callsign} avatarUrl={account.avatar_url} size={24} /></span>
      <span>{name}</span>
    </IntentLink>
  );
}

/** `B` or Backspace, pressed alone outside a text field or typing widget, leaves Blast mode in one press (Escape steps back through layers first). */
function isExitKey(event: KeyboardEvent) {
  if (event.key !== "Backspace" && !/^b$/i.test(event.key)) return false;
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat || event.isComposing || event.keyCode === 229) return false;
  return !event.composedPath().some((target) => target instanceof HTMLElement && (/^(input|textarea|select)$/i.test(target.tagName) || target.isContentEditable || target.matches(TYPING_WIDGET)));
}

/** Walk ancestors too: jsdom has no geometry, and descendants of display:none retain their own display. */
function isVisible(element: HTMLElement) {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (node.parentElement?.tagName === "DETAILS" && !node.parentElement.hasAttribute("open") && node.tagName !== "SUMMARY") return false;
    const style = getComputedStyle(node);
    if (node.hidden || style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}
