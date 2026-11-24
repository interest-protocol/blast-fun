import { z } from "zod";
import { socialCallsignSchema } from "@blast/core/modules/social/contracts/primitives.ts";

import { socialMeAccountSchema, type SocialMeAccount } from "@blast/core/modules/social/contracts/me.ts";

/**
 * Creating a new Blast Account during onboarding.
 *
 * `POST /api/social/accounts {}` saves a generated display name and unique
 * callsign and completes onboarding atomically. `{ callsign, display_name? }`
 * remains supported for explicit creation. Signed-in callers receive `201`
 * with `{ account }` in the `me` shape, `private, no-store`.
 * Explicit callsigns are lowercased; names are trimmed. Without a name,
 * explicit creation takes the linked X name or falls back to the callsign.
 * A caller who signed in with a Sui wallet (Slush)
 * gets that wallet recorded as its `slush` wallet. Refusals:
 *
 * - `422 invalid_callsign`: not `^[a-z0-9][a-z0-9_]{1,18}[a-z0-9]$`;
 * - `422 invalid_display_name`: a display name sent that is not 1 to 32 code
 *   points after trimming;
 * - `422 blocked_term`: a blocked term in either field (`error.field` names it);
 * - `422 callsign_reserved`: in Mission Control's reserved list;
 * - `409 callsign_taken`: a Mission Control profile or another account holds it;
 * - `409 account_exists`: the caller already has an account;
 * - `409 member_exists`: the caller's linked X account is a Mission Control
 *   member's, who signs in with X instead. Nothing is created.
 *
 * X handle, display name and avatar come from the caller's Privy user when it
 * has a linked X account; if Privy cannot be read the account is created
 * without them. Privy DIDs and X subjects never appear in a response.
 * JSON Schemas: `schemas/account-create-request.schema.json`, and
 * `schemas/me-response.schema.json` for the 201.
 *
 * `GET /api/social/callsigns/{callsign}` (signed in, bucket `social_read`):
 * `{ available, reason }`, the same checks in the same order as creation
 * (format, blocked term, reserved, taken); a caller can keep or reclaim its
 * own social callsign. JSON Schema:
 * `schemas/callsign-availability-response.schema.json`.
 */

/** A callsign, after lowercasing. */
export const SOCIAL_CALLSIGN_PATTERN = /^[a-z0-9][a-z0-9_]{1,18}[a-z0-9]$/;

/** A display name's length in Unicode code points, after trimming. */
export const SOCIAL_DISPLAY_NAME_MAX_CODE_POINTS = 32;

export const SOCIAL_CALLSIGN_UNAVAILABLE_REASONS = ["invalid", "reserved", "taken", "blocked"] as const;
export type SocialCallsignUnavailableReason = (typeof SOCIAL_CALLSIGN_UNAVAILABLE_REASONS)[number];

export const socialCallsignAvailabilitySchema = z.xor([
  z.strictObject({ available: z.literal(true), reason: z.null() }),
  z.strictObject({ available: z.literal(false), reason: z.enum(SOCIAL_CALLSIGN_UNAVAILABLE_REASONS) }),
]).meta({
  title: "Callsign availability",
  description: "GET /api/social/callsigns/{callsign} 200. The callsign is lowercased, then checked in creation's order: invalid (format), blocked (a blocked term), reserved (Mission Control's reserved list), taken (a profile or an account holds it).",
});

export type SocialCallsignAvailability = Readonly<z.infer<typeof socialCallsignAvailabilitySchema>>;

export const socialCreateAccountRequestSchema = z.strictObject({
  callsign: z.string().optional(),
  display_name: z.string().optional(),
}).refine((body) => body.display_name === undefined || body.callsign !== undefined).meta({
  title: "Blast Account creation",
  description: "POST /api/social/accounts. An empty object creates and saves a generated unique callsign and display name, with onboarding complete. Explicit callsign and optional display_name retain the existing creation behavior. A display_name without a callsign is refused.",
  dependentRequired: { display_name: ["callsign"] },
});

export type SocialCreateAccountRequest = Readonly<z.infer<typeof socialCreateAccountRequestSchema>>;

export const socialCreateAccountResponseSchema = z.strictObject({ account: socialMeAccountSchema });
export type SocialCreateAccountResponse = Readonly<{ account: SocialMeAccount }>;

/** Which field a `blocked_term` refusal is about (`error.field`). */
export type SocialAccountField = "callsign" | "display_name";

export const SOCIAL_ACCOUNTS_ROUTE = "POST /api/social/accounts";
export const SOCIAL_ACCOUNTS_PATH = "/api/social/accounts";
export const SOCIAL_CALLSIGNS_ROUTE = "GET /api/social/callsigns/{callsign}";
export const SOCIAL_CALLSIGNS_PATH = "/api/social/callsigns";

/** `GET /api/social/callsigns/{callsign}` for one callsign, encoded. */
export function socialCallsignPath(callsign: string): string {
  return `${SOCIAL_CALLSIGNS_PATH}/${encodeURIComponent(callsign)}`;
}

/** The callsign as it is validated and stored: lowercased, nothing else. */
export function normalizeSocialCallsign(value: string): string {
  return value.toLowerCase();
}

export function isSocialCallsign(callsign: string): boolean {
  return socialCallsignSchema.safeParse(callsign).success;
}

/** The trimmed display name when it has 1 to 32 code points, else null. */
export function normalizeSocialDisplayName(value: string): string | null {
  const parsed = socialDisplayNameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export const socialDisplayNameSchema = z.string().trim().refine(
  (value) => [...value].length >= 1 && [...value].length <= SOCIAL_DISPLAY_NAME_MAX_CODE_POINTS,
);
