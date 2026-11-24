/**
 * A per-instance concurrency limit. Fluid compute runs many requests in one
 * instance, so a module-level semaphore bounds how many provider calls that
 * instance makes at once. Waiters are served in arrival order and give up
 * after `timeoutMs`, so a saturated provider sheds load instead of queueing
 * requests without bound.
 */
export class SemaphoreTimeoutError extends Error {
  constructor() {
    super("Timed out waiting for a concurrency slot.");
    this.name = "SemaphoreTimeoutError";
  }
}

export type Release = () => void;

export interface Semaphore {
  readonly limit: number;
  readonly active: number;
  readonly waiting: number;
  acquire(timeoutMs: number): Promise<Release>;
}

interface Waiter {
  grant(release: Release): void;
}

export function createSemaphore(limit: number): Semaphore {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("Semaphore limit must be a positive integer.");
  }
  let active = 0;
  const queue: Waiter[] = [];

  function releaser(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = queue.shift();
      if (next) next.grant(releaser());
      else active -= 1;
    };
  }

  return {
    limit,
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
    acquire(timeoutMs) {
      if (active < limit) {
        active += 1;
        return Promise.resolve(releaser());
      }
      if (timeoutMs <= 0) return Promise.reject(new SemaphoreTimeoutError());
      return new Promise<Release>((resolve, reject) => {
        const waiter: Waiter = {
          grant(release) {
            clearTimeout(timer);
            resolve(release);
          },
        };
        const timer = setTimeout(() => {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          reject(new SemaphoreTimeoutError());
        }, timeoutMs);
        queue.push(waiter);
      });
    },
  };
}

/** Parses a bounded positive integer setting, falling back when unset. */
export function concurrencyFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
  fallback: number,
  maximum: number,
): number {
  const value = environment[name]?.trim();
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new Error(`${name} must be an integer from 1 to ${maximum}.`);
  }
  return parsed;
}

/**
 * Milliseconds a provider asked us to wait, from `Retry-After` (delta seconds
 * or an HTTP date) or X's `x-rate-limit-reset` (epoch seconds). Undefined when
 * no usable hint is present. Never negative.
 */
export function retryAfterMs(headers: Headers, nowMs: number): number | undefined {
  const retryAfter = headers.get("retry-after")?.trim();
  if (retryAfter) {
    if (/^\d{1,10}$/.test(retryAfter)) return Number(retryAfter) * 1_000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  }
  const reset = headers.get("x-rate-limit-reset")?.trim();
  if (reset && /^\d{1,12}$/.test(reset)) {
    return Math.max(0, Number(reset) * 1_000 - nowMs);
  }
  return undefined;
}
