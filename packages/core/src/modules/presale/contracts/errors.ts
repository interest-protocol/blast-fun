import type { PresaleAbortName } from "@interest-protocol/blast-sdk/presale";

import type { Count, TransactionDigest } from "./wire.ts";

/**
 * Every error code a presale route can return, with its fixed HTTP status.
 * `retryAfter` marks the codes sent with a `Retry-After` header (CL-23): every
 * 503, `rate_limited`, and `budget_exceeded` (until its budget frees up, CL-25). The
 * header is the only carrier: bodies are `{ error: { code, message } }` with no
 * `retryAfterSeconds`, and route-specific fields sit inside `error` (CL-10). A
 * client treats an unknown code with its generic failure copy.
 */
export const PRESALE_ERRORS = {
  // blast-infra `/v1`
  invalid_parameter: { status: 400, retryAfter: false },
  not_found: { status: 404, retryAfter: false },
  not_ready: { status: 503, retryAfter: true },
  // web routes
  unauthorized: { status: 401, retryAfter: false },
  not_embedded_wallet: { status: 403, retryAfter: false },
  target_not_allowed: { status: 403, retryAfter: false },
  dry_run_failed: { status: 400, retryAfter: false },
  budget_exceeded: { status: 429, retryAfter: true },
  pool_unavailable: { status: 503, retryAfter: true },
  identity_unavailable: { status: 503, retryAfter: true },
  deployment_unavailable: { status: 503, retryAfter: true },
  deployment_mismatch: { status: 503, retryAfter: true },
  invalid_signature: { status: 400, retryAfter: false },
  reservation_expired: { status: 410, retryAfter: false },
  execution_unconfirmed: { status: 504, retryAfter: false },
  invalid_allowlist: { status: 422, retryAfter: false },
  allowlist_too_large: { status: 413, retryAfter: false },
  root_mismatch: { status: 409, retryAfter: false },
  not_eligible: { status: 404, retryAfter: false },
  allowlist_unknown: { status: 404, retryAfter: false },
  bridge_unavailable: { status: 503, retryAfter: true },
  invalid_settings: { status: 400, retryAfter: false },
  no_visitor: { status: 422, retryAfter: false },
  // the shared route kit, on every presale web route
  rate_limited: { status: 429, retryAfter: true },
  origin_invalid: { status: 403, retryAfter: false },
  invalid_request: { status: 400, retryAfter: false },
  body_too_large: { status: 413, retryAfter: false },
  service_unavailable: { status: 503, retryAfter: true },
} as const satisfies Record<string, { status: number; retryAfter: boolean }>;

export type PresaleErrorCode = keyof typeof PRESALE_ERRORS;

type ErrorBody<Code extends PresaleErrorCode, Extra extends object = Record<never, never>> = {
  error: { code: Code; message: string } & Extra;
};

export type InvalidParameterError = ErrorBody<"invalid_parameter">;
export type NotFoundError = ErrorBody<"not_found">;
export type NotReadyError = ErrorBody<"not_ready">;
export type UnauthorizedError = ErrorBody<"unauthorized">;
export type NotEmbeddedWalletError = ErrorBody<"not_embedded_wallet">;
export type TargetNotAllowedError = ErrorBody<"target_not_allowed">;
/**
 * A failed dry run names its presale-package abort with the SDK map. Otherwise
 * `move_abort` is `null` with a reason: `gas_cap_exceeded` when the simulation
 * succeeded above the cap, `external_abort` when it aborted in a module outside
 * the presale package, such as an allowed Cetus swap target (CL-19).
 */
export type DryRunFailedError = ErrorBody<
  "dry_run_failed",
  { move_abort: PresaleAbortName } | { move_abort: null; reason: "gas_cap_exceeded" | "external_abort" }
>;
/**
 * Which sponsor budget is used up (CL-25): `daily_limit` (`Retry-After` runs to
 * the next UTC day) or `open_reservations` (it runs to the earliest open
 * reservation's expiry). Clients choose their copy from `reason`.
 */
export type BudgetExceededError = ErrorBody<"budget_exceeded", { reason: "daily_limit" | "open_reservations" }>;
export type PoolUnavailableError = ErrorBody<"pool_unavailable">;
export type IdentityUnavailableError = ErrorBody<"identity_unavailable">;
export type DeploymentUnavailableError = ErrorBody<"deployment_unavailable">;
export type DeploymentMismatchError = ErrorBody<"deployment_mismatch">;
export type InvalidSignatureError = ErrorBody<"invalid_signature">;
export type ReservationExpiredError = ErrorBody<"reservation_expired">;
/** The backend cannot confirm whether the submitted transaction `digest` executed. */
export type ExecutionUnconfirmedError = ErrorBody<"execution_unconfirmed", { digest: TransactionDigest }>;
/** Up to 100 rejected rows; `row` is the 1-based data row number. */
export type InvalidAllowlistError = ErrorBody<"invalid_allowlist", { rows: { row: Count; reason: string }[] }>;
export type AllowlistTooLargeError = ErrorBody<"allowlist_too_large">;
export type RootMismatchError = ErrorBody<"root_mismatch">;
export type NotEligibleError = ErrorBody<"not_eligible">;
export type AllowlistUnknownError = ErrorBody<"allowlist_unknown">;
export type BridgeUnavailableError = ErrorBody<"bridge_unavailable">;
export type InvalidSettingsError = ErrorBody<"invalid_settings">;
export type NoVisitorError = ErrorBody<"no_visitor">;
export type RateLimitedError = ErrorBody<"rate_limited">;
export type OriginInvalidError = ErrorBody<"origin_invalid">;
export type InvalidRequestError = ErrorBody<"invalid_request">;
export type BodyTooLargeError = ErrorBody<"body_too_large">;
export type ServiceUnavailableError = ErrorBody<"service_unavailable">;

/** Every code has a body of its own code. */
type EveryCode<Bodies extends { [Code in PresaleErrorCode]: ErrorBody<Code, object> }> = Bodies;

/** The one body type of each code. */
export type PresaleErrorBodies = EveryCode<{
  invalid_parameter: InvalidParameterError;
  not_found: NotFoundError;
  not_ready: NotReadyError;
  unauthorized: UnauthorizedError;
  not_embedded_wallet: NotEmbeddedWalletError;
  target_not_allowed: TargetNotAllowedError;
  dry_run_failed: DryRunFailedError;
  budget_exceeded: BudgetExceededError;
  pool_unavailable: PoolUnavailableError;
  identity_unavailable: IdentityUnavailableError;
  deployment_unavailable: DeploymentUnavailableError;
  deployment_mismatch: DeploymentMismatchError;
  invalid_signature: InvalidSignatureError;
  reservation_expired: ReservationExpiredError;
  execution_unconfirmed: ExecutionUnconfirmedError;
  invalid_allowlist: InvalidAllowlistError;
  allowlist_too_large: AllowlistTooLargeError;
  root_mismatch: RootMismatchError;
  not_eligible: NotEligibleError;
  allowlist_unknown: AllowlistUnknownError;
  bridge_unavailable: BridgeUnavailableError;
  invalid_settings: InvalidSettingsError;
  no_visitor: NoVisitorError;
  rate_limited: RateLimitedError;
  origin_invalid: OriginInvalidError;
  invalid_request: InvalidRequestError;
  body_too_large: BodyTooLargeError;
  service_unavailable: ServiceUnavailableError;
}>;

/** blast-infra's `/v1` codes, on every presale read route. */
export const INFRA_ERROR_CODES = ["invalid_parameter", "not_found", "not_ready"] as const;
/** The shared route kit's codes, on every presale web route. */
export const ROUTE_KIT_ERROR_CODES = [
  "rate_limited",
  "origin_invalid",
  "invalid_request",
  "body_too_large",
  "service_unavailable",
] as const;

/** Fixed safe public text, shared by server and browser error handling. */
export const PRESALE_ERROR_MESSAGES: Readonly<Record<PresaleErrorCode, string>> = {
  invalid_parameter: "A path or query parameter is invalid.",
  not_found: "Not found.",
  not_ready: "The data is not ready yet.",
  unauthorized: "Sign in to continue.",
  not_embedded_wallet: "This needs your Blast embedded wallet.",
  target_not_allowed: "This transaction calls a target that cannot be sponsored.",
  dry_run_failed: "The transaction would fail.",
  budget_exceeded: "A sponsored transaction budget is used up.",
  pool_unavailable: "Gas sponsorship is temporarily unavailable.",
  identity_unavailable: "Sign-in verification is temporarily unavailable.",
  deployment_unavailable: "The presale deployment is not available.",
  deployment_mismatch: "The presale deployment does not match the network.",
  invalid_signature: "The signature is invalid.",
  reservation_expired: "The sponsorship reservation expired.",
  execution_unconfirmed: "The transaction outcome could not be confirmed.",
  invalid_allowlist: "The allowlist is invalid.",
  allowlist_too_large: "The allowlist is too large.",
  root_mismatch: "The allowlist root does not match the presale.",
  not_eligible: "This wallet is not on the allowlist.",
  allowlist_unknown: "The presale's allowlist is not known.",
  bridge_unavailable: "The bridge is temporarily unavailable.",
  invalid_settings: "The settings are invalid.",
  no_visitor: "No visitor session was found.",
  rate_limited: "Too many requests. Try again later.",
  origin_invalid: "The request origin could not be verified.",
  invalid_request: "The request is invalid.",
  body_too_large: "The request is too large.",
  service_unavailable: "The service is temporarily unavailable.",
};
