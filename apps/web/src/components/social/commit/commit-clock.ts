"use client";

import { useSyncExternalStore } from "react";
import { createStore } from "zustand/vanilla";

/**
 * A 1 Hz clock for the dialogs' countdown ("closes in 6h 12m") and for the
 * "has this sale closed while the dialog was open" check.
 *
 * It is an external store rather than a `useState` and an effect, because a
 * clock *is* an external system: reading it during a render is impure and
 * seeding it from an effect cascades a render. One interval serves every
 * subscriber and stops when the last one leaves, so nothing ticks while no
 * dialog is open.
 *
 * `getServerSnapshot` answers 0, so the server's markup and the first client
 * render agree; every reader treats 0 as "not read yet" rather than as the
 * epoch, which is why the countdown only appears after hydration.
 *
 * The value is a zustand store (OA-28 M6). It is set before the first reader
 * is added, so starting the clock tells nobody; it is never 0 again after.
 */

const clock = createStore<Readonly<{ now: number }>>()(() => ({ now: 0 }));
let timer: ReturnType<typeof setInterval> | null = null;
let readers = 0;

function tick() {
  clock.setState({ now: Date.now() });
}

function subscribe(listener: () => void): () => void {
  if (timer === null) {
    clock.setState({ now: Date.now() });
    timer = setInterval(tick, 1_000);
  }
  const off = clock.subscribe(listener);
  readers += 1;
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    off();
    readers -= 1;
    if (readers === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Cached, so every reader in one render pass sees the same millisecond. */
function snapshot(): number {
  // Only before anything subscribed (nobody to tell): the first read sets it.
  if (clock.getState().now === 0) clock.setState({ now: Date.now() });
  return clock.getState().now;
}

const serverSnapshot = () => 0;

/** Now, to the second; 0 until the browser has hydrated. */
export function useCommitClock(): number {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}

