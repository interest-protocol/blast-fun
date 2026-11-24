"use client";

import { reportViewTransitionError } from "./view-transition-error.ts";
import { useSyncExternalStore } from "react";

import { EASE_IN_OUT, EASE_OUT, T2, T4 } from "./motion-tokens";
import { SHELL_PHONE_QUERY } from "./nav";

import {
  DEFAULT_SHELL_PREFS,
  shellPrefAttributes,
  shellPrefsFromAttributes,
  syncThemeColor,
  writeShellPref,
  type ShellPrefName,
  type ShellPrefs,
} from "./prefs";

/**
 * The client side of the shell preferences. The boot script has already put
 * them on the page root; this store reads them from there, and `setShellPref`
 * writes storage, the root's attributes (which the CSS reads) and tells every
 * reader. The server snapshot is the defaults, so hydration matches the HTML
 * and the real values arrive in the next render.
 */

const listeners = new Set<() => void>();
let cached: Readonly<{ key: string; prefs: ShellPrefs }> | null = null;

/** The page root the boot script wrote to, or null outside a Blast UI page. */
export function blastUiRoot(): HTMLElement | null {
  return typeof document === "undefined" ? null : document.querySelector<HTMLElement>("[data-blast-ui]");
}

function snapshot(): ShellPrefs {
  const root = blastUiRoot();
  if (!root) return DEFAULT_SHELL_PREFS;
  const prefs = shellPrefsFromAttributes((name) => root.getAttribute(name));
  const key = JSON.stringify(prefs);
  if (cached?.key !== key) cached = { key, prefs };
  return cached.prefs;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Tells every reader the root's preferences changed (after `ShellPrefsBoot` applied them on the client). */
export function notifyShellPrefs(): void {
  for (const listener of listeners) listener();
}

/** The device's shell preferences (the defaults while hydrating). */
export function useShellPrefs(): ShellPrefs {
  return useSyncExternalStore(subscribe, snapshot, () => DEFAULT_SHELL_PREFS);
}

/** How long a column toggle animates (`AppShell.module.css`: its longest delay plus duration). */
const LAYOUT_MOTION_MS = 240;
let shellTransition: ViewTransition | undefined;
let layoutMotionTimer: ReturnType<typeof setTimeout> | undefined;

/** Changes one preference: remembered on this device and applied to the page at once. */
export function setShellPref<K extends ShellPrefName>(name: K, value: ShellPrefs[K]): void {
  writeShellPref(storage(), name, value);
  const root = blastUiRoot();
  // Inside a view transition the columns morph as snapshots (blast-ui.css), so the grid itself never animates.
  let snapshots = false;
  const apply = () => {
    const next = { ...snapshot(), [name]: value };
    if (root) {
      if (name === "railMini") root.setAttribute("data-rail-selected", "");
      // Without view transitions the shell's columns animate only while the viewer folds one; arriving on or leaving Home snaps.
      if (!snapshots && (name === "railMini" || name === "asideCollapsed") && !prefersReducedMotion() && document.documentElement.dataset?.blastInput !== "keyboard") {
        root.setAttribute("data-shell-moving", "");
        clearTimeout(layoutMotionTimer);
        layoutMotionTimer = setTimeout(() => root.removeAttribute("data-shell-moving"), LAYOUT_MOTION_MS);
      }
      const attributes = shellPrefAttributes(next);
      for (const [attribute, attributeValue] of Object.entries(attributes)) {
        if (attributeValue === null) root.removeAttribute(attribute);
        else root.setAttribute(attribute, attributeValue);
      }
    }
    // The phone's status bar follows the chosen theme (`FEATURE-MAP-R3.md` §1).
    if (typeof document !== "undefined") syncThemeColor(document, next.theme, window.matchMedia(DARK_QUERY).matches);
    notifyShellPrefs();
  };
  shellTransition?.skipTransition?.();
  shellTransition = undefined;
  const html = typeof document === "undefined" ? null : document.documentElement;
  html?.classList.remove("blast-shell-changing");
  const start = typeof document === "undefined" ? undefined : document.startViewTransition?.bind(document);
  if (!root || !start || (name !== "railMini" && name !== "asideCollapsed") || html?.dataset?.blastInput === "keyboard") {
    apply();
    return;
  }
  // Snapshot the column change once and morph the shell's regions, instead of reflowing the feed every frame.
  // Reduced motion keeps the transition for its short crossfade alone.
  html?.classList.add("blast-shell-changing");
  snapshots = true;
  const transition = start(apply);
  shellTransition = transition;
  transition.finished.finally(() => {
    if (shellTransition !== transition) return;
    shellTransition = undefined;
    html?.classList.remove("blast-shell-changing");
  }).catch(reportViewTransitionError);
}

const DARK_QUERY = "(prefers-color-scheme: dark)";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function mediaStore(query: string) {
  return {
    subscribe(listener: () => void) {
      const list = window.matchMedia?.(query);
      list?.addEventListener("change", listener);
      return () => list?.removeEventListener("change", listener);
    },
    snapshot: () => window.matchMedia?.(query).matches ?? false,
  };
}

const darkMedia = mediaStore(DARK_QUERY);
const reducedMedia = mediaStore(REDUCED_MOTION_QUERY);
const phoneMedia = mediaStore(SHELL_PHONE_QUERY);

export function usePhoneLayout(): boolean {
  return useSyncExternalStore(phoneMedia.subscribe, phoneMedia.snapshot, () => false);
}

/** Tracks reduced motion, including changes while the interface is open. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(reducedMedia.subscribe, reducedMedia.snapshot, () => false);
}

/** Whether the page currently renders dark (the stored choice, or the system's under `system`). */
export function useIsDark(): boolean {
  const prefs = useShellPrefs();
  const systemDark = useSyncExternalStore(darkMedia.subscribe, darkMedia.snapshot, () => false);
  return prefs.theme === "dark" || (prefs.theme === "system" && systemDark);
}

/** True when the reader asked for reduced motion (always false on the server). */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

/** The theme cross-fade under reduced motion: an opacity change, within --t2. */
export const THEME_FADE_MS = T2;
/** The circular reveal of a new theme: on-screen movement, at the 300ms budget. */
export const THEME_REVEAL_MS = T4;

/**
 * Applies a theme with the design's circular reveal from `origin` (tokens.md
 * §1): a View Transition whose new snapshot grows from the control's centre
 * over 300ms. With reduced motion there is no sweep, but no sudden flash of
 * light or dark either: the two themes cross-fade over 200ms (OA-31).
 * Without View Transitions it swaps at once.
 */
export function applyTheme(theme: ShellPrefs["theme"], origin?: Element | null): void {
  const run = () => setShellPref("theme", theme);
  const start = typeof document !== "undefined" ? document.startViewTransition?.bind(document) : undefined;
  if (!start || !origin) {
    run();
    return;
  }
  const html = document.documentElement;
  // `blast-theming` turns the default cross-fade off (blast-ui.css), so the one animation below is the whole change.
  html.classList.add("blast-theming");
  const reduced = prefersReducedMotion();
  const reveal = reduced ? null : circleFrom(origin);
  const transition = start(run);
  transition.ready
    .then(() =>
      reveal
        ? html.animate(
            { clipPath: [`circle(0px at ${reveal.cx}px ${reveal.cy}px)`, `circle(${reveal.radius}px at ${reveal.cx}px ${reveal.cy}px)`] },
            { duration: THEME_REVEAL_MS, easing: EASE_IN_OUT, pseudoElement: "::view-transition-new(root)" },
          )
        : html.animate({ opacity: [0, 1] }, { duration: THEME_FADE_MS, easing: EASE_OUT, pseudoElement: "::view-transition-new(root)" }),
    )
    .catch(reportViewTransitionError);
  // An interrupted transition rejects `finished`; `.finally` would pass that on (`FEATURE-MAP-R3.md` §1).
  transition.finished.finally(() => html.classList.remove("blast-theming")).catch(reportViewTransitionError);
}

/** The reveal's circle: centred on the pressed control, reaching the farthest corner of the viewport. */
function circleFrom(origin: Element): Readonly<{ cx: number; cy: number; radius: number }> {
  const rect = origin.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return { cx, cy, radius: Math.hypot(Math.max(cx, innerWidth - cx), Math.max(cy, innerHeight - cy)) };
}
