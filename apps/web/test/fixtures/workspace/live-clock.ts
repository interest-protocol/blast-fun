import type { WorkspaceLiveClock } from "../../../src/components/social/blast-mode/workspace/live-read";

export function handClock(start = 100_000) {
  let now = start;
  let sequence = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: WorkspaceLiveClock = {
    now: () => now,
    after(run, ms) {
      const id = ++sequence;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clear: (id) => { timers.delete(id as number); },
  };
  return {
    clock,
    timers,
    advance(ms: number) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.run();
      }
    },
  };
}
