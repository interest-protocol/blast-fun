import { errorLabel } from "@blast/core/lib/metrics.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { PrivyAdapterError } from "@blast/core/lib/privy-adapter/errors.ts";
import {
  UNAVAILABLE_RETRY_AFTER_SECONDS,
  isDatabaseUnavailableError,
} from "@blast/core/modules/database/availability.ts";
import { SOCIAL_ERROR_MESSAGES, SOCIAL_ERRORS, type SocialErrorBody, type SocialErrorCode } from "../contracts/errors.ts";

export type SocialRouteErrorOptions = Readonly<{
  /** Route-specific fields, sent inside `error` next to `code` and `message`. */
  extra?: Readonly<Record<string, unknown>>;
  /** Overrides the default `Retry-After`; ignored for a code that carries none. */
  retryAfterSeconds?: number;
}>;

/**
 * A social refusal with one published code (contracts `SOCIAL_ERRORS`), its
 * fixed status and message, any route-specific fields, and its `Retry-After`
 * seconds when the code carries one.
 */
class SocialRouteErrorDefinition<Code extends SocialErrorCode = SocialErrorCode> extends Error {
  readonly code: Code;
  readonly status: number;
  readonly extra: Readonly<Record<string, unknown>>;
  readonly retryAfterSeconds: number | null;

  constructor(code: Code, options: SocialRouteErrorOptions = {}) {
    super(SOCIAL_ERROR_MESSAGES[code]);
    this.name = "SocialRouteError";
    this.code = code;
    this.status = SOCIAL_ERRORS[code].status;
    this.extra = Object.freeze({ ...(options.extra ?? {}) });
    const requested = options.retryAfterSeconds;
    this.retryAfterSeconds = SOCIAL_ERRORS[code].retryAfter
      ? typeof requested === "number" && Number.isSafeInteger(requested) && requested > 0
        ? requested
        : UNAVAILABLE_RETRY_AFTER_SECONDS
      : null;
  }

  /** The published body: `{ error: { code, message, ...extra } }`, nothing else. */
  body(): SocialErrorBody<Code> {
    return { error: { ...this.extra, code: this.code, message: this.message } } as SocialErrorBody<Code>;
  }
}

// Next's server bundles share the kit, so they must share its error constructor too.
export const SocialRouteError = processSingleton("social.route-error", () => SocialRouteErrorDefinition);
export type SocialRouteError<Code extends SocialErrorCode = SocialErrorCode> = SocialRouteErrorDefinition<Code>;

/**
 * Maps any failure to a published code: a social refusal stays itself; an
 * invalid or expired Privy token is `unauthorized`; a Privy, database or
 * fullnode outage, and everything else (configuration, programming errors),
 * is `service_unavailable`. The cause never reaches the body.
 */
export function toSocialRouteError(error: unknown): SocialRouteError {
  if (error instanceof SocialRouteError) return error;
  if (
    error instanceof PrivyAdapterError &&
    (error.code === "INVALID_ACCESS_TOKEN" || error.code === "ACCESS_TOKEN_EXPIRED")
  ) {
    return new SocialRouteError("unauthorized");
  }
  return new SocialRouteError("service_unavailable");
}

/** A value-free label for metrics: the code, or the cause's class or SQLSTATE for a 503. */
export function socialErrorCause(error: unknown): string {
  if (error instanceof SocialRouteError) return error.code;
  return isDatabaseUnavailableError(error) ? `database:${errorLabel(error)}` : errorLabel(error);
}
