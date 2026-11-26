"use client";

import { useMemo, useState, useSyncExternalStore } from "react";

import type { SocialHappeningResponse } from "@blast/core/web/contracts/happening.ts";

import { happeningStore, type HappeningSnapshot } from "./happening-store";

/**
 * Home's live data for one part of the page: the server's read while
 * hydrating (so the HTML matches), then the tab's shared store, which this
 * subscription keeps fresh (`happening-store.ts`).
 */
export function useHappening(initial: SocialHappeningResponse | null): HappeningSnapshot {
  const store = happeningStore();
  useState(() => {
    if (typeof window !== "undefined") store.seed(initial);
    return null;
  });
  const server = useMemo<HappeningSnapshot>(() => ({ read: initial, tape: initial?.tape ?? [], arrived: new Set(), leaving: null }), [initial]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, () => server);
}

export { useReducedMotion } from "#web/components/blast-ui/use-shell-prefs.ts";
