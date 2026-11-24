import {
  UNAVAILABLE_RETRY_AFTER_SECONDS,
  isDatabaseUnavailableError,
} from "@blast/core/modules/database/availability.ts";

export type WalletChallengeErrorCode =
  | "WALLET_CHALLENGE_REQUEST_INVALID"
  | "WALLET_CHALLENGE_RATE_LIMITED"
  | "WALLET_PROOF_INVALID"
  | "WALLET_PROOF_UNAVAILABLE";

const PUBLIC_MESSAGES: Record<WalletChallengeErrorCode, string> = {
  WALLET_CHALLENGE_REQUEST_INVALID: "The wallet challenge request is invalid.",
  WALLET_CHALLENGE_RATE_LIMITED: "Too many wallet verification attempts.",
  WALLET_PROOF_INVALID: "Wallet verification failed.",
  WALLET_PROOF_UNAVAILABLE: "Wallet verification is temporarily unavailable.",
};

const STATUS: Record<WalletChallengeErrorCode, number> = {
  WALLET_CHALLENGE_REQUEST_INVALID: 400,
  WALLET_CHALLENGE_RATE_LIMITED: 429,
  WALLET_PROOF_INVALID: 400,
  WALLET_PROOF_UNAVAILABLE: 503,
};

export class WalletChallengeError extends Error {
  readonly code: WalletChallengeErrorCode;
  readonly retryAfterSeconds?: number;
  readonly status: number;

  constructor(code: WalletChallengeErrorCode, retryAfterSeconds?: number) {
    super(PUBLIC_MESSAGES[code]);
    this.name = "WalletChallengeError";
    this.code = code;
    if (
      typeof retryAfterSeconds === "number" &&
      Number.isSafeInteger(retryAfterSeconds) &&
      retryAfterSeconds > 0
    ) {
      this.retryAfterSeconds = retryAfterSeconds;
    } else if (code === "WALLET_PROOF_UNAVAILABLE") {
      this.retryAfterSeconds = UNAVAILABLE_RETRY_AFTER_SECONDS;
    }
    this.status = STATUS[code];
  }
}

export interface WalletChallengeErrorResponse {
  status: number;
  body: {
    error: {
      code: WalletChallengeErrorCode | "INTERNAL_ERROR";
      message: string;
      retryAfterSeconds?: number;
    };
  };
}

/**
 * A database that is out of connections or timing out answers 503
 * WALLET_PROOF_UNAVAILABLE with Retry-After, like the other claim steps; any
 * other unexpected error stays a 500.
 */
export function toWalletChallengeErrorResponse(
  error: unknown,
): WalletChallengeErrorResponse {
  if (!(error instanceof WalletChallengeError) && isDatabaseUnavailableError(error)) {
    return toWalletChallengeErrorResponse(
      new WalletChallengeError("WALLET_PROOF_UNAVAILABLE"),
    );
  }
  if (error instanceof WalletChallengeError) {
    return {
      status: error.status,
      body: {
        error: {
          code: error.code,
          message: error.message,
          ...(error.retryAfterSeconds
            ? { retryAfterSeconds: error.retryAfterSeconds }
            : {}),
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: "Wallet verification could not be completed.",
      },
    },
  };
}
