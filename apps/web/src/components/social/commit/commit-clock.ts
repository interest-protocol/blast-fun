"use client";

import { useSyncExternalStore } from "react";
import { createStore } from "zustand/vanilla";

/**
 * A 1 Hz clock for countdowns ("closes in 6h 12m") and for the "has this sale
 * closed while the form was open" check.
 *
 * It is an external store rather than a `useState` and an effect, because a
 * clock *is* an external system: reading it during a render is impure and
 * seeding it from an effect cascades a render. One interval serves every
 * subscriber. It runs only while something reads it in a visible tab, and a
 * return to the tab ticks at once.
 *
 * Every tick redraws each reader, so read it in the smallest part that shows
 * the time, and only while that part needs it.
 *
 * `getServerSnapshot` answers 0, so the server's markup and the first client
 * render agree; every reader treats 0 as "not read yet" rather than as the
 * epoch, which is why the countdown only appears after hydration.
 *
 * The value is a zustand store (OA-28 M6).
 */

const clock = createStore<Readonly<{ now: number }>>()(() => ({ now: 0 }));
let timer: ReturnType<typeof setInterval> | null = null;
let readers = 0;

function tick() {
  clock.setState({ now: Date.now() });
}

function stop() {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

/** No interval in a hidden tab; the right time at once on the way back. */
function followVisibility() {
  if (document.visibilityState === "hidden") stop();
  else if (timer === null) {
    tick();
    timer = setInterval(tick, 1_000);
  }
}

function subscribe(listener: () => void): () => void {
  if (readers === 0) {
    document.addEventListener("visibilitychange", followVisibility);
    // Before this reader is added: React checks a new reader's time itself.
    followVisibility();
  }
  const off = clock.subscribe(listener);
  readers += 1;
  let subscribed = true;
  return () => {
    if (!subscribed) return;
    subscribed = false;
    off();
    readers -= 1;
    if (readers === 0) {
      document.removeEventListener("visibilitychange", followVisibility);
      stop();
    }
  };
}

/** Cached, so every reader in one render pass sees the same millisecond. */
function snapshot(): number {
  // With no reader the clock is stopped, so its time may be long gone. There is
  // nobody to tell, and at most one refresh a second keeps a render pass stable.
  if (readers === 0 && Date.now() - clock.getState().now >= 1_000) clock.setState({ now: Date.now() });
  return clock.getState().now;
}

const unread = () => 0;
const noClock = () => () => {};

/** Now, to the second; 0 until the browser has hydrated, and while `running` is false. */
export function useCommitClock(running = true): number {
  return useSyncExternalStore(running ? subscribe : noClock, running ? snapshot : unread, unread);
}
