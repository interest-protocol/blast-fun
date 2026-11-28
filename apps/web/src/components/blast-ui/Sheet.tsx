"use client";
import { IconButton } from "./Button";

import { Dialog } from "@base-ui/react/dialog";
import clsx from "clsx";
import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEventHandler, type ReactNode } from "react";
import { flushSync } from "react-dom";

import { useFeelOpenClose } from "#web/components/blast-feel/use-feel-open-close.ts";
import { usePortalContainer } from "#web/components/ui-libraries/portal.ts";
import { useHydrated } from "#web/components/ui-libraries/use-hydrated.tsx";

import { CloseIcon } from "./Icons";
import styles from "./Sheet.module.css";
import { bindSheetGesture, springSheetHome } from "./sheet-gesture";
import { springHome } from "./sheet-gesture-model";
import { closeSheetLayer, isTopSheet, openSheetLayer, removeSheetLayer, sheetReturnTargets } from "./sheet-layers";
import { closeSheetMotion, liveTranslateY, openSheetMotion, swapSheetMotion } from "./sheet-motion";
import { bindSheetViewport } from "./sheet-viewport";
import { instantFeedback, keyboardInput } from "./feedback-motion";

/**
 * A sheet (FEATURE-MAP §8, tokens.md §6): a modal dialog over a blurred scrim,
 * a bottom sheet at ≤760px, on base-ui's `Dialog` (OA-28 M2) with the gate's
 * version 5 motion and pull-down (OA-31).
 *
 * - **Motion** (`sheet-motion.ts`, the gate's `openLayer`/`closeLayer`/
 *   `swapSheet`): scrim 180 ms; sheet 200 ms from below,
 *   or 200 ms up from the bottom on phones; it closes in 160 ms from wherever
 *   it is; steps swap by sliding out left and in from the right
 *   (`useSheet().swap`). Under reduced motion opening, closing and step changes are immediate.
 * - **Pull-down** (phones, `sheet-gesture.ts`): by the 36×5 grabber or from
 *   anywhere once the content is at the top; 1:1, rubber-banded above rest;
 *   released past half its height it closes at the finger's speed, else a
 *   critically damped spring brings it home. It can be caught mid-open and, when the owner supports it, during dismissal.
 * - **Layers** (`sheet-layers.ts`, the authority): sheets stack in the order
 *   they open (z 80–89, under the toasts at 90); only the newest open one
 *   hears Escape and keeps Tab; a closing sheet drops `aria-modal`, takes only a reopening drag when supported
 *   (`data-closing`) and is no longer a layer; the page is
 *   scroll-locked while any sheet is open; focus goes back along the opener
 *   chain once nothing opened since is still open.
 * - **base-ui** owns the portal (into the Blast UI root, so the tokens and
 *   the theme apply), the dialog's role and labelling, the page's
 *   `aria-hidden` while it is open, its focus guards, and Escape heard on the
 *   document, so it reaches the top sheet wherever focus is (a wallet button
 *   disabled under focus drops it on `<body>`). It neither locks the scroll
 *   (`modal="trap-focus"`), nor closes on outside presses (the scrim does,
 *   as the gate's), nor moves focus: the layers do.
 * - Opening and closing answer with the Feel layer's `open` / `close` cue
 *   when the reader caused it (R3-12, `useFeelOpenClose`).
 *
 * A popup renders only in the browser (ui-libraries §3.1): a sheet already
 * open in the server's HTML (a fixture, onboarding on arrival) is written as
 * the same static markup, and the dialog takes over once the page hydrates.
 *
 * Mount it under the app shell's `overlays` so the page behind it, its
 * shortcuts and its toasts stay as they are.
 */
export type SheetProps = Readonly<{
  open: boolean;
  /** Escape, the close button, the scrim, or a pull down past half its height. */
  onRequestClose: () => void;
  /** After the closing motion, once the sheet is gone. */
  onClosed?: () => void;
  /** A drag may catch the sheet during dismissal. */
  onRequestOpen?: () => void;
  /** The id of the sheet's title (`aria-labelledby`). */
  labelledBy: string;
  /** The id of a short description to announce when the sheet opens. */
  describedBy?: string;
  /** The element that takes focus on open (the design: the first action, or the field). */
  initialFocus?: () => HTMLElement | null;
  onKeyDown?: KeyboardEventHandler<HTMLElement>;
  /** The sheet ends with a sticky `SheetCta`. */
  hasCta?: boolean;
  /** The sheet's content holds a `SheetDock` (OA-24): the sheet's bottom edge is the dock's. */
  hasDock?: boolean;
  /** Extra classes for the sheet box. */
  className?: string;
  children: ReactNode;
}>;

type SheetApi = Readonly<{
  /** Slides the current step out, applies `change` (the next step's state), then slides it in. */
  swap: (change: () => void) => void;
}>;

const SheetContext = createContext<SheetApi>({ swap: (change) => change() });

/** The open sheet's controls, for its steps. */
export function useSheet(): SheetApi {
  return useContext(SheetContext);
}

const PHONE = "(max-width: 760px)";
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isPhone(): boolean {
  return typeof window !== "undefined" && window.matchMedia(PHONE).matches;
}

function sheetClass({ hasCta = false, hasDock = false, className }: SheetProps): string {
  return [styles.sheet, hasCta ? styles.hasCta : "", hasDock ? styles.hasDock : "", className ?? ""].filter(Boolean).join(" ");
}

export function Sheet(props: SheetProps) {
  useFeelOpenClose(props.open);
  if (useHydrated()) return <LiveSheet {...props} />;
  return props.open ? <StaticSheet {...props} /> : null;
}

/** The server's (and hydration's) sheet: the dialog's markup, with nothing that moves. */
function StaticSheet(props: SheetProps) {
  return (
    <div className={styles.scrim} data-sheet-scrim="">
      <dialog aria-describedby={props.describedBy} aria-labelledby={props.labelledBy} aria-modal className={sheetClass(props)} onKeyDown={props.onKeyDown} open tabIndex={-1}>
        {props.children}
      </dialog>
    </div>
  );
}

function LiveSheet(props: SheetProps) {
  const { open, labelledBy, children } = props;
  const canReopen = props.onRequestOpen !== undefined;
  const [mounted, setMounted] = useState(open);
  const [scrim, setScrim] = useState<HTMLDivElement | null>(null);
  const [sheet, setSheet] = useState<HTMLDivElement | null>(null);
  const container = usePortalContainer();
  // The sheet in the layers, until it is gone (base-ui may unmount it a moment before the exit's `finish`).
  const layer = useRef<HTMLElement | null>(null);
  const returnFocus = useRef<readonly HTMLElement[] | null>(null);
  const exit = useRef<Animation | null>(null);
  // px/s a pull handed over to the close, so the sheet leaves at the finger's speed (the gate's `sheetFling`).
  const fling = useRef(0);
  const isOpen = useRef(open);
  const latest = useRef(props);
  useEffect(() => {
    latest.current = props;
  });

  // Open: mount now; close: keep it for the closing motion.
  if (open && !mounted) setMounted(true);

  useLayoutEffect(() => {
    isOpen.current = open;
    if (!mounted || scrim === null || sheet === null) return;
    const mode = { phone: isPhone(), reduce: instantFeedback(), instant: keyboardInput() };
    if (open) {
      // Reopening continues from the live position rather than replaying the entrance.
      const caught = exit.current !== null;
      exit.current = null;
      const opening = returnFocus.current === null;
      if (returnFocus.current === null) returnFocus.current = sheetReturnTargets();
      // On top of every other sheet, with the page locked.
      openSheetLayer({ scrim, sheet, returns: returnFocus.current });
      layer.current = sheet;
      if (opening || caught) {
        openSheetMotion(scrim, sheet, { ...mode, resume: caught });
      }
      if (opening) (latest.current.initialFocus?.() ?? sheet).focus({ preventScroll: true });
      return;
    }
    if (exit.current !== null) return;
    closeSheetLayer(sheet);
    const out = closeSheetMotion(scrim, sheet, { ...mode, fling: fling.current });
    fling.current = 0;
    exit.current = out;
    out.onfinish = () => {
      if (exit.current !== out) return;
      exit.current = null;
      returnFocus.current = null;
      layer.current = null;
      // Unlocks the page unless another sheet is open; focus stays in a sheet opened since.
      const target = removeSheetLayer(sheet);
      // Gone at once, so no other sheet hands focus back into it.
      flushSync(() => setMounted(false));
      target?.focus({ preventScroll: true });
      latest.current.onClosed?.();
    };
  }, [open, mounted, scrim, sheet]);

  useLayoutEffect(() => {
    if (!mounted || !scrim || !window.visualViewport) return;
    return bindSheetViewport(scrim, window.visualViewport);
  }, [mounted, scrim]);

  // Leaving the page with the sheet open must not leave the page locked.
  useLayoutEffect(
    () => () => {
      if (layer.current !== null) removeSheetLayer(layer.current);
    },
    [],
  );

  // Tab stays in the top sheet (Escape comes through base-ui, below).
  useEffect(() => {
    if (!mounted || !open || sheet === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Tab" || !isTopSheet(sheet)) return;
      const focusables = [...sheet.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.offsetParent !== null);
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && (document.activeElement === first || !sheet.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !sheet.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [mounted, open, sheet]);

  // The pull-down, on phones (checked at each press, so a rotated phone or a resized window follows).
  useEffect(() => {
    if (!mounted || scrim === null || sheet === null) return;
    return bindSheetGesture({
      sheet,
      scrim,
      enabled: isPhone,
      closing: () => !isOpen.current || exit.current !== null,
      reopen: canReopen ? () => flushSync(() => latest.current.onRequestOpen?.()) : undefined,
      reduce: instantFeedback,
      close: (speed) => {
        fling.current = speed;
        latest.current.onRequestClose();
        // A sheet its owner keeps open (busy, say) springs back from where the finger left it.
        requestAnimationFrame(() => {
          if (!isOpen.current || exit.current !== null || !sheet.isConnected) return;
          fling.current = 0;
          springSheetHome(sheet, scrim, springHome(liveTranslateY(sheet), 0), instantFeedback());
        });
      },
    });
  }, [mounted, scrim, sheet, canReopen]);

  const swap = useCallback(
    (change: () => void) => {
      if (sheet === null) {
        change();
        return;
      }
      swapSheetMotion(
        sheet.querySelector<HTMLElement>("[data-sheet-step]") ?? sheet,
        () => {
          flushSync(change);
          sheet.scrollTop = 0;
          // The control that started the swap may be gone: keep focus in the dialog.
          if (!sheet.contains(document.activeElement)) sheet.focus({ preventScroll: true });
        },
        { reduce: instantFeedback() },
      );
    },
    [sheet],
  );
  const api = useMemo<SheetApi>(() => ({ swap }), [swap]);

  // base-ui only reports; the owner decides. Escape from anywhere (focus fallen to <body> included) asks the top open sheet to close.
  const onOpenChange = (next: boolean, details: Dialog.Root.ChangeEventDetails) => {
    details.cancel();
    details.allowPropagation();
    // The key can reach another sheet after React has closed the top sheet in the same event.
    if (next || details.reason !== "escape-key" || details.event.defaultPrevented || !isOpen.current || sheet === null || !isTopSheet(sheet)) return;
    details.event.preventDefault();
    latest.current.onRequestClose();
  };

  if (!mounted) return null;
  return (
    <Dialog.Root disablePointerDismissal modal="trap-focus" onOpenChange={onOpenChange} open={open}>
      <Dialog.Portal container={container}>
        <Dialog.Viewport
          className={styles.scrim}
          // Closing, it is no longer a layer: presses go through to the sheet under it.
          data-closing={open ? undefined : ""}
          data-reopen={canReopen ? "" : undefined}
          data-sheet-scrim=""
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && open) latest.current.onRequestClose();
          }}
          ref={setScrim}
        >
          <Dialog.Popup
            aria-describedby={props.describedBy}
            aria-labelledby={labelledBy}
            aria-modal={open ? true : undefined}
            className={sheetClass(props)}
            finalFocus={false}
            initialFocus={false}
            onKeyDown={open ? props.onKeyDown : undefined}
            ref={setSheet}
            role="dialog"
            tabIndex={-1}
          >
            <SheetContext value={api}>{children}</SheetContext>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** The shared close button at the top right (`aria-label="Close"`). */
export function SheetClose({ onClick, disabled }: Readonly<{ onClick: () => void; disabled?: boolean }>) {
  return (
    <IconButton variant="secondary" size="sm" aria-label="Close" className={styles.close} disabled={disabled} onClick={onClick} type="button">
      <CloseIcon />
    </IconButton>
  );
}

/** The sheet's title (27px/700) and its lead line. */
export function SheetHeading({ id, leadId, title, lead }: Readonly<{ id: string; leadId?: string; title: string; lead?: ReactNode }>) {
  return (
    <div>
      <h2 className={styles.title} id={id}>
        {title}
      </h2>
      {lead ? <p className={styles.lead} id={leadId}>{lead}</p> : null}
    </div>
  );
}

/** The sticky action area at the bottom of a sheet, fading the content above it. `className` adds the caller's own layout (gap). */
export function SheetCta({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return <div className={clsx(styles.cta, className)}>{children}</div>;
}

/**
 * A primary action docked to the sheet's bottom edge from inside the content
 * (OA-24, the gate's `.cta-dock`): it bleeds to the sheet's sides and fades
 * what scrolls under it. The sheet passes `hasDock`.
 */
export function SheetDock({ children }: Readonly<{ children: ReactNode }>) {
  return <div className={styles.dock}>{children}</div>;
}
