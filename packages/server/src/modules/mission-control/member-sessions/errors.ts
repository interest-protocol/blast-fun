import { publicJson } from "@blast/core/lib/http-errors.ts";
import { WebSecurityError, webSecurityErrorResponse } from "@blast/core/lib/web-security/errors.ts";
import { UNAVAILABLE_RETRY_AFTER_SECONDS } from "@blast/core/modules/database/availability.ts";

export type MemberSessionErrorCode =
  | "SESSION_CONFIGURATION_INVALID"
  | "SESSION_INVALID"
  | "SESSION_UNAVAILABLE";

const MESSAGES: Readonly<Record<MemberSessionErrorCode, string>> = {
  SESSION_CONFIGURATION_INVALID: "Member sessions are not configured.",
  SESSION_INVALID: "The member session is invalid or expired.",
  SESSION_UNAVAILABLE: "Member sessions are temporarily unavailable.",
};

const STATUS: Readonly<Record<MemberSessionErrorCode, number>> = {
  SESSION_CONFIGURATION_INVALID: 503,
  SESSION_INVALID: 401,
  SESSION_UNAVAILABLE: 503,
};

export class MemberSessionError extends Error {
  readonly code: MemberSessionErrorCode;
  readonly status: number;

  constructor(code: MemberSessionErrorCode) {
    super(MESSAGES[code]);
    this.name = "MemberSessionError";
    this.code = code;
    this.status = STATUS[code];
  }
}

export function memberSessionErrorResponse(error: unknown): Response {
  if (error instanceof WebSecurityError) return webSecurityErrorResponse(error);
  const safe =
    error instanceof MemberSessionError
      ? error
      : new MemberSessionError("SESSION_UNAVAILABLE");
  return publicJson(
    { error: { code: safe.code, message: safe.message } },
    {
      status: safe.status,
      headers: {
        "Cache-Control": "no-store",
        ...(safe.code === "SESSION_UNAVAILABLE"
          ? { "Retry-After": String(UNAVAILABLE_RETRY_AFTER_SECONDS) }
          : {}),
      },
    },
    error,
  );
}
