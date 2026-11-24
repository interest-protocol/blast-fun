import { publicJson } from "../http-errors.ts";
export type WebSecurityErrorCode =
  | "BOT_CHALLENGE_FAILED"
  | "BOT_CHALLENGE_REQUIRED"
  | "CSRF_INVALID"
  | "OAUTH_CONFIGURATION_INVALID"
  | "OAUTH_UNAVAILABLE"
  | "OAUTH_FAILED"
  | "OAUTH_STATE_INVALID"
  | "ORIGIN_INVALID"
  | "RATE_LIMITED";

const MESSAGES: Record<WebSecurityErrorCode, string> = {
  BOT_CHALLENGE_FAILED: "The security challenge could not be verified.",
  BOT_CHALLENGE_REQUIRED: "A security challenge is required.",
  CSRF_INVALID: "The request could not be verified.",
  OAUTH_CONFIGURATION_INVALID: "Authentication is not configured.",
  OAUTH_FAILED: "Authentication could not be completed.",
  OAUTH_UNAVAILABLE: "Authentication is temporarily unavailable. Please retry.",
  OAUTH_STATE_INVALID: "Authentication could not be verified.",
  ORIGIN_INVALID: "The request origin could not be verified.",
  RATE_LIMITED: "Too many requests.",
};

const STATUS: Record<WebSecurityErrorCode, number> = {
  BOT_CHALLENGE_FAILED: 403,
  BOT_CHALLENGE_REQUIRED: 403,
  CSRF_INVALID: 403,
  OAUTH_CONFIGURATION_INVALID: 503,
  OAUTH_FAILED: 400,
  OAUTH_UNAVAILABLE: 503,
  OAUTH_STATE_INVALID: 400,
  ORIGIN_INVALID: 403,
  RATE_LIMITED: 429,
};

export class WebSecurityError extends Error {
  readonly code: WebSecurityErrorCode;
  readonly status: number;

  constructor(code: WebSecurityErrorCode) {
    super(MESSAGES[code]);
    this.name = "WebSecurityError";
    this.code = code;
    this.status = STATUS[code];
  }
}

export function webSecurityErrorResponse(error: unknown): Response {
  const safe =
    error instanceof WebSecurityError
      ? error
      : new WebSecurityError("OAUTH_UNAVAILABLE");
  return publicJson(
    { error: { code: safe.code, message: safe.message } },
    {
      status: safe.status,
      headers: { "Cache-Control": "no-store" },
    },
    error,
  );
}
