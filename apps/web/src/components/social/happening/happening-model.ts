import type { HappeningTapeEvent } from "@blast/core/web/contracts/happening.ts";

/** Home's live tape as plain values (FEATURE-MAP §17). Pure. */

/** The tape shows four rows; the rest of the read waits to slide in. */
export const TAPE_ROWS = 4;

/** Events of `next` that `shown` does not have yet, oldest first: the order they slide in. */
export function arrivals(shown: readonly HappeningTapeEvent[], next: readonly HappeningTapeEvent[]): HappeningTapeEvent[] {
  const known = new Set(shown.map((event) => event.activity_id));
  const newest = shown[0]?.occurred_at_ms ?? Number.NEGATIVE_INFINITY;
  return next.filter((event) => !known.has(event.activity_id) && event.occurred_at_ms >= newest).reverse();
}

/** How long apart queued events slide in: spread over the poll, between 1.2 s and 4 s apart. */
export function dripGapMs(queued: number, pollMs: number): number {
  return Math.min(4_000, Math.max(1_200, Math.floor(pollMs / Math.max(1, queued + 1))));
}
