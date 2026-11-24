export type PrivyAdapterErrorCode =
  | "ACCESS_TOKEN_EXPIRED"
  | "IDENTITY_NOT_FOUND"
  | "INVALID_ACCESS_TOKEN"
  | "INVALID_CONFIGURATION"
  | "PROVIDER_RESPONSE_INVALID"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_UNAVAILABLE"
  | "WALLET_RESOLUTION_FAILED";

const ERROR_MESSAGES: Readonly<Record<PrivyAdapterErrorCode, string>> = {
  ACCESS_TOKEN_EXPIRED: "Authentication has expired.",
  IDENTITY_NOT_FOUND: "Connect an X account to continue.",
  INVALID_ACCESS_TOKEN: "Authentication could not be verified.",
  INVALID_CONFIGURATION: "Authentication is not configured.",
  PROVIDER_RESPONSE_INVALID: "The identity provider returned an invalid response.",
  PROVIDER_TIMEOUT: "The identity provider timed out.",
  PROVIDER_UNAVAILABLE: "The identity provider is unavailable.",
  WALLET_RESOLUTION_FAILED: "The embedded Sui wallet could not be resolved.",
};

const RETRYABLE_CODES = new Set<PrivyAdapterErrorCode>([
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
]);

export class PrivyAdapterError extends Error {
  readonly code: PrivyAdapterErrorCode;
  readonly retryable: boolean;

  constructor(code: PrivyAdapterErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "PrivyAdapterError";
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
  }
}

export function toSafePrivyAdapterError(error: unknown): PrivyAdapterError {
  if (error instanceof PrivyAdapterError) {
    return error;
  }

  return new PrivyAdapterError("PROVIDER_UNAVAILABLE");
}
