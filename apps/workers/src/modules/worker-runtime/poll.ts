import { addAbortListener } from "node:events";

import * as Effect from "effect/Effect";

/**
 * Runs `pass` until `signal` aborts, waiting the milliseconds each pass returns before the next.
 * An abort ends the wait at once; the pass in progress always finishes.
 */
export function pollUntilAborted(signal: AbortSignal, pass: () => Promise<number>): Promise<void> {
  const stopping = Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void);
      return;
    }
    const listener = addAbortListener(signal, () => resume(Effect.void));
    return Effect.sync(() => listener[Symbol.dispose]());
  });

  return Effect.runPromise(Effect.gen(function* () {
    while (!signal.aborted) {
      const waitMs = yield* Effect.promise(pass);
      // Interrupt the timer, leaving the pass and its cleanup outside the race.
      yield* Effect.raceFirst(Effect.sleep(waitMs), stopping);
    }
  }));
}
