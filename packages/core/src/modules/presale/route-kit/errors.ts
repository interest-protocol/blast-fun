import { errorLabel } from "@blast/core/lib/metrics.ts";
import { PrivyAdapterError } from "@blast/core/lib/privy-adapter/errors.ts";
import {
  UNAVAILABLE_RETRY_AFTER_SECONDS,
  isDatabaseUnavailableError,
} from "@blast/core/modules/database/availability.ts";
import { PRESALE_ERROR_MESSAGES, PRESALE_ERRORS, type PresaleErrorBodies, type PresaleErrorCode } from "../contracts/errors.ts";

/** `Retry-After` of `identity_unavailable` (a Privy outage on a cache miss). */
const IDENTITY_RETRY_AFTER_SECONDS = 5;
const DAY_MS = 86_400_000;

/** Distributes over a union body, so each branch keeps its own fields (`dry_run_failed`'s `move_abort` or `reason`). */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type ErrorExtra<Code extends PresaleErrorCode> = DistributiveOmit<PresaleErrorBodies[Code]["error"], "code" | "message">;
type HasExtra<Code extends PresaleErrorCode> = keyof ErrorExtra<Code> extends never ? false : true;

type GeneralErrorOptions<Code extends PresaleErrorCode> = (HasExtra<Code> extends true
  ? { extra: ErrorExtra<Code> }
  : { extra?: never }) & {
  /** Overrides the default `Retry-After`; ignored for a code that has none (CL-23). */
  retryAfterSeconds?: number;
  now?: Date;
};

/**
 * `budget_exceeded` options by `reason` (CL-25, Q-018): `daily_limit` may
 * default to the next UTC day (counted from `now`); `open_reservations` must
 * name its `Retry-After`, because only the emitter knows when a slot frees.
 */
type BudgetExceededOptions =
  | { extra: { reason: "daily_limit" }; retryAfterSeconds?: number; now?: Date }
  | { extra: { reason: "open_reservations" }; retryAfterSeconds: number; now?: never };

export type PresaleRouteErrorOptions<Code extends PresaleErrorCode> = Code extends "budget_exceeded"
  ? BudgetExceededOptions
  : GeneralErrorOptions<Code>;

/**
 * The `Retry-After` a code carries when its emitter passes none. For
 * `budget_exceeded` it follows `reason` (CL-25): `daily_limit` runs to the next
 * UTC day; `open_reservations` has no default, because only its emitter knows
 * when the earliest open reservation expires.
 */
function defaultRetryAfter(code: PresaleErrorCode, extra: Readonly<Record<string, unknown>>, now: Date): number {
  if (code === "budget_exceeded") {
    if (extra.reason !== "daily_limit") throw new TypeError(`budget_exceeded ${String(extra.reason)} needs an explicit Retry-After.`);
    return Math.max(1, Math.ceil((DAY_MS - (now.getTime() % DAY_MS)) / 1_000));
  }
  if (code === "identity_unavailable") return IDENTITY_RETRY_AFTER_SECONDS;
  return UNAVAILABLE_RETRY_AFTER_SECONDS;
}

/**
 * A presale refusal with one published code (contracts `PRESALE_ERRORS`), its
 * fixed status and message, any route-specific fields that go inside `error`
 * (CL-10), and its `Retry-After` seconds when the code carries one (CL-23).
 */
export class PresaleRouteError<Code extends PresaleErrorCode = PresaleErrorCode> extends Error {
  readonly code: Code;
  readonly status: number;
  readonly extra: Readonly<Record<string, unknown>>;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: Code,
    ...[options]: HasExtra<Code> extends true
      ? [options: PresaleRouteErrorOptions<Code>]
      : [options?: PresaleRouteErrorOptions<Code>]
  ) {
    super(PRESALE_ERROR_MESSAGES[code]);
    this.name = "PresaleRouteError";
    this.code = code;
    this.status = PRESALE_ERRORS[code].status;
    this.extra = Object.freeze({ ...(options?.extra ?? {}) });
    const requested = options?.retryAfterSeconds;
    this.retryAfterSeconds = PRESALE_ERRORS[code].retryAfter
      ? typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0
        ? requested
        : defaultRetryAfter(code, this.extra, options?.now ?? new Date())
      : null;
  }

  /** The published body: `{ error: { code, message, ...extra } }`, nothing else. */
  body(): PresaleErrorBodies[Code] {
    return { error: { ...this.extra, code: this.code, message: this.message } } as PresaleErrorBodies[Code];
  }
}

/**
 * Maps any failure to a published code, so a route never answers outside the
 * contract: a presale refusal stays itself; an invalid or expired Privy token
 * is `unauthorized`; a Privy outage is `identity_unavailable`; database
 * backpressure and everything else (configuration, programming errors) is
 * `service_unavailable`. The cause never reaches the body.
 */
export function toPresaleRouteError(error: unknown): PresaleRouteError {
  if (error instanceof PresaleRouteError) return error;
  if (error instanceof PrivyAdapterError) {
    if (error.code === "INVALID_ACCESS_TOKEN" || error.code === "ACCESS_TOKEN_EXPIRED") {
      return new PresaleRouteError("unauthorized");
    }
    if (error.code !== "INVALID_CONFIGURATION") return new PresaleRouteError("identity_unavailable");
  }
  return new PresaleRouteError("service_unavailable");
}

/** A value-free label for metrics: the code, or the cause's class or SQLSTATE for a 503. */
export function presaleErrorCause(error: unknown): string {
  if (error instanceof PresaleRouteError) return error.code;
  return isDatabaseUnavailableError(error) ? `database:${errorLabel(error)}` : errorLabel(error);
}
