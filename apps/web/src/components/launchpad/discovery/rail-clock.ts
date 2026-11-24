/**
 * Wall-clock time for aging the rail's facts, ticking every 5 s while a rail
 * is mounted. The server render and hydration read 0 ("not running"), so no
 * time-dependent text differs between them.
 */
const TICK_MS = 5_000;
let now = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();

export function subscribeClock(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === undefined) {
    now = Date.now();
    timer = setInterval(() => {
      now = Date.now();
      listeners.forEach((notify) => notify());
    }, TICK_MS);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
}

export const clockNow = () => now;
export const serverClockNow = () => 0;
