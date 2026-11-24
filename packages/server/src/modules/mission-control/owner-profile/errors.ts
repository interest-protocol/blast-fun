import { publicJson } from "@blast/core/lib/http-errors.ts";
import { CARD_IMAGE_RETRY_AFTER_SECONDS } from "@blast/core/modules/mission-control/card-images/errors.ts";
import { UNAVAILABLE_RETRY_AFTER_SECONDS } from "@blast/core/modules/database/availability.ts";

export type OwnerProfileErrorCode =
  | "CARD_BUSY"
  | "CARD_UNAVAILABLE"
  | "CURSOR_INVALID"
  | "DISPLAY_NAME_INVALID"
  | "OWNER_NOT_FOUND"
  | "OWNER_UNAVAILABLE";

const STATUS: Record<OwnerProfileErrorCode, number> = {
  CARD_BUSY: 503,
  CARD_UNAVAILABLE: 503,
  CURSOR_INVALID: 400,
  DISPLAY_NAME_INVALID: 400,
  OWNER_NOT_FOUND: 404,
  OWNER_UNAVAILABLE: 503,
};

const MESSAGE: Record<OwnerProfileErrorCode, string> = {
  CARD_BUSY: "Cards are busy rendering. Please retry in a few seconds.",
  CARD_UNAVAILABLE: "The saved card could not be rendered. Please retry.",
  CURSOR_INVALID: "The recruit cursor is invalid.",
  DISPLAY_NAME_INVALID: "Display name must be 100 characters or fewer.",
  OWNER_NOT_FOUND: "Owner profile unavailable.",
  OWNER_UNAVAILABLE: "Owner profile temporarily unavailable.",
};

export class OwnerProfileError extends Error {
  readonly code: OwnerProfileErrorCode;
  readonly status: number;

  constructor(code: OwnerProfileErrorCode) {
    super(MESSAGE[code]);
    this.name = "OwnerProfileError";
    this.code = code;
    this.status = STATUS[code];
  }
}

export function ownerProfileErrorResponse(error: unknown): Response {
  const safe = error instanceof OwnerProfileError
    ? error
    : new OwnerProfileError("OWNER_UNAVAILABLE");
  return publicJson(
    { error: { code: safe.code, message: safe.message } },
    {
      status: safe.status,
      headers: {
        "Cache-Control": "no-store",
        ...(safe.code === "CARD_BUSY"
          ? { "Retry-After": String(CARD_IMAGE_RETRY_AFTER_SECONDS) }
          : safe.code === "OWNER_UNAVAILABLE"
            ? { "Retry-After": String(UNAVAILABLE_RETRY_AFTER_SECONDS) }
            : {}),
      },
    },
    error,
  );
}
