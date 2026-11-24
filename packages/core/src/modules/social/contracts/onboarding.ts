import { z } from "zod";

import { SOCIAL_CALLSIGN_PATTERN } from "./accounts.ts";
import { socialUuidSchema } from "./primitives.ts";
import { SOCIAL_PRIVACY } from "./me.ts";

/**
 * Onboarding of an account that exists but has not finished onboarding
 * (account required, bucket `social_account_update`, `Cache-Control:
 * private, no-store`).
 *
 * `POST /api/social/onboarding/shown` (no body): records that the component
 * was shown and, once per account, applies the default follows and the
 * launch-code follow in the same transaction. It answers the account's
 * current follows whose source is `default` or `launch_code`. A repeat call
 * changes nothing; a follow the account removed is never re-added.
 * JSON Schema: `schemas/onboarding-shown-response.schema.json`.
 *
 * `POST /api/social/onboarding/complete { private }`: finishes onboarding.
 * `private: false` makes the account public and starts sharing at the
 * server's time; `private: true` makes it private with no sharing start. If
 * the shown step never ran, it runs first in the same transaction. An
 * account that already finished keeps its state and gets it back unchanged.
 * JSON Schemas: `schemas/onboarding-complete-request.schema.json` and
 * `schemas/onboarding-complete-response.schema.json`.
 */

export const SOCIAL_ONBOARDING_FOLLOW_SOURCES = ["launch_code", "default"] as const;
/** `launch_code`: the owner of the member code the account joined with. `default`: an operator-chosen account. */
export type SocialOnboardingFollowSource = (typeof SOCIAL_ONBOARDING_FOLLOW_SOURCES)[number];

// The published response has local references. Scope their names to this document.
export const onboardingShownSchemaMetadata = z.registry<z.core.JSONSchemaMeta>();
const nullableText = z.xor([z.null(), z.string().min(1)])
  .register(onboardingShownSchemaMetadata, { id: "nullableText" });

const onboardingFollowSchema = z.strictObject({
  account_id: socialUuidSchema,
  callsign: z.string().regex(SOCIAL_CALLSIGN_PATTERN),
  display_name: nullableText,
  avatar_url: nullableText,
  x_handle: nullableText,
  source: z.enum(SOCIAL_ONBOARDING_FOLLOW_SOURCES),
}).register(onboardingShownSchemaMetadata, { id: "follow" });

export type SocialOnboardingFollow = Readonly<z.infer<typeof onboardingFollowSchema>>;

export const socialOnboardingShownResponseSchema = z.strictObject({
  follows: z.array(onboardingFollowSchema),
}).register(onboardingShownSchemaMetadata, {
  title: "Onboarding follows of the caller",
  description: "POST /api/social/onboarding/shown 200: the caller's current follows whose source is launch_code or default, the launch-code follow first, then the defaults in their configured order. Each follow carries the target's linked X handle (null without X): OA-8, a linked X account is verified.",
});

/** The launch-code follow first, then the defaults in their configured order. */
export type SocialOnboardingShownResponse = Readonly<{
  follows: Readonly<z.infer<typeof socialOnboardingShownResponseSchema>["follows"]>;
}>;

export const socialOnboardingCompleteRequestSchema = z.strictObject({
  private: z.boolean(),
}).meta({
  title: "Onboarding completion",
  description: "POST /api/social/onboarding/complete body. Closed. private: false starts sharing at the server's time; private: true shares nothing.",
});

export type SocialOnboardingCompleteRequest = Readonly<z.infer<typeof socialOnboardingCompleteRequestSchema>>;

export const socialOnboardingCompleteResponseSchema = z.strictObject({
  onboarding: z.strictObject({
    shown: z.literal(true),
    completed: z.literal(true),
  }),
  privacy: z.enum(SOCIAL_PRIVACY),
  sharing_since_ms: z.xor([
    z.null(),
    z.number().nonnegative().refine(Number.isInteger).meta({ type: "integer" }),
  ]),
}).meta({
  title: "Onboarding state after completion",
  description: "POST /api/social/onboarding/complete 200: the stored privacy and sharing start. An account that had already finished gets its current state back unchanged.",
});

export type SocialOnboardingCompleteResponse = Readonly<z.infer<typeof socialOnboardingCompleteResponseSchema>>;

export const SOCIAL_ONBOARDING_SHOWN_ROUTE = "POST /api/social/onboarding/shown";
export const SOCIAL_ONBOARDING_SHOWN_PATH = "/api/social/onboarding/shown";
export const SOCIAL_ONBOARDING_COMPLETE_ROUTE = "POST /api/social/onboarding/complete";
export const SOCIAL_ONBOARDING_COMPLETE_PATH = "/api/social/onboarding/complete";

/** How many default accounts the operator configures (`social:operator defaults set`). */
export const SOCIAL_DEFAULT_ACCOUNT_COUNT = 5;
