/** How long a shed request is told to wait (`Retry-After`, seconds). */
export const CARD_IMAGE_RETRY_AFTER_SECONDS = 5;

/**
 * This instance is rendering at its limit and cannot queue the render: the wait
 * queue is full, or the render waited too long for a slot. Routes answer 503
 * with `Retry-After` and never let a cache keep that answer.
 */
export class CardImageBusyError extends Error {
  readonly reason: "queue_full" | "wait_timeout";

  constructor(reason: "queue_full" | "wait_timeout") {
    super("Card rendering is at capacity; retry shortly.");
    this.name = "CardImageBusyError";
    this.reason = reason;
  }
}
