/**
 * A card image answers 503 with Retry-After: 5 while the instance is busy
 * drawing other cards (see card-images). An <img> cannot read the status, so
 * every load error is retried a few times, spaced past the advertised wait,
 * before the page shows its fallback.
 */
export const CARD_IMAGE_RETRIES = 3;
const CARD_IMAGE_RETRY_STEP_MS = 5_000;
const CARD_IMAGE_RETRY_JITTER_MS = 1_000;

/** Delay before retry number `failures` (1-based), or null once retries are spent. */
export function cardImageRetryDelayMs(failures: number, random: () => number = Math.random): number | null {
  if (!Number.isSafeInteger(failures) || failures < 1 || failures > CARD_IMAGE_RETRIES) return null;
  return CARD_IMAGE_RETRY_STEP_MS * failures + Math.floor(random() * CARD_IMAGE_RETRY_JITTER_MS);
}

/** The image URL for a given retry, so the browser fetches again instead of reusing the failed load. */
export function cardImageRetrySrc(src: string, attempt: number): string {
  return attempt > 0 ? `${src}${src.includes("?") ? "&" : "?"}retry=${attempt}` : src;
}
