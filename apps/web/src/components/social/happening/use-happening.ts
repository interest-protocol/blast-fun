"use client";

import { useMemo, useState, useSyncExternalStore } from "react";

import type { SocialHappeningResponse } from "@blast/core/web/contracts/happening.ts";

import { blastModeCovering, onUncover } from "../blast-mode/live/mode-cover";
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

const clockListeners = new Set<() => void>();
let clockHandle: number | null = null;
let clockUncover: (() => void) | null = null;

const tickClock = () => {
  for (const each of clockListeners) each();
};

/**
 * Home's 1 Hz clock. It pauses while Blast mode's lanes cover the page (R3-60:
 * the page's loops do not redraw under the mode) and catches up once when the
 * mode leaves.
 */
function subscribeClock(listener: () => void): () => void {
  clockListeners.add(listener);
  clockHandle ??= window.setInterval(() => {
    if (!blastModeCovering()) tickClock();
  }, 1_000);
  clockUncover ??= onUncover(tickClock);
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockHandle !== null) {
      window.clearInterval(clockHandle);
      clockHandle = null;
      clockUncover?.();
      clockUncover = null;
    }
  };
}

/**
 * The clock live values count from (tape ages, countdowns), to the second:
 * `serverNowMs` while hydrating (so the HTML matches), then the browser's
 * clock every second. A cached read carries no usable server time (it may be
 * 30 s old), so the device's clock is the reference.
 */
export function useSecondClock(serverNowMs: number): number {
  return useSyncExternalStore(
    subscribeClock,
    () => Math.floor(Date.now() / 1_000) * 1_000,
    () => serverNowMs,
  );
}

export { useReducedMotion } from "#web/components/blast-ui/use-shell-prefs.ts";
