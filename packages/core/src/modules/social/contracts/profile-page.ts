import { z } from "zod";
import { socialAddressSchema, socialCallsignSchema } from "./primitives.ts";

import { socialAsOfSchema } from "@blast/core/modules/social/contracts/items.ts";
import { profileBioSchema } from "./profiles.ts";
import type { PresaleReadonly } from "./presale-schemas.ts";
import type {
  mePresalePositionSchema,
  meHoldingCoinSchema,
  meVestingSchema,
  socialMePresalesSchema,
} from "./me-presales.ts";

/**
 * The profile page's reads and the own profile's edit sheet (canonical UI §6,
 * UI-06). Public reads are `auth: "none"`, bucket `social_read` (IP), read on
 * the replica and publicly cached (`public, s-maxage=10,
 * stale-while-revalidate=20`; errors `no-store`); they carry no viewer field.
 * Viewer reads and writes need a signed-in caller with a Blast Account
 * (`409 account_required` otherwise) and are `private, no-store`.
 *
 * - `GET /api/social/profiles/{callsign}/calls` (public): the account's
 *   presale calls and its track record. Owner decision OA-9: every named
 *   commit is a call; a call is the account's named commits to one presale,
 *   summed. A private account, or one not sharing, has none. Schema
 *   `schemas/profile-calls-response.schema.json`.
 * - `GET /api/social/profiles/{callsign}/theses?cursor=&limit=` (public): the
 *   account's named posts that carry its why, most rockets first (then
 *   newest), paged like the items route with its own cursor. Schema
 *   `schemas/profile-items-page.schema.json`.
 * - `GET /api/social/profiles/{callsign}/mutuals` (viewer): up to three
 *   accounts the viewer follows that follow this one, and how many there are.
 *   Schema `schemas/profile-mutuals-response.schema.json`.
 * - `GET /api/social/me/presales` (viewer, primary): the viewer's own presale
 *   positions, watchlist (starred presales, then followed ones not starred;
 *   UI-12, OA-17), sale coins held and vesting schedules, each with its
 *   presale's summary: the profile's holdings card
 *   and right column. Each position and coin carries its sale coin's cost
 *   basis and P&L (R3-32, `CostBasisFigures`: the same figures as
 *   `/me/portfolio`). Owner-only, never cached. Schema
 *   `schemas/me-presales-response.schema.json`.
 * - `GET` and `PUT /api/social/me/profile`, `PUT /api/social/me/profile/picture`
 *   (viewer, primary): display name, bio and picture, plus editable social callsigns.
 *   Schemas `profile-edit-request`, `profile-edit-response`.
 *
 * Refusals (besides the kit's): a malformed callsign, `limit` or `cursor` is
 * `400 invalid_parameter`; an unknown callsign `404 not_found`; no readable
 * watermark `503 service_unavailable`. Edit: `422 invalid_display_name`,
 * `422 blocked_term` (`field: "display_name"`, `"callsign"` or `"bio"`),
 * `422 invalid_callsign`, `422 callsign_reserved`, `409 callsign_taken`,
 * `400 invalid_request` (including a Mission Control callsign rename),
 * `413 body_too_large`, `422 invalid_image` (`reason`), `503
 * picture_upload_unavailable` (no picture store configured).
 */

export const SOCIAL_PROFILE_CALLS_ROUTE = "GET /api/social/profiles/{callsign}/calls";
export const SOCIAL_PROFILE_THESES_ROUTE = "GET /api/social/profiles/{callsign}/theses";
export const SOCIAL_PROFILE_MUTUALS_ROUTE = "GET /api/social/profiles/{callsign}/mutuals";
export const SOCIAL_ME_PRESALES_ROUTE = "GET /api/social/me/presales";
export const SOCIAL_ME_PRESALES_PATH = "/api/social/me/presales";
export const SOCIAL_PROFILE_EDIT_READ_ROUTE = "GET /api/social/me/profile";
export const SOCIAL_PROFILE_EDIT_ROUTE = "PUT /api/social/me/profile";
export const SOCIAL_PROFILE_PICTURE_ROUTE = "PUT /api/social/me/profile/picture";
export const SOCIAL_PROFILE_EDIT_PATH = "/api/social/me/profile";
export const SOCIAL_PROFILE_PICTURE_PATH = "/api/social/me/profile/picture";

/** At most this many calls are listed (an account backs few presales; the list is not paged). */
export const PROFILE_CALLS_MAX = 200;

/** How a presale reads on a profile row (the design's status chips). */
export const PROFILE_PRESALE_STATUSES = ["pending", "open", "closed", "funded", "trading", "cancelled"] as const;
export type ProfilePresaleStatus = (typeof PROFILE_PRESALE_STATUSES)[number];

const profileInteger = z.number().nonnegative().refine(Number.isInteger).meta({ type: "integer" });
const nullableProfileText = z.xor([z.null(), z.string().min(1)]);
const profileUsd = z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{2}$/);
const profileSignedUsd = z.string().regex(/^-?(0|[1-9][0-9]*)\.[0-9]{2}$/);
const profileDecimal = z.string().regex(/^(0|[1-9][0-9]*)(\.[0-9]+)?$/);
const profileMultiple = z.string().regex(/^(0|[1-9][0-9]*)\.[0-9]{4}$/);

export const profilePresaleSchema = z.strictObject({
  presale_id: socialAddressSchema,
  symbol: z.string().min(1),
  name: z.string().min(1),
  icon_url: z.string(),
  status: z.enum(PROFILE_PRESALE_STATUSES),
  venue: z.string(),
  start_ms: profileInteger,
  end_ms: profileInteger,
  fill_pct: profileInteger,
  quote_symbol: z.string().min(1).meta({ description: "R3-40: the sale's quote coin (USDC or SUI)." }),
  quote_decimals: profileInteger,
  launched_ms: z.xor([z.null(), profileInteger]).meta({ description: "R3-85: when the sale coin launched (its presale_lifecycle migrated time); null until it has." }),
  first_unlock_ms: z.xor([z.null(), profileInteger]).meta({ description: "R3-85: the sale's first unlock, the earliest cliff end of its vesting_schedules; null without one." }),
  coin_type: z.string().min(1).meta({ description: "Canonical sale coin type; optional for older cached responses." }).optional(),
  verified_team: z.boolean().meta({ description: "R3-23: Blast checked who is behind the sale (social_sale_trust); sent only when true." }).optional(),
}).meta({ description: "A presale as profile rows show it." });

export type ProfilePresale = Readonly<z.infer<typeof profilePresaleSchema>>;

export const profileCallSchema = z.strictObject({
  presale: profilePresaleSchema,
  committed_usd: profileUsd.nullable(),
  committed_atoms: z.string().regex(/^(0|[1-9][0-9]*)$/).meta({ description: "R3-40: the same commitment in quote atoms." }),
  entry_price_usd: z.xor([z.null(), profileDecimal]),
  price_usd: z.xor([z.null(), profileDecimal]),
  multiple: z.xor([z.null(), profileMultiple]),
  value_usd: z.xor([z.null(), profileUsd]),
  pnl_usd: z.xor([z.null(), profileSignedUsd]),
  last_commit_ms: profileInteger,
  why: z.xor([z.null(), z.string().min(1).refine((text) => [...text].length <= 2_000).meta({ maxLength: 2_000 })])
    .meta({ description: "The account's latest active why on one of the counted commits; null without one." }),
  series: z.null().meta({ description: "Price history for the sparkline: deferred (OA-11)." }),
});

/** Older UI fixtures may omit why; the published response always includes it. */
export type ProfileCall = Readonly<Omit<z.infer<typeof profileCallSchema>, "why"> & {
  why?: z.infer<typeof profileCallSchema>["why"];
}>;

export const profileTrackRecordSchema = z.strictObject({
  presales_backed: profileInteger,
  launched: profileInteger,
  pnl_usd: z.xor([z.null(), profileSignedUsd]),
});

export type ProfileTrackRecord = Readonly<z.infer<typeof profileTrackRecordSchema>>;

export const socialProfileCallsSchema = z.strictObject({
  calls: z.array(profileCallSchema).max(PROFILE_CALLS_MAX),
  track_record: profileTrackRecordSchema,
  as_of: socialAsOfSchema,
}).meta({
  title: "Social profile calls",
  description: "GET /api/social/profiles/{callsign}/calls 200: the account's presale calls (OA-9: its named commits per presale) and its track record (OA-14). Public: the same for every caller.",
});

export type SocialProfileCalls = Readonly<Omit<z.infer<typeof socialProfileCallsSchema>, "calls"> & {
  calls: readonly ProfileCall[];
}>;

export const profileMutualSchema = z.strictObject({
  callsign: socialCallsignSchema,
  display_name: nullableProfileText,
  avatar_url: nullableProfileText,
});

export type ProfileMutual = Readonly<z.infer<typeof profileMutualSchema>>;

export const socialProfileMutualsSchema = z.strictObject({
  accounts: z.array(profileMutualSchema).max(3),
  total: profileInteger,
}).meta({
  title: "Social profile mutuals",
  description: "GET /api/social/profiles/{callsign}/mutuals 200 (private, no-store): up to three accounts the viewer follows that follow this one, and how many there are.",
});

export type SocialProfileMutuals = Readonly<Omit<z.infer<typeof socialProfileMutualsSchema>, "accounts"> & {
  accounts: readonly ProfileMutual[];
}>;

export type MePresalePosition = PresaleReadonly<z.infer<typeof mePresalePositionSchema>>;
export type MeHoldingCoin = PresaleReadonly<z.infer<typeof meHoldingCoinSchema>>;
export type MeVesting = PresaleReadonly<z.infer<typeof meVestingSchema>>;
export type SocialMePresales = PresaleReadonly<z.infer<typeof socialMePresalesSchema>>;

/** Where the shown picture comes from: the account's source (X or Mission Control), an upload, or none (generated). */
export const PROFILE_PICTURE_CHOICES = ["source", "upload", "none"] as const;
export type ProfilePictureChoice = (typeof PROFILE_PICTURE_CHOICES)[number];

export const socialProfileEditSchema = z.strictObject({
  display_name: nullableProfileText,
  bio: profileBioSchema.optional().meta({ description: "Present when set and requested with ?include_bio=1." }),
  picture: z.enum(PROFILE_PICTURE_CHOICES),
  avatar_url: nullableProfileText,
  source_avatar_url: nullableProfileText,
  upload_available: z.boolean(),
  callsign: z.string().optional(),
  callsign_editable: z.boolean().optional(),
}).meta({
  title: "Social profile edit state",
  description: "GET and PUT /api/social/me/profile, PUT /api/social/me/profile/picture 200 (private, no-store): what the edit sheet shows.",
});

export type SocialProfileEdit = Readonly<z.infer<typeof socialProfileEditSchema>>;

// JSON Schema lengths count Unicode code points, including supplementary characters.
export const socialProfileEditRequestSchema = z.strictObject({
  display_name: z.string().min(1).refine((text) => [...text].length <= 200).meta({ maxLength: 200 }).optional(),
  bio: z.union([profileBioSchema, z.literal("")]).optional(),
  picture: z.enum(["source", "none"]).optional(),
  callsign: z.string().optional(),
}).meta({
  title: "Social profile edit request",
  description: "PUT /api/social/me/profile: display_name, bio (empty clears it), picture, and callsign (new social accounts only). Callsigns are unique across current and previous social identities, Mission Control and reserved names.",
});

export type SocialProfileEditRequest = Readonly<z.infer<typeof socialProfileEditRequestSchema>>;

/** Picture uploads: PNG, JPEG or WebP, at most 2 MiB, stored as a 400×400 WebP. */
export const PROFILE_PICTURE_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const PROFILE_PICTURE_MAX_BYTES = 2 * 1_024 * 1_024;
export const PROFILE_PICTURE_SIDE = 400;
export const PROFILE_PICTURE_MIN_SIDE = 64;

/** `invalid_image`'s `reason`. */
export const PROFILE_PICTURE_REJECTIONS = ["type", "undecodable", "animated", "dimensions"] as const;
export type ProfilePictureRejection = (typeof PROFILE_PICTURE_REJECTIONS)[number];

export function socialProfileCallsPath(callsign: string): string {
  return `/api/social/profiles/${encodeURIComponent(callsign)}/calls`;
}

export function socialProfileThesesPath(callsign: string): string {
  return `/api/social/profiles/${encodeURIComponent(callsign)}/theses`;
}

export function socialProfileMutualsPath(callsign: string): string {
  return `/api/social/profiles/${encodeURIComponent(callsign)}/mutuals`;
}
