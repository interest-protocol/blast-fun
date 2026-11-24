import { z } from "zod";


/** Fixed public copy for legacy HTTP error codes; safe to import in the browser. */
export const LEGACY_ERROR_MESSAGES = {
  OAUTH_UNAVAILABLE: "Authentication is temporarily unavailable. Please retry.",
  "SHARE_NOT_PUBLISHED": "Use Share on X to prepare your card first.",
  "VERIFICATION_IN_PROGRESS": "We are still checking your previous post link. Wait for that result, then try again.",
  "TELEGRAM_USERNAME_INVALID": "Use 5–32 letters, numbers or underscores, with an optional @.",
  "SHARE_POST_URL_INVALID": "Paste a public X post link.",
  "X_NOT_FOLLOWING": "Follow @blastdotfun on X, then verify again.",
  "X_POST_NOT_FOUND": "Post not found. Check the link and try again.",
  "X_WRONG_AUTHOR": "Share from the X account connected to your BLAST card.",
  "X_POST_PRIVATE": "Your post must be public to unlock codes.",
  "X_MISSING_CARD_LINK": "Include your unique BLAST card link in the post.",

  ADMIN_REQUEST_INVALID: "The presale admin request is invalid.",
  ADMIN_UNAVAILABLE: "Presales are temporarily unavailable. Refresh to check the saved state.",
  CONTENT_TYPE_INVALID: "Send this request as JSON.",
  METHOD_NOT_ALLOWED: "This HTTP method is not supported.",
  PAYLOAD_TOO_LARGE: "The request is too large. Reduce it and retry.",
  REQUEST_TIMEOUT: "The request timed out. Please retry.",
  LAUNCHPAD_QUERY_INVALID: "The search or list parameters are invalid. Check them and try again.",
  LAUNCHPAD_VIEW_UNSUPPORTED: "Choose a supported view.",
  LAUNCHPAD_CURSOR_INVALID: "This page token is invalid. Start again from the first page.",
  "ACCESS_DENIED": "Access could not be verified.",
  "ACCOUNT_LINK_INVALID": "The account link request is invalid.",
  "ACCOUNT_LINK_UNAVAILABLE": "Account linking is temporarily unavailable.",
  "ADMISSION_UNAVAILABLE": "Admission is temporarily unavailable. Please retry.",
  "AVAILABILITY_UNAVAILABLE": "Callsign check is temporarily unavailable.",
  "BOT_CHALLENGE_FAILED": "The security challenge could not be verified.",
  "BOT_CHALLENGE_REQUIRED": "A security challenge is required.",
  "CALLSIGN_RATE_LIMITED": "Too many callsign attempts.",
  "CALLSIGN_RESERVED": "That callsign is reserved.",
  "CALLSIGN_TAKEN": "That callsign is no longer available.",
  "CARD_BUSY": "Cards are busy rendering. Please retry in a few seconds.",
  "CARD_NOT_FOUND": "Card not found.",
  "CARD_UNAVAILABLE": "The saved card could not be rendered. Please retry.",
  "CLEANUP_FAILED": "Some cleanup steps failed. Check the reference ID in server logs.",
  "CLEANUP_UNAVAILABLE": "Cleanup is temporarily unavailable.",
  "CODES_NOT_OPEN": "Launch codes are not open yet.",
  "COMPLETION_UNAVAILABLE": "Completion is temporarily unavailable.",
  "CREW_ACCESS_DENIED": "Crew access could not be restored.",
  "CREW_ACCESS_UNAVAILABLE": "Crew access is temporarily unavailable.",
  "CSRF_INVALID": "The request could not be verified.",
  "CURSOR_INVALID": "The recruit cursor is invalid.",
  "DISPLAY_NAME_INVALID": "Display name must be 100 characters or fewer.",
  "IDEMPOTENCY_CONFLICT": "That completion key was already used for another request.",
  "IDENTITY_ALREADY_EXISTS": "That verified identity already has a profile.",
  "IDENTITY_ALREADY_LINKED": "That identity belongs to another Blast account.",
  "IDENTITY_CONFLICT": "That verified identity already has a profile.",
  "INTERNAL_ERROR": "The request could not be completed. Please retry.",
  "INVALID_CALLSIGN": "The callsign is invalid.",
  "INVALID_DISCLOSURE": "Disclosure acceptance is invalid.",
  "INVALID_FLEET_CHOICE": "The fleet selection is invalid.",
  "INVALID_IDENTITY": "The verified identity snapshot is invalid.",
  "LAUNCHPAD_INTERNAL_ERROR": "The request could not be completed.",
  "LAUNCHPAD_READ_RETRY_LATER": "This view is busy. Try again shortly.",
  "LAUNCHPAD_READ_UNAVAILABLE": "This view is temporarily unavailable.",
  "LAUNCHPAD_TELEMETRY_INVALID": "The telemetry request is invalid.",
  "LAUNCHPAD_TELEMETRY_UNAVAILABLE": "Telemetry is temporarily unavailable.",
  "MEMBERSHIP_ALREADY_EXISTS": "That profile already has a season membership.",
  "OAUTH_CONFIGURATION_INVALID": "Authentication is not configured.",
  "OAUTH_FAILED": "Authentication could not be completed.",
  "OAUTH_STATE_INVALID": "Authentication could not be verified.",
  "OPERATOR_AUTH_FAILED": "Operator authentication failed.",
  "OPERATOR_CONFLICT": "The requested operator action conflicts with current state.",
  "OPERATOR_INPUT_INVALID": "The operator action is invalid or outside its bounds.",
  "OPERATOR_TARGET_NOT_FOUND": "The operator action target was not found.",
  "OPERATOR_UNAVAILABLE": "The operator procedure is unavailable.",
  "ORIGIN_INVALID": "The request origin could not be verified.",
  "OWNER_NOT_FOUND": "Owner profile unavailable.",
  "OWNER_UNAVAILABLE": "Owner profile temporarily unavailable.",
  "PROJECTION_FAILED": "Some projection steps failed. Check the reference ID in server logs.",
  "PROJECTION_UNAVAILABLE": "Projection updates are temporarily unavailable.",
  "PROVIDER_UNAVAILABLE": "Identity verification is temporarily unavailable.",
  "RATE_LIMITED": "Too many requests.",
  "RENDER_UNAVAILABLE": "The card is saved and can be rendered again.",
  "REQUEST_INVALID": "The request is invalid. Check the details and try again.",
  "SEASON_CLOSED": "Season Zero is closed to new completions.",
  "SEASON_NOT_FOUND": "The season does not exist.",
  "SERVICE_UNAVAILABLE": "This service is temporarily unavailable. Please retry.",
  "SESSION_CONFIGURATION_INVALID": "Member sessions are not configured.",
  "SESSION_INVALID": "The member session is invalid or expired.",
  "SESSION_UNAVAILABLE": "Member sessions are temporarily unavailable.",
  "SHARE_NOT_FOUND": "The shared card was not found.",
  "SHARE_REQUEST_INVALID": "The share request is invalid. Check the details and try again.",
  "SHARE_UNAVAILABLE": "Share verification is temporarily unavailable. Please retry.",
  "SHIP_FULL": "The ship is full.",
  "TELEMETRY_UNAVAILABLE": "Telemetry is temporarily unavailable.",
  "UNAUTHORIZED": "Cron authorization is required.",
  "WALLET_ALREADY_LINKED": "That wallet belongs to another Blast account.",
  "WALLET_CHALLENGE_RATE_LIMITED": "Too many wallet verification attempts.",
  "WALLET_CHALLENGE_REQUEST_INVALID": "The wallet challenge request is invalid.",
  "WALLET_CONFLICT": "That wallet already has a profile.",
  "WALLET_KIND_ALREADY_LINKED": "That wallet type is already linked.",
  "WALLET_NOT_FOUND": "The linked wallet was not found.",
  "WALLET_PROOF_INVALID": "Wallet verification failed.",
  "WALLET_PROOF_REQUIRED": "Wallet verification is required.",
  "WALLET_PROOF_UNAVAILABLE": "Wallet verification is temporarily unavailable.",
  "bad_gateway": "Market data could not be read. Please retry.",
  "gate_forbidden": "The request origin could not be verified.",
  "gate_required": "Reload this page to verify the request.",
  "gate_unavailable": "Request verification is temporarily unavailable. Please retry.",
  "invalid_parameter": "The market data parameters are invalid.",
  "not_found": "The requested item was not found.",
  "rate_limited": "Too many requests. Wait before retrying.",
  "unavailable": "Market data is temporarily unavailable. Please retry.",
  "unconfigured": "Market data is temporarily unavailable. Please retry.",
  "unreachable": "Market data could not be read. Please retry."
} as const satisfies Readonly<Record<string, string>>;

export type LegacyPublicErrorCode = keyof typeof LEGACY_ERROR_MESSAGES;
export type LegacyPublicError = Readonly<{ code: LegacyPublicErrorCode; message: string }>;

export function legacyPublicError(code: LegacyPublicErrorCode): LegacyPublicError {
  return { code, message: LEGACY_ERROR_MESSAGES[code] };
}

function isLegacyPublicErrorCode(code: string): code is LegacyPublicErrorCode {
  return Object.hasOwn(LEGACY_ERROR_MESSAGES, code);
}

const legacyPublicErrorSchema = z.strictObject({ code: z.string(), message: z.string() });

/** Accepts only a known code and replaces response text with fixed public copy. */
export function parseLegacyPublicError(value: unknown): LegacyPublicError | null {
  const parsed = legacyPublicErrorSchema.safeParse(value);
  if (!parsed.success || !isLegacyPublicErrorCode(parsed.data.code)) return null;
  return legacyPublicError(parsed.data.code);
}
