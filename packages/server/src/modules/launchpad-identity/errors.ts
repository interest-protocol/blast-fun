import { publicJson } from "@blast/core/lib/http-errors.ts";
import { WebSecurityError } from "@blast/core/lib/web-security/errors.ts";
import {
  UNAVAILABLE_RETRY_AFTER_SECONDS,
  isDatabaseUnavailableError,
} from "@blast/core/modules/database/availability.ts";

export type LaunchpadMutationErrorCode =
  | "LAUNCHPAD_METHOD_NOT_ALLOWED"
  | "LAUNCHPAD_CONTENT_TYPE_INVALID"
  | "LAUNCHPAD_PAYLOAD_TOO_LARGE"
  | "LAUNCHPAD_REQUEST_INVALID"
  | "LAUNCHPAD_STANCE_REQUIRED"
  | "LAUNCHPAD_AUTH_REQUIRED"
  | "LAUNCHPAD_AUTH_INVALID"
  | "LAUNCHPAD_FORBIDDEN"
  | "LAUNCHPAD_NOT_FOUND"
  | "LAUNCHPAD_CONFLICT"
  | "LAUNCHPAD_RATE_LIMITED"
  | "LAUNCHPAD_AUTH_UNAVAILABLE"
  | "LAUNCHPAD_UNAVAILABLE";

const PUBLIC: Readonly<Record<LaunchpadMutationErrorCode, readonly [number, string]>> = {
  LAUNCHPAD_METHOD_NOT_ALLOWED: [405, "This method is not allowed."],
  LAUNCHPAD_CONTENT_TYPE_INVALID: [415, "Send the request as application/json."],
  LAUNCHPAD_PAYLOAD_TOO_LARGE: [413, "The request is too large."],
  LAUNCHPAD_REQUEST_INVALID: [400, "The request is invalid."],
  LAUNCHPAD_STANCE_REQUIRED: [400, "A community thesis needs a stance: bullish, bearish or neutral."],
  LAUNCHPAD_AUTH_REQUIRED: [401, "Sign in or prove wallet control to continue."],
  LAUNCHPAD_AUTH_INVALID: [401, "Your sign-in or wallet proof could not be verified."],
  LAUNCHPAD_FORBIDDEN: [403, "You cannot make this change."],
  LAUNCHPAD_NOT_FOUND: [404, "This launch or record is not available."],
  LAUNCHPAD_CONFLICT: [409, "This changed since it was loaded. Reload and try again."],
  LAUNCHPAD_RATE_LIMITED: [429, "Too many requests. Try again later."],
  LAUNCHPAD_AUTH_UNAVAILABLE: [503, "Verification is temporarily unavailable."],
  LAUNCHPAD_UNAVAILABLE: [503, "This action is temporarily unavailable."],
};

/** A refusal with a fixed public code and message; it never carries input. */
export class LaunchpadMutationError extends Error {
  readonly code: LaunchpadMutationErrorCode;
  readonly status: number;
  readonly retryAfterSeconds?: number;

  constructor(code: LaunchpadMutationErrorCode, retryAfterSeconds?: number) {
    super(PUBLIC[code][1]);
    this.name = "LaunchpadMutationError";
    this.code = code;
    this.status = PUBLIC[code][0];
    if (typeof retryAfterSeconds === "number" && Number.isSafeInteger(retryAfterSeconds) && retryAfterSeconds > 0) {
      this.retryAfterSeconds = retryAfterSeconds;
    } else if (this.status === 503) {
      this.retryAfterSeconds = UNAVAILABLE_RETRY_AFTER_SECONDS;
    }
  }
}

export function invalidRequest(): LaunchpadMutationError {
  return new LaunchpadMutationError("LAUNCHPAD_REQUEST_INVALID");
}

export type PublicLaunchpadError = Readonly<{
  code: string;
  message: string;
  status: number;
  retryAfterSeconds?: number;
}>;

/**
 * The only error shapes that reach a client: a launchpad refusal, the shared
 * origin/CSRF refusal, 503 for an unavailable database, and otherwise a
 * generic 500. Messages are fixed text; causes stay server-side.
 */
export function publicLaunchpadError(error: unknown): PublicLaunchpadError {
  if (error instanceof LaunchpadMutationError) {
    return {
      code: error.code,
      message: error.message,
      status: error.status,
      ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
    };
  }
  if (error instanceof WebSecurityError) {
    return { code: error.code, message: error.message, status: error.status };
  }
  if (isDatabaseUnavailableError(error)) {
    return publicLaunchpadError(new LaunchpadMutationError("LAUNCHPAD_UNAVAILABLE"));
  }
  return { code: "LAUNCHPAD_INTERNAL_ERROR", message: "The request could not be completed.", status: 500 };
}

export function launchpadJson(
  requestId: string,
  body: Record<string, unknown>,
  status: number,
  headers: Record<string, string> = {},
): Response {
  return publicJson(
    { requestId, ...body },
    {
      status,
      headers: { "Cache-Control": "no-store", "X-Request-ID": requestId, ...headers },
    },
  );
}

export function launchpadErrorResponse(
  requestId: string,
  error: PublicLaunchpadError,
  headers: Record<string, string> = {},
): Response {
  return launchpadJson(
    requestId,
    {
      error: {
        code: error.code,
        message: error.message,
        ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
      },
    },
    error.status,
    {
      ...(error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : {}),
      ...(error.status === 405 ? { Allow: "POST" } : {}),
      ...headers,
    },
  );
}
