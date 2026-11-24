import { feedItemBackerSchema, type FeedReadonly } from "./items.ts";
import { z } from "zod";

import { SOCIAL_CALLSIGN_PATTERN } from "./accounts.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * `POST /api/social/viewer-state`: what the signed-in caller has done to the
 * items, accounts and presales on their screen. Public feed payloads carry no
 * viewer field; a client asks for this separately. JSON Schemas:
 * `schemas/viewer-state-request.schema.json` and
 * `schemas/viewer-state-response.schema.json`.
 *
 * - Body: a closed object with any of `entry_ids`, `callsigns` and
 *   `presale_ids`, each at most `VIEWER_STATE_MAX_IDS` well-formed ids. A
 *   longer list, a malformed id or an unknown key is `400 invalid_request`.
 * - Account required (`401 unauthorized`, `409 account_required`), bucket
 *   `social_read`.
 * - Every answer, errors included, is `Cache-Control: private, no-store`.
 * - Read on the primary, so the caller's own follow or reaction shows at once.
 *
 * The answer names every requested id: `reactions[entry_id]` is the caller's
 * reaction keys on that item (sorted, `[]` when none); `follows` maps each
 * requested callsign and presale id to whether the caller follows it (`false`
 * for an unknown one); `backers[presale_id]`, for each id in `backers_of`, is
 * how many accounts the caller follows are named backers of that presale and
 * up to `VIEWER_STATE_BACKER_FACES` of them, the largest first (a post's
 * facepile shows them first: "7 people you follow and 1,005 others are in",
 * FEATURE-MAP §3.5). The naming rule applies, as on the public posts.
 * `follows_you[callsign]`, for each callsign in `follows_you`, is whether that
 * account follows the caller (the live tape's "Follows you" tag, §17; `false`
 * for an unknown callsign or the caller's own).
 */
export const SOCIAL_VIEWER_STATE_ROUTE = "POST /api/social/viewer-state";
export const SOCIAL_VIEWER_STATE_PATH = "/api/social/viewer-state";

/** Each list in a viewer-state request holds at most this many ids. */
export const VIEWER_STATE_MAX_IDS = 50;

/** A feed entry id: `a:`, `l:` or `m:` and its printable, space-free rest. */
export const SOCIAL_ENTRY_ID_PATTERN = /^[alm]:[!-~]{1,250}$/;

/** At most this many followed backers per presale come back with their identity. */
export const VIEWER_STATE_BACKER_FACES = 6;

const entryIds = z.array(z.string().regex(SOCIAL_ENTRY_ID_PATTERN)).max(VIEWER_STATE_MAX_IDS);
const callsigns = z.array(z.string().regex(SOCIAL_CALLSIGN_PATTERN)).max(VIEWER_STATE_MAX_IDS);
const presaleIds = z.array(z.string().regex(SUI_OBJECT_ID_PATTERN)).max(VIEWER_STATE_MAX_IDS);

export const socialViewerStateRequestSchema = z
  .strictObject({
    entry_ids: entryIds.optional(),
    callsigns: callsigns.optional(),
    presale_ids: presaleIds.optional(),
    backers_of: presaleIds.describe("Presales whose followed named backers are wanted.").optional(),
    follows_you: callsigns.describe("Accounts whose 'Follows you' tag is wanted.").optional(),
    buyers_of: presaleIds.describe("Presales whose followed named backers are wanted.").optional(),
  })
  .meta({
    title: "Social viewer-state request",
    description: `POST /api/social/viewer-state body. Closed; every list is optional and holds at most ${VIEWER_STATE_MAX_IDS} ids. A longer list, a malformed id or an unknown key is 400 invalid_request.`,
  });

type ViewerStateRequest = z.infer<typeof socialViewerStateRequestSchema>;
export type SocialViewerStateRequest = {
  readonly [Field in keyof ViewerStateRequest]: Readonly<ViewerStateRequest[Field]>;
};

/** The followed named backers of one presale. */
export type SocialViewerBackers = FeedReadonly<
  z.infer<typeof socialViewerStateResponseSchema.shape.backers.valueType>
>;

export type SocialViewerStateResponse = FeedReadonly<
  z.infer<typeof socialViewerStateResponseSchema>
>;

export const socialViewerStateResponseSchema = z
  .strictObject({
    reactions: z.record(
      z.string().regex(/^[alm]:[!-~]{1,250}$/),
      z
        .array(z.string().regex(/^[a-z][a-z0-9_]{0,31}$/))
        .refine((values) => new Set(values).size === values.length)
        .meta({ uniqueItems: true }),
    ),
    follows: z.strictObject({
      accounts: z.record(z.string().regex(/^[a-z0-9][a-z0-9_]{1,18}[a-z0-9]$/), z.boolean()),
      presales: z.record(z.string().regex(SUI_OBJECT_ID_PATTERN), z.boolean()),
    }),
    backers: z.record(
      z.string().regex(SUI_OBJECT_ID_PATTERN),
      z.strictObject({
        count: z.number().min(0).refine(Number.isInteger).meta({ type: "integer" }),
        accounts: z.array(feedItemBackerSchema).max(6),
      }),
    ),
    follows_you: z.record(z.string().regex(/^[a-z0-9][a-z0-9_]{1,18}[a-z0-9]$/), z.boolean()).meta({
      description: "Per requested follows_you callsign: whether that account follows the caller.",
    }),
    buyers: z
      .record(
        z.string().regex(SUI_OBJECT_ID_PATTERN),
        z.strictObject({
          count: z.number().min(0).refine(Number.isInteger).meta({ type: "integer" }),
          accounts: z.array(feedItemBackerSchema).max(3),
        }),
      )
      .optional(),
  })
  .meta({
    title: "Social viewer state of the caller",
    description:
      "POST /api/social/viewer-state 200 (Cache-Control: private, no-store): the caller's reaction keys per requested entry id, whether the caller follows each requested callsign and presale id, and, per requested backers_of presale, how many named backers the caller follows and up to six of them. Every requested id is present, and per requested follows_you callsign whether that account follows the caller.",
  });
