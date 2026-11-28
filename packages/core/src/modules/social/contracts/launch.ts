import { SUI_OBJECT_ID_PATTERN } from "../../../lib/sui/ids.ts";
import { z } from "zod";
import { createDraftResponseSchema } from "./create.ts";
import { MIGRATOR_VENUES } from "../../launchpad-contract/venues.ts";
import type { LaunchRules } from "@blast/core/modules/social/launch/model.ts";

/**
 * Launch (`/launch`, a bonding-curve coin): the signed-in account's launch
 * drafts, kept on the server so they autosave, resume on another device and
 * make publishing idempotent, and the publish plan that turns a finished
 * draft into its three transactions. Every route is the account's own data:
 * `auth: "account"`, an account required, `Cache-Control: private, no-store`.
 *
 * - `GET /api/social/me/launches`: the account's unpublished drafts, most
 *   recently saved first (at most `LAUNCH_DRAFT_LIMIT`).
 * - `GET /api/social/me/launches/{id}`: one draft (`LaunchDraftResponse`).
 * - `PUT /api/social/me/launches/{id}` `{ version, draft }`: creates at
 *   `version: 0` or replaces at the stored version; another version is
 *   `409 draft_conflict` with the stored draft in `error.draft`.
 * - `DELETE /api/social/me/launches/{id}`: removes an unpublished draft (204).
 * - `PUT /api/social/me/launches/{id}/logo`: the coin's image (PNG, JPEG or
 *   WebP, at most 2 MiB), stored as a 512 px WebP; answers the draft.
 * - `POST /api/social/me/launches/{id}/cover` (multipart `cover`) and
 *   `DELETE`: the 3:1 cover the coin page shows; answers the draft.
 * - `POST /api/social/me/launches/{id}/publish` `{ version, step, creator,
 *   coin?, fee? }`: one transaction of the plan, built by the server from the
 *   stored draft (sponsored for a Blast wallet), or `409 publish_unavailable`.
 * - `POST /api/social/me/launches/{id}/published` `{ launch_id }`: records
 *   the launch the draft became; once only.
 * - `GET /api/social/launch-context` (server render only): the rules and the
 *   quotes and venues offered now.
 */

export const SOCIAL_LAUNCH_DRAFTS_PATH = "/api/social/me/launches";
export const SOCIAL_LAUNCH_CONTEXT_PATH = "/api/social/launch-context";
export const SOCIAL_LAUNCH_DRAFTS_ROUTE = "GET /api/social/me/launches";
export const SOCIAL_LAUNCH_DRAFT_READ_ROUTE = "GET /api/social/me/launches/{id}";
export const SOCIAL_LAUNCH_DRAFT_SAVE_ROUTE = "PUT /api/social/me/launches/{id}";
export const SOCIAL_LAUNCH_DRAFT_DELETE_ROUTE = "DELETE /api/social/me/launches/{id}";
export const SOCIAL_LAUNCH_DRAFT_LOGO_ROUTE = "PUT /api/social/me/launches/{id}/logo";
export const SOCIAL_LAUNCH_DRAFT_COVER_ROUTE = "POST /api/social/me/launches/{id}/cover";
export const SOCIAL_LAUNCH_DRAFT_COVER_DELETE_ROUTE = "DELETE /api/social/me/launches/{id}/cover";
export const SOCIAL_LAUNCH_DRAFT_PUBLISH_ROUTE = "POST /api/social/me/launches/{id}/publish";
export const SOCIAL_LAUNCH_DRAFT_PUBLISHED_ROUTE = "POST /api/social/me/launches/{id}/published";

export const socialLaunchDraftPath = (id: string): string => `${SOCIAL_LAUNCH_DRAFTS_PATH}/${encodeURIComponent(id)}`;
export const socialLaunchDraftLogoPath = (id: string): string => `${socialLaunchDraftPath(id)}/logo`;
export const socialLaunchDraftCoverPath = (id: string): string => `${socialLaunchDraftPath(id)}/cover`;
export const socialLaunchDraftPublishPath = (id: string): string => `${socialLaunchDraftPath(id)}/publish`;
export const socialLaunchDraftPublishedPath = (id: string): string => `${socialLaunchDraftPath(id)}/published`;

/** A save body is at most 16 KiB (32 recipients with labels fit in about 6 KiB). */
export const LAUNCH_DRAFT_BODY_LIMIT_BYTES = 16 * 1_024;
/** The most unpublished launch drafts one account keeps. */
export const LAUNCH_DRAFT_LIMIT = 10;
export type LaunchDraftResponse = Readonly<z.infer<typeof launchDraftResponseSchema>>;
export type LaunchDraftSummary = Readonly<z.infer<typeof launchDraftSummarySchema>>;
export type LaunchDraftList = Readonly<z.infer<typeof launchDraftListSchema>>;

export const LAUNCH_PUBLISH_STEPS = ["publish_coin", "register_currency", "create_launch"] as const;
export type LaunchPublishStepKind = (typeof LAUNCH_PUBLISH_STEPS)[number];

/** An owned object as a publish step's effects name it. */
export type LaunchOwnedObject = Readonly<{ object_id: string; version: string; digest: string }>;

/**
 * What the client read from earlier steps' effects: the coin type, the
 * `LaunchTicket` the publish transferred to the creator, and the `Currency`
 * (its `Receiving` reference before registration, its shared version after).
 */
export type LaunchPublishCoin = Readonly<{
  coin_type: string;
  ticket?: LaunchOwnedObject;
  sealed_treasury_cap?: LaunchOwnedObject;
  currency: LaunchOwnedObject | Readonly<{ object_id: string; initial_shared_version: string }>;
}>;

export type LaunchPublishStep = Readonly<z.infer<typeof launchPublishStepSchema>>;
export type LaunchPublishPlan = Readonly<z.infer<typeof launchPublishPlanSchema>>;

/** Why a publish plan is unavailable now. */
export const LAUNCH_PUBLISH_BLOCKERS = ["launchpad_not_deployed", "launch_config", "quote_not_admitted", "venue_not_admitted", "template_unavailable"] as const;
export type LaunchPublishBlocker = (typeof LAUNCH_PUBLISH_BLOCKERS)[number];

/** What the page needs before any draft loads: the rules, or why launching is off. */
export type LaunchPageContext = Readonly<{
  rules: LaunchRules | null;
  creator_x_available?: boolean;
  publish: Readonly<{ available: boolean; reasons: readonly LaunchPublishBlocker[] }>;
}>;

const launchBpsSchema = z.number().int().min(0).max(10_000);
const launchAmountSchema = z.number().min(0).max(1_000_000_000)
  .refine((value) => Number(value.toFixed(4)) === value);
const launchRecipientSchema = z.strictObject({
  label: z.string().max(40), address: z.string().max(66), bps: launchBpsSchema,
});

/** Stored drafts have already been normalized; incomplete form values remain valid. */
export const launchDraftSchema = z.strictObject({
  name: z.string().max(128), symbol: z.string().max(32).regex(/^[A-Z0-9_]*$/),
  description: z.string().max(1_024), decimals: z.number().int().min(0).max(18),
  burnable: z.boolean(), sell_burn_bps: z.number().int().min(0).max(5_000),
  quote_type: z.string().max(512), virtual_quote: launchAmountSchema,
  graduation_target: launchAmountSchema, curve_bps: launchBpsSchema, pool_bps: launchBpsSchema,
  recipients: z.array(launchRecipientSchema).max(16).readonly(),
  venue: z.enum(MIGRATOR_VENUES), pool_fee: z.number().int().min(1).max(1_000_000),
  creator_fee_bps: launchBpsSchema, creator_x_handle: z.string().max(64).optional(), holders_fee_bps: launchBpsSchema,
  auto_lp_fee_bps: launchBpsSchema, burn_fee_bps: launchBpsSchema,
  fee_recipients: z.array(launchRecipientSchema).max(16).readonly(), first_buy: launchAmountSchema,
  tagline: z.string().max(160), site: z.string().max(2_048),
  x_handle: z.string().max(64), telegram: z.string().max(64),
  docs_url: z.string().max(2_048), audit_url: z.string().max(2_048),
});

export const launchRulesSchema = z.strictObject({
  meme_decimals: z.array(z.number().int().min(0).max(255)).readonly(),
  quote_fee_bps: launchBpsSchema, meme_fee_bps: launchBpsSchema,
  protocol_meme_bps: launchBpsSchema, protocol_quote_bps: launchBpsSchema,
  creation_fee: z.string().regex(/^(0|[1-9][0-9]*)$/), protocol_fee_share_bps: launchBpsSchema,
  pool_fee_meme_bps: launchBpsSchema, pool_fee_quote_bps: launchBpsSchema,
  quotes: z.array(z.string()).readonly(),
  cetus_tiers: createDraftResponseSchema.shape.cetus_tiers.unwrap(),
  bluefin_options: createDraftResponseSchema.shape.bluefin_options.unwrap(),
});

export const launchDraftSummarySchema = z.strictObject({
  draft_id: z.string().uuid(), version: z.number().int().positive(),
  updated_at_ms: z.number().int().nonnegative(), name: z.string(), symbol: z.string(),
  logo_url: z.string().nullable(),
});
export const launchDraftListSchema = z.strictObject({
  drafts: z.array(launchDraftSummarySchema).max(LAUNCH_DRAFT_LIMIT).readonly(),
});
export const launchDraftResponseSchema = launchDraftSummarySchema.omit({ name: true, symbol: true }).extend({
  created_at_ms: z.number().int().nonnegative(), draft: launchDraftSchema,
  publishing: z.boolean(), cover: createDraftResponseSchema.shape.cover,
  published_launch_id: z.string().regex(SUI_OBJECT_ID_PATTERN).nullable(),
  issues: z.array(z.strictObject({
    section: z.enum(["coin", "curve", "split", "pool", "fees", "details", "buy"]),
    path: z.string(), message: z.string(),
  })).readonly(),
  rules: launchRulesSchema,
});

export const launchPublishStepSchema = z.strictObject({
  kind: z.enum(LAUNCH_PUBLISH_STEPS), transaction: z.string().min(1),
  sponsorship: z.strictObject({ reservation_id: z.string().uuid(), transaction_bytes: z.string().min(1) }).optional(),
});
export const launchPublishPlanSchema = z.strictObject({
  draft_id: z.string(), version: z.number().int().positive(),
  launchpad_original_package_id: z.string().regex(SUI_OBJECT_ID_PATTERN),
  core_original_package_id: z.string().regex(SUI_OBJECT_ID_PATTERN).optional(),
  deployment_fingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  steps: z.tuple([launchPublishStepSchema]).readonly(),
});

/** Signing requires deployment provenance; byte decoding remains in the signing verifier. */
export const launchSigningPublishPlanSchema = z.object({
  ...launchPublishPlanSchema.shape,
  core_original_package_id: launchPublishPlanSchema.shape.core_original_package_id.unwrap(),
  deployment_fingerprint: launchPublishPlanSchema.shape.deployment_fingerprint.unwrap(),
  steps: z.array(z.object(launchPublishStepSchema.shape)).length(1),
});

/** First-party projection accepts additive fields just as the signing reader does. */
export const launchPublishResponseSchema = z.object({
  ...launchPublishPlanSchema.shape,
  steps: z.tuple([z.object(launchPublishStepSchema.shape)]).readonly(),
});
