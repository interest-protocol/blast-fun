import { z } from "zod";
import {
  socialAsOfSchema,
  feedItemMillisSchema,
  feedItemUsdSchema,
  feedItemAccountActorSchema,
  feedItemAddressActorSchema,
  type FeedReadonly,
} from "./items.ts";
import { SUI_OBJECT_ID_PATTERN } from "@blast/core/lib/sui/ids.ts";

/**
 * `GET /api/social/activity`: Recent activity, the newest commits and claims
 * (and trades while trading is visible) across every sale the web shows,
 * newest first, one keyset page at a time (R3-57: Blast mode's ticker and its
 * Recent activity popover). JSON Schema: `schemas/activity-page.schema.json`.
 *
 * - No authentication; the Authorization header and the wallet cookie are
 *   never read. Every answer is the same for every caller, so a 200 is
 *   publicly cached (`public, s-maxage=10, stale-while-revalidate=20`) and
 *   carries no viewer field.
 * - Read on the replica, only through `chain_read_v1` views; bucket
 *   `social_read` (IP).
 * - **Only shown sales.** Every row belongs to a sale `SHOWN_PRESALES`
 *   returns: a commit or claim by its `presale_id`, a trade by its coin being
 *   that sale's coin. `chain_read_v1.activity` is deliberately not filtered by
 *   blast-infra's excluded-sale list (T-043), so the read drops a hidden sale's
 *   rows itself, inside the page scan: a page is never short because of them.
 * - Bounded by the watermark: presale kinds up to the presale pipeline's
 *   committed checkpoint, trades up to the market pipeline's, and nothing after
 *   the chain clock (the earlier of the presale pipeline's time and the
 *   server's). With no readable watermark the read is `503`.
 * - Keyset paging, never OFFSET: `?before=<next_cursor>` reads the rows after
 *   (older than) a page. The cursor is `<timestamp_ms>:<checkpoint>:<tx_slot>:
 *   <event_slot>:<part>`, the rows' total order; any other `before` is `400
 *   invalid_parameter`. Other query parameters are ignored.
 *
 * The client reads the first page again on its own schedule (the activity hint
 * and the 30 s poll, R3-26) and pages back only to fill a gap.
 */
export const SOCIAL_ACTIVITY_ROUTE = "GET /api/social/activity";
export const SOCIAL_ACTIVITY_PATH = "/api/social/activity";

/** A page holds this many events (the popover's 30 rows). */
export const ACTIVITY_PAGE_SIZE = 30;

/** The kinds the read returns; the trade kinds only while trading is visible (OA-7). */
export const ACTIVITY_KINDS = [
  "presale_commit",
  "presale_claim",
  "trade_buy",
  "trade_sell",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** `<timestamp_ms>:<checkpoint>:<tx_slot>:<event_slot>:<part>`, each a plain non-negative integer. */
export const ACTIVITY_CURSOR_PATTERN =
  /^(0|[1-9][0-9]{0,15}):(0|[1-9][0-9]{0,18}):(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,9})$/;

/** One row of Recent activity: who did what, in which sale, when. */
export type SocialActivityEvent = FeedReadonly<z.infer<typeof activityPageEventSchema>>;

export type SocialActivityPage = FeedReadonly<z.infer<typeof socialActivityPageSchema>>;

export const activityPageWholeUnitsSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$/)
  .meta({ description: "A non-negative plain decimal in whole units." });

export const activityPageEventSchema = z.strictObject({
  activity_id: z.string().regex(/^[0-9]+:[0-9]+:[0-9]+:[0-9]+$/),
  kind: z.enum(["presale_commit", "presale_claim", "trade_buy", "trade_sell"]),
  occurred_at_ms: feedItemMillisSchema,
  actor: z.xor([feedItemAccountActorSchema, feedItemAddressActorSchema]).meta({
    description: "Named by the naming rule at the event, else the wallet only.",
  }),
  presale_id: z
    .string()
    .regex(SUI_OBJECT_ID_PATTERN)
    .meta({
      description: "The shown sale the row belongs to; a trade's is the sale whose coin it is.",
    }),
  sale_name: z.string(),
  symbol: z.string(),
  quote_symbol: z.string(),
  usd: z.xor([z.null(), feedItemUsdSchema]).meta({
    description:
      "A commit's or a trade's USD amount, a claim's refund in USD; null when the indexer priced none.",
  }),
  quote: z.xor([z.null(), activityPageWholeUnitsSchema]).meta({
    description: "A commit's or a trade's quote amount in whole quote units; null for a claim.",
  }),
  tokens: z.xor([z.null(), activityPageWholeUnitsSchema]).meta({
    description: "Whole sale tokens: a claim's delivered tokens or a trade's coin quantity.",
  }),
  refund: z
    .xor([z.null(), activityPageWholeUnitsSchema])
    .meta({ description: "A claim's refund in whole quote units." }),
});

export const socialActivityPageSchema = z
  .strictObject({
    events: z.array(activityPageEventSchema).max(30),
    next_cursor: z
      .xor([
        z.null(),
        z
          .string()
          .regex(
            /^(0|[1-9][0-9]{0,15}):(0|[1-9][0-9]{0,18}):(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,9}):(0|[1-9][0-9]{0,9})$/,
          ),
      ])
      .meta({
        description:
          "The before parameter of the next (older) page: <timestamp_ms>:<checkpoint>:<tx_slot>:<event_slot>:<part>. Null when this page reached the end.",
      }),
    as_of: socialAsOfSchema,
  })
  .meta({
    title: "Recent activity",
    description:
      "GET /api/social/activity 200 (Cache-Control: public, s-maxage=10, stale-while-revalidate=20): one keyset page of the newest commits and claims (and trades while trading is visible) across every sale the web shows, newest first, bounded by the watermark. The same for every caller; no viewer field.",
  });

export const activityPageDefinitions = {
  wholeUnits: activityPageWholeUnitsSchema,
  event: activityPageEventSchema,
} as const;
