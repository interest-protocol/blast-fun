"use client";

import { blastUiRoot } from "#web/components/blast-ui/use-shell-prefs.ts";

import { useHydrated } from "./use-hydrated";

/**
 * Where base-ui's `*.Portal` should mount (OA-28): the Blast UI root, which
 * carries the design tokens, the theme and the device's preferences as
 * attributes. base-ui's default, `document.body`, sits outside it, so a popup
 * there would lose every `var(--…)`. Null until hydration, which base-ui
 * reads as "wait for the container" (popups only open after it anyway).
 *
 *     <Dialog.Portal container={usePortalContainer()}>
 */
export function usePortalContainer(): HTMLElement | null {
  return useHydrated() ? blastUiRoot() : null;
}
