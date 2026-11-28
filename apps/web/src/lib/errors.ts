import { LEGACY_ERROR_MESSAGES } from "@blast/core/lib/public-error-messages.ts";
import { SOCIAL_ERROR_MESSAGES } from "@blast/core/modules/social/contracts/errors.ts";
import { PRESALE_ERROR_MESSAGES } from "@blast/core/modules/presale/contracts/errors.ts";

export type ErrorDiagnostic = Readonly<{ code?: string | null; requestId?: string; httpStatus?: number | null; retryAfterSeconds?: number | null; reason?: unknown }>;

const LOCAL_MESSAGES: Readonly<Record<string, string>> = {
  account_switch_failed: "Could not switch accounts. Try again.",
  withdrawal_switch_blocked: "Finish your withdrawal before switching accounts.",
  wallet_missing: "Your Blast wallet isn’t ready yet.",
  "invalid-manifest": "The launch configuration is invalid. Contact support.",
  "environment-mismatch": "The launch configuration does not match this environment.",
  "fixture-identity-in-production": "The launch configuration could not be verified.",
  "unreleased-deployment": "This launch deployment is not available yet.",
  "abi-mismatch": "The launch contract version does not match the app. Refresh and retry.",
  "sdk-unreleased": "The launch integration is not available yet.",
  "sdk-mismatch": "The launch integration version does not match the contract.",
  "missing-evidence": "This launch deployment could not be verified.",
  "runtime-mismatch": "The launch configuration differs from its chain data.",
  "venue-unrecorded": "This venue is not configured for the launch.",
  "venue-not-routed": "The launch is not routed through this venue.",
  "deployment-rejected": "The launch deployment could not be verified. Try again later.",
  "signer-unavailable": "Your wallet is unavailable. Reconnect it and retry.",
  "wrong-network": "Switch your wallet to the correct network and retry.",
  "fresh-read-unavailable": "Fresh chain data is unavailable. Try again shortly.",
  "object-unavailable": "A required coin or pool could not be read. Refresh and retry.",
  "foreign-lineage": "This coin or pool does not belong to the selected launch.",
  "stale-lifecycle": "The launch changed. Refresh and review the transaction.",
  "stale-route": "The trade route changed. Refresh the quote and retry.",
  "insufficient-balance": "Your balance is too low. Review the amount and network fee.",
  ineligible: "This account is not eligible for this action.",
  "preview-unavailable": "The transaction preview is unavailable. Try again shortly.",
  "simulation-unavailable": "The transaction could not be checked. Try again shortly.",
  "simulation-failed": "The transaction check failed. Review its amount and launch status.",
  "unsupported-route": "This trade route is not supported. Choose another route.",
  "quote-refused": "The quote was refused. Review the amount and retry.",
  "quote-unavailable": "A fresh quote is unavailable. Try again shortly.",
  "runtime-unverified": "The launch service could not be verified. Try again shortly.",
  "not-migrated": "This launch has not migrated yet.",
  "unsupported-venue": "This venue is not supported. Choose another venue.",
  "unsupported-quote": "This quote coin is not supported for this route.",
  "deployment-mismatch": "This pool does not match the launch deployment. Refresh and retry.",
  "route-substitution": "This pool does not match the launch route. Refresh and retry.",
  "unsupported-tier": "This pool tier is not supported. Choose another tier.",
  expired: "The transaction expired before it could complete. Review and try again.",
  quote_expired: "The quote expired. Refresh it and review the transaction again.",
  transaction_record_failed: "The signed transaction could not be recorded. Nothing was submitted.",
  transaction_not_found: "The transaction could not be found. Check its digest before signing again.",
  "evidence-missing": "The transaction completed, but its expected Blast record could not be verified. Check it before signing again.",
  BAD_INPUT: "The supplied input is invalid. Review it and try again.",
  request_failed: "That action could not finish. Try again.",
  request_refused: "That action was refused. Review it and try again.",
  network_unavailable: "Blast could not be reached. Check your connection and try again.",
  authentication_unavailable: "Sign-in could not be checked. Sign in again and retry.",
  request_cancelled: "The request was cancelled.",
  invalid_response: "Blast returned an unreadable response. Try again.",
  page_unavailable: "This page could not load. Try again.",
  publish_failed: "Publishing could not finish.",
  publish_in_progress: "This draft is publishing in another tab. Finish there first.",
  publish_progress_invalid: "Saved publish progress could not be read. Keep this draft and contact support.",
  wallet_rejected: "You cancelled the wallet request. Nothing was signed.",
  sign_failed: "Your wallet could not sign. Reconnect it and try again.",
  execution_failed: "The transaction failed on Sui. Its changes were reverted; network fees may have been spent.",
  price_moved: "The price moved beyond your quote. Refresh the quote and retry.",
  pool_unavailable: "The trade pool is temporarily unavailable. Refresh and retry.",
  claim_unreachable: "The claim could not reach Blast. Try again.",
  claim_pending: "Your claim is awaiting confirmation. Check its transaction before claiming again.",
  claim_unsupported: "This claim is not supported.",
  already_claimed: "This position has already been claimed.",
  claim_not_open: "Claiming is not open yet.",
  rejected: "You cancelled the wallet request.",
  mismatch: "The transaction changed. Nothing was signed.",
  ADMISSION_UNAVAILABLE: "Blast access is temporarily unavailable. Try again shortly.",
  ACCESS_DENIED: "This action is not permitted. Sign in with the correct account.",
  SHARE_REQUEST_INVALID: "This share request is invalid. Review it and try again.",
  SHARE_NOT_FOUND: "This share is no longer available.",
  SHARE_UNAVAILABLE: "Sharing is temporarily unavailable. Try again shortly.",
};

const PUBLIC_MESSAGES: Readonly<Record<string, string>> = { ...LEGACY_ERROR_MESSAGES, ...PRESALE_ERROR_MESSAGES, ...SOCIAL_ERROR_MESSAGES, ...LOCAL_MESSAGES };

export function publicErrorCopy(code: unknown, fallback = "That action could not finish. Try again."): string {
  return typeof code === "string" && Object.hasOwn(PUBLIC_MESSAGES, code) ? PUBLIC_MESSAGES[code]! : fallback;
}

export function safeErrorCode(code: unknown, fallback = "request_failed"): string {
  return typeof code === "string" && (Object.hasOwn(PUBLIC_MESSAGES, code) || /^http_[45][0-9]{2}$/.test(code)) ? code : fallback;
}

export function responseDiagnostic(response: Response): Readonly<{ httpStatus: number; requestId?: string; retryAfterSeconds?: number }> {
  const requestId = response.headers.get("x-request-id");
  const retry = Number(response.headers.get("retry-after"));
  return { httpStatus: response.status, ...(requestId && /^[a-zA-Z0-9_-]{1,128}$/.test(requestId) ? { requestId } : {}), ...(Number.isSafeInteger(retry) && retry > 0 ? { retryAfterSeconds: retry } : {}) };
}

/** Only fixed application copy belongs in message; server/wallet text never does. */
export function diagnosticMessage(message: string, diagnostic: ErrorDiagnostic = {}): string {
  const code = safeErrorCode(diagnostic.code, diagnostic.httpStatus && diagnostic.httpStatus >= 500 ? "service_unavailable" : "request_failed");
  const reference = diagnostic.requestId && /^[a-zA-Z0-9_-]{1,128}$/.test(diagnostic.requestId) ? ` Reference: ${diagnostic.requestId}.` : "";
  const reason = diagnostic.reason === "daily_limit" || diagnostic.reason === "open_reservations" ? `/${diagnostic.reason}` : "";
  return `${message} Code: ${code}${reason}.${reference}`;
}

/**
 * A diagnostic message split for display (docs/errors.md keeps the code and
 * reference visible): the plain sentence, and the "Code: …" tail for a muted
 * second line. Detail is null when the message carries no code.
 */
export function splitDiagnostic(message: string): Readonly<{ text: string; detail: string | null }> {
  const at = message.search(/ Code: [\w/]+\./);
  return at < 0 ? { text: message, detail: null } : { text: message.slice(0, at), detail: message.slice(at + 1) };
}

/** Marks fixed local text as safe to show after an async flow throws. */
export class PublicError extends Error {
  readonly code: string;
  readonly requestId?: string;
  readonly httpStatus: number | null;
  readonly retryAfterSeconds: number | null;
  constructor(message: string, diagnostic: ErrorDiagnostic = {}) {
    super(diagnosticMessage(message, diagnostic));
    this.name = "PublicError";
    this.code = safeErrorCode(diagnostic.code, diagnostic.httpStatus && diagnostic.httpStatus >= 500 ? "service_unavailable" : "request_failed");
    this.requestId = diagnostic.requestId;
    this.httpStatus = diagnostic.httpStatus ?? null;
    this.retryAfterSeconds = diagnostic.retryAfterSeconds ?? null;
  }
}

export function publicErrorMessage(error: unknown, fallback = "That action could not finish. Try again.", code = "request_failed"): string {
  return error instanceof PublicError ? error.message : diagnosticMessage(fallback, { code });
}

export function responseError(payload: unknown, response: Response, fallback = "That action could not finish. Try again."): PublicError {
  const body = payload && typeof payload === "object" ? payload as { error?: unknown; code?: unknown } : null;
  const error = body?.error && typeof body.error === "object" ? body.error as { code?: unknown } : null;
  const code = safeErrorCode(error?.code ?? body?.code, response.ok ? "invalid_response" : response.status >= 500 ? "service_unavailable" : `http_${response.status}`);
  const httpMessages: Readonly<Record<number, string>> = { 401: "Sign in again and retry this action.", 403: "This action is not permitted for your account.", 404: "This item could not be found. Refresh and retry.", 405: "This action is not supported. Refresh and retry.", 413: "This upload is too large. Use a smaller file.", 429: "Too many requests. Wait a moment and retry." };
  const message = PUBLIC_MESSAGES[code] ?? httpMessages[response.status] ?? fallback;
  return new PublicError(message, { ...responseDiagnostic(response), code });
}
