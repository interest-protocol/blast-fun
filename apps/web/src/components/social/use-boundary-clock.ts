"use client";

import { useEffect, useState } from "react";

/** `setTimeout` holds at most 2³¹ − 1 ms (about 24.8 days); a later time waits again from there. */
const LONGEST_TIMEOUT_MS = 2_147_483_647;

/**
 * The clock for a decision that turns at `atMs`, such as a sale's scheduled
 * start (#588): the caller's `nowMs` until the browser's clock passes `atMs`
 * while the page is open, then the moment it did. One timeout to that
 * moment, cleared on unmount; none once the clock has reached `atMs` or
 * without a time. Nothing ticks in between, so a memo keyed on it reruns
 * once, at `atMs`. From then on the clock is the browser's own, which may
 * run ahead of a server-aligned `nowMs`; whatever it opens is judged again
 * when acted on (a Blast's quote and the server refuse an early commit).
 *
 * A decision that turns again and again (a vesting schedule's releases)
 * passes `atMs` as a function of the clock: each turn names the next one.
 */
export function useBoundaryClock(next: number | null | undefined | ((clockMs: number) => number | null | undefined), nowMs: number): number {
  const [passedMs, setPassedMs] = useState<number | null>(null);
  const clock = passedMs !== null && passedMs > nowMs ? passedMs : nowMs;
  const atMs = typeof next === "function" ? next(clock) : next;
  useEffect(() => {
    if (atMs === null || atMs === undefined || atMs <= clock) return;
    const delay = () => Math.min(Math.max(0, atMs - Date.now()), LONGEST_TIMEOUT_MS);
    // A timer that fires early, or a wait longer than one timeout allows, waits again.
    const wake = () => {
      if (Date.now() < atMs) timer = setTimeout(wake, delay());
      else setPassedMs(Date.now());
    };
    let timer = setTimeout(wake, delay());
    return () => clearTimeout(timer);
  }, [atMs, clock]);
  return clock;
}
