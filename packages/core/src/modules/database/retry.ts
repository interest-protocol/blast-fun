import { z } from "zod";

/**
 * PostgreSQL rolled these transactions back before reporting them, so running
 * the whole transaction again is safe: 40001 serialization_failure,
 * 40P01 deadlock_detected, 55P03 lock_not_available (lock_timeout, retried
 * at most once).
 * Connection errors are not retried because a lost COMMIT has an unknown outcome.
 */
const TRANSIENT_SQLSTATES = new Set(["40001", "40P01", "55P03"]);

/** Query builders wrap pg errors; keep their original retry and outage semantics. */
export function databaseErrorCause(error: unknown): unknown {
  const seen = new Set<Error>();
  while (error instanceof Error && error.cause instanceof Error && !seen.has(error)) {
    seen.add(error);
    error = error.cause;
  }
  return error;
}

export interface RetryPolicy {
  readonly attempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

export const DEFAULT_TRANSACTION_RETRY: RetryPolicy = Object.freeze({
  attempts: 4,
  baseDelayMs: 20,
  maxDelayMs: 400,
});

export function isTransientDatabaseError(error: unknown): boolean {
  const code = (databaseErrorCause(error) as { code?: unknown } | null)?.code;
  return typeof code === "string" && TRANSIENT_SQLSTATES.has(code);
}

/** "Full jitter": a uniform delay up to the capped exponential backoff. */
export function retryDelayMs(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

const retryPolicySchema = z.object({
  attempts: z.number().int().min(1).max(10), baseDelayMs: z.number().int().nonnegative(),
  maxDelayMs: z.number().int().max(10_000),
}).refine((policy) => policy.maxDelayMs >= policy.baseDelayMs);

export function validateRetryPolicy(policy: RetryPolicy): RetryPolicy {
  const parsed = retryPolicySchema.safeParse(policy);
  if (!parsed.success) throw new TypeError("Transaction retry policy is outside its bounds.");
  return policy;
}

export async function retryTransient<Result>(
  operation: (attempt: number) => Promise<Result>,
  policy: RetryPolicy,
  hooks: Readonly<{
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
    random?: () => number;
    sleep?: (delayMs: number) => Promise<void>;
  }> = {},
): Promise<Result> {
  validateRetryPolicy(policy);
  const sleep =
    hooks.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt >= policy.attempts || !isTransientDatabaseError(error)) throw error;
      // A lock timeout means someone holds the lock for seconds. One retry
      // covers a brief holder; more would stack lock waits and hold the
      // request open instead of shedding load.
      if ((databaseErrorCause(error) as { code?: unknown }).code === "55P03" && attempt >= 2) throw error;
      const delayMs = retryDelayMs(attempt, policy, hooks.random);
      hooks.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }
}
