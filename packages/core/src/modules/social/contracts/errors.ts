import { z } from "zod";

/**
 * Every error code a social route can answer, with its fixed HTTP status.
 * `retryAfter` marks the codes sent with a `Retry-After` header: `rate_limited`
 * and every 503. Bodies are `{ error: { code, message, ...extra } }`; the
 * header is the only carrier of the retry time. A client treats an unknown
 * code with its generic failure copy. Later social routes add their own codes
 * here.
 */
export const SOCIAL_ERRORS = {
  invalid_parameter: { status: 400, retryAfter: false },
  invalid_signature: { status: 400, retryAfter: false },
  invalid_request: { status: 400, retryAfter: false },
  unauthorized: { status: 401, retryAfter: false },
  origin_invalid: { status: 403, retryAfter: false },
  portfolio_private: { status: 403, retryAfter: false },
  not_found: { status: 404, retryAfter: false },
  account_required: { status: 409, retryAfter: false },
  onboarding_required: { status: 409, retryAfter: false },
  body_too_large: { status: 413, retryAfter: false },
  invalid_amount: { status: 422, retryAfter: false },
  invalid_reaction: { status: 422, retryAfter: false },
  cannot_follow_self: { status: 422, retryAfter: false },
  follow_limit: { status: 422, retryAfter: false },
  watchlist_limit: { status: 422, retryAfter: false },
  invalid_callsign: { status: 422, retryAfter: false },
  invalid_display_name: { status: 422, retryAfter: false },
  callsign_reserved: { status: 422, retryAfter: false },
  blocked_term: { status: 422, retryAfter: false },
  callsign_taken: { status: 409, retryAfter: false },
  account_exists: { status: 409, retryAfter: false },
  workspace_exists: { status: 409, retryAfter: false },
  workspace_schema_unsupported: { status: 409, retryAfter: false },
  workspace_write_mismatch: { status: 409, retryAfter: false },
  workspace_write_outdated: { status: 409, retryAfter: false },
  member_exists: { status: 409, retryAfter: false },
  wallet_taken: { status: 409, retryAfter: false },
  wallet_unlink_changed: { status: 409, retryAfter: false },
  wallet_proof_invalid: { status: 400, retryAfter: false },
  wallet_ambiguous: { status: 409, retryAfter: false },
  invalid_image: { status: 422, retryAfter: false },
  picture_upload_unavailable: { status: 503, retryAfter: true },
  // Create (UI-20): drafts and publishing.
  draft_conflict: { status: 409, retryAfter: false },
  draft_limit: { status: 422, retryAfter: false },
  draft_incomplete: { status: 422, retryAfter: false },
  allowlist_not_found: { status: 422, retryAfter: false },
  invalid_logo: { status: 422, retryAfter: false },
  publish_unavailable: { status: 409, retryAfter: false },
  logo_upload_unavailable: { status: 503, retryAfter: true },
  // Coins (UI-14): withdrawals from the Blast wallet.
  blast_wallet_missing: { status: 409, retryAfter: false },
  invalid_recipient: { status: 422, retryAfter: false },
  transfer_conflict: { status: 409, retryAfter: false },
  // Whys (T-021): the text rules, the author and window checks, the per-item limits.
  why_empty: { status: 422, retryAfter: false },
  why_too_long: { status: 422, retryAfter: false },
  why_invalid: { status: 422, retryAfter: false },
  why_has_link: { status: 422, retryAfter: false },
  not_author: { status: 403, retryAfter: false },
  why_window_closed: { status: 409, retryAfter: false },
  why_exists: { status: 409, retryAfter: false },
  why_removed: { status: 409, retryAfter: false },
  why_limit: { status: 409, retryAfter: false },
  // Whys (T-022): reporting someone else's why.
  cannot_report_self: { status: 422, retryAfter: false },
  // Intents (T-024): one digest has one sender.
  digest_taken: { status: 409, retryAfter: false },
  // The commit dialog (T-028): signing is off until the presale contract's
  // deployment manifest names a mainnet package, as publishing is in Create.
  commit_unavailable: { status: 409, retryAfter: false },
  // The commit transaction, built on the server: the Blast wallet holds less than the commitment.
  insufficient_balance: { status: 409, retryAfter: false },
  // Trades (R3-31): a key reused for another quote; Blast will not pay this trade's fee.
  trade_conflict: { status: 409, retryAfter: false },
  sponsorship_unavailable: { status: 409, retryAfter: false },
  // The claim transaction (R3-63): nothing open to claim, an attempt recorded
  // differently, and claiming off until the manifest names a mainnet package.
  nothing_to_claim: { status: 409, retryAfter: false },
  claim_conflict: { status: 409, retryAfter: false },
  claim_unavailable: { status: 409, retryAfter: false },
  // The deposit transaction (OA-25): the CCTP bridge is off (its activation
  // record) or lists no route from that chain; an attempt recorded differently.
  deposit_unavailable: { status: 409, retryAfter: false },
  deposit_conflict: { status: 409, retryAfter: false },
  // Sale details (R3-24): only the sale's creator edits them, never once it is cancelled, and each field has its rule.
  not_sale_creator: { status: 403, retryAfter: false },
  sale_cancelled: { status: 409, retryAfter: false },
  tagline_too_long: { status: 422, retryAfter: false },
  tagline_invalid: { status: 422, retryAfter: false },
  tagline_has_link: { status: 422, retryAfter: false },
  invalid_link: { status: 422, retryAfter: false },
  invalid_x_handle: { status: 422, retryAfter: false },
  invalid_telegram: { status: 422, retryAfter: false },
  invalid_cover: { status: 422, retryAfter: false },
  cover_upload_unavailable: { status: 503, retryAfter: true },
  // Create's details (R3-25): a draft becomes one sale, once.
  draft_published: { status: 409, retryAfter: false },
  // Withdraw to another chain (CCTP V2): the destination or Circle is not available now; a key reused for
  // another withdrawal; Circle's fee rose above the one the sheet showed.
  bridge_unavailable: { status: 503, retryAfter: true },
  bridge_withdraw_conflict: { status: 409, retryAfter: false },
  bridge_fee_changed: { status: 409, retryAfter: false },
  // A launch's creator caps: the launch names another recipient, or its caps were already claimed.
  not_creator_recipient: { status: 403, retryAfter: false },
  creator_caps_claimed: { status: 409, retryAfter: false },
  quote_busy: { status: 503, retryAfter: true },
  rate_limited: { status: 429, retryAfter: true },
  service_unavailable: { status: 503, retryAfter: true },
} as const satisfies Record<string, { status: number; retryAfter: boolean }>;

export type SocialErrorCode = keyof typeof SOCIAL_ERRORS;

const retryFields = ["retryAfterSeconds", "retry_after_seconds"] as const;

export const socialErrorSchema = z.strictObject({
  error: z.looseObject({
    code: z.string().regex(/^[a-z][a-z_]{0,63}$/),
    message: z.string().min(1).max(200),
  }).refine(
    (error) => retryFields.every((field) => !Object.hasOwn(error, field)),
  ).meta({ propertyNames: { not: { enum: retryFields } } }),
}).meta({
  title: "Social route error",
  description: "Every social route error: { error: { code, message, ...extra } }. The body never carries a retry time (Retry-After is the carrier).",
});

type WireError = z.infer<typeof socialErrorSchema>["error"];

export type SocialErrorBody<Code extends SocialErrorCode = SocialErrorCode> = {
  error: WireError & { code: Code };
};

/** Fixed safe public text, shared by server and browser error handling. */
export const SOCIAL_ERROR_MESSAGES: Readonly<Record<SocialErrorCode, string>> = {
  invalid_parameter: "A path or query parameter is invalid.",
  invalid_signature: "The wallet signature could not be verified. Nothing was linked.",
  invalid_request: "The request is invalid.",
  unauthorized: "Sign in to continue.",
  origin_invalid: "The request origin could not be verified.",
  portfolio_private: "This portfolio is private.",
  not_found: "Not found.",
  account_required: "Create your Blast account to continue.",
  onboarding_required: "Finish setting up your Blast account first.",
  body_too_large: "The request is too large.",
  invalid_amount: "The amount is too small to cover the fee.",
  invalid_reaction: "That reaction is not available.",
  cannot_follow_self: "You cannot follow yourself.",
  follow_limit: "You follow the most accounts and presales allowed. Unfollow one first.",
  watchlist_limit: "Your watchlist is full. Remove a presale first.",
  invalid_callsign: "Use 3 to 20 lowercase letters, digits or underscores, starting and ending with a letter or digit.",
  invalid_display_name: "Use a display name of 1 to 32 characters.",
  callsign_reserved: "That callsign is reserved.",
  blocked_term: "That text contains a word that is not allowed.",
  callsign_taken: "That callsign is taken.",
  account_exists: "You already have a Blast account.",
  workspace_exists: "This account already has a saved workspace.",
  workspace_schema_unsupported: "This workspace version is not supported. Update Blast before saving.",
  workspace_write_mismatch: "This workspace write was already accepted with different contents.",
  workspace_write_outdated: "A newer workspace write from this device was already accepted.",
  member_exists: "Your X account already belongs to a Blast member. Sign in with X to use it.",
  wallet_taken: "That wallet belongs to another Blast account.",
  wallet_unlink_changed: "Your wallet list changed. Review it before trying again.",
  wallet_proof_invalid: "The wallet signature could not be verified. Try again.",
  wallet_ambiguous: "This wallet is linked to more than one account. Sign in with X or Google instead.",
  invalid_image: "Use a still PNG, JPEG or WebP image from 64 to 4,096 pixels on each side.",
  picture_upload_unavailable: "Picture uploads are not available right now.",
  draft_conflict: "This draft changed since you opened it. The saved version is attached.",
  draft_limit: "You have the most drafts allowed. Delete one first.",
  draft_incomplete: "Finish the draft before publishing.",
  allowlist_not_found: "That allowlist was not found. Upload it again.",
  invalid_logo: "Use a PNG, JPEG or WebP image from 64 to 4,096 pixels on each side, under 2 MB.",
  publish_unavailable: "Publishing is not available yet.",
  logo_upload_unavailable: "Logo uploads are not available right now.",
  blast_wallet_missing: "Your Blast wallet is not set up yet.",
  invalid_recipient: "Send to a Sui address other than your Blast wallet.",
  transfer_conflict: "This withdrawal was already recorded differently. The recorded one is attached.",
  why_empty: "Write your why first.",
  why_too_long: "Keep it to 280 characters.",
  why_invalid: "Keep your why to one line.",
  why_has_link: "Links aren’t allowed in a why.",
  not_author: "Only the author can do that.",
  why_window_closed: "A why can be added only within 24 hours of the post.",
  why_exists: "This post already has a why.",
  why_removed: "The Blast team removed this post’s why, so it can’t take another.",
  why_limit: "This post has had all the whys it can take.",
  cannot_report_self: "You cannot report your own why.",
  digest_taken: "That transaction is already registered to another account.",
  commit_unavailable: "Blasting is not available yet.",
  insufficient_balance: "Your Blast wallet holds less than this commitment.",
  trade_conflict: "This trade was already sent with another quote. The recorded one stands.",
  sponsorship_unavailable: "Blast can’t pay this trade’s network fee right now. You can pay it from your SUI.",
  nothing_to_claim: "There is nothing to claim from this sale for your Blast wallet.",
  claim_conflict: "This claim was already recorded differently.",
  claim_unavailable: "Claiming is not available yet.",
  deposit_unavailable: "Sending from another chain is not available right now.",
  deposit_conflict: "This deposit was already recorded differently.",
  not_sale_creator: "Only the sale’s creator can change its details.",
  sale_cancelled: "This sale was cancelled, so its details can’t change.",
  tagline_too_long: "Keep it to 120 characters.",
  tagline_invalid: "Keep it to one line.",
  tagline_has_link: "Links aren’t allowed in the description.",
  invalid_link: "That isn't a web address.",
  invalid_x_handle: "X handles are up to 15 letters, digits or _.",
  invalid_telegram: "Telegram names are 5 to 32 letters, digits or _.",
  invalid_cover: "Use a still PNG, JPEG or WebP image under 4 MB, at least 128 pixels on each side.",
  cover_upload_unavailable: "Cover uploads are not available right now.",
  draft_published: "This draft is already published as a sale.",
  bridge_unavailable: "Withdrawing to that chain is not available right now.",
  bridge_withdraw_conflict: "This withdrawal was already recorded differently. The recorded one is attached.",
  bridge_fee_changed: "Circle’s fee changed. Check the new fee and try again.",
  not_creator_recipient: "This launch's creator rights belong to another account or wallet.",
  creator_caps_claimed: "This launch's creator rights were already claimed.",
  quote_busy: "Quotes are busy. Try again shortly.",
  rate_limited: "Too many requests. Try again later.",
  service_unavailable: "The service is temporarily unavailable.",
};
