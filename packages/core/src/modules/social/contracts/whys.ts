import { SOCIAL_ITEMS_PREFIX } from "@blast/core/modules/social/contracts/item-routes.ts";
import { z } from "zod";

import { whyLength } from "../whys/validate.ts";

/**
 * A "why": an author's one-line plain-text reason on their own named item
 * (T-021), which its author deletes and any other account reports (T-022).
 * Text rules and limits: `../whys/validate.ts` (`validateWhy`).
 *
 * `POST /api/social/items/{entry_id}/why { text }`: account required, bucket
 * `social_why` (20 per hour per account, shared with deleting a why), written
 * on the primary. `201 { why_id, text }` with the stored (NFC, trimmed) text
 * when the caller's account is the item's named actor (the naming rule, at
 * the request) and the request is within 24 hours of the item's
 * `occurred_at_ms`. Refusals, in the order they are checked:
 *
 * - `400 invalid_parameter` (`parameter: "entry_id"`) for a malformed id;
 *   `400 invalid_request` for a body that is not exactly `{ text: string }`
 *   (schema `why-request`); `413 body_too_large` over 4 KiB;
 * - `422 why_empty`, `why_invalid` (a line break), `why_too_long` (over 280
 *   code points), `why_has_link`, then `422 blocked_term` (`field: "text"`);
 * - `404 not_found` for an item that is not shown (unknown, unnamed and not a
 *   presale post, or a kind the feed hides);
 * - `403 not_author` when the caller is not its named actor;
 * - `409 why_window_closed` after the 24 hours;
 * - `409 why_exists` (the item has an active why), `409 why_removed` (the
 *   Blast team removed one of its whys), `409 why_limit` (3 records in any
 *   state).
 *
 * A why publishes at once and is never edited. Its text and a report's
 * reason never reach a log line or a metric.
 */
export const SOCIAL_WHY_CREATE_ROUTE = "POST /api/social/items/{entry_id}/why";

export const socialWhyCreateRequestSchema = z.strictObject({ text: z.string() }).meta({
  title: "Social why request",
  description:
    "POST /api/social/items/{entry_id}/why body. Closed: exactly text, a string (the body is at most 4 KiB). The text rules (NFC, trimmed, 1 to 280 code points, one line, no link, no blocked term) answer their own 422 codes.",
});

export type SocialWhyCreateRequest = Readonly<z.infer<typeof socialWhyCreateRequestSchema>>;

/** The why route of `entryId`. */
export function socialItemWhyPath(entryId: string): string {
  return `${SOCIAL_ITEMS_PREFIX}${encodeURIComponent(entryId)}/why`;
}

/** Every route of one why record by its id (T-022). */
const SOCIAL_WHYS_PREFIX = "/api/social/whys/";

/**
 * A why id as the routes write it: the lowercase canonical UUID the create
 * route answered (`schemas/why-response.schema.json`). Anything else is
 * `400 invalid_parameter`.
 */
export const SOCIAL_WHY_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const socialWhyIdSchema = z.string().regex(SOCIAL_WHY_ID_PATTERN);

const WHY_RESPONSE_MAX_CODE_POINTS = 1120;

export const socialWhyCreatedSchema = z.strictObject({
  why_id: socialWhyIdSchema,
  text: z.string().min(1)
    .refine((text) => whyLength(text) <= WHY_RESPONSE_MAX_CODE_POINTS)
    .meta({ maxLength: WHY_RESPONSE_MAX_CODE_POINTS }),
}).meta({
  title: "Social why created",
  description: "201 answer of POST /api/social/items/{entry_id}/why: the new why's id and its stored text (NFC, trimmed).",
});

export type SocialWhyCreated = Readonly<z.infer<typeof socialWhyCreatedSchema>>;

/**
 * `DELETE /api/social/whys/{why_id}` (T-022, AC-082): the author retracts
 * their own why. Account required, bucket `social_why` (the same 20 per hour
 * as writing one), written on the primary. `204` with no body; the record is
 * kept with `state = 'deleted'` and `deleted_at`, it leaves every read at
 * once (they join the active why only), and the author may write a new one
 * inside the 24 hours, up to the 3 records an item holds. Refusals, in the
 * order they are checked:
 *
 * - `400 invalid_parameter` (`parameter: "why_id"`) for a malformed id;
 * - `404 not_found` when no why has that id;
 * - `403 not_author` for anyone but its author;
 * - `409 why_removed` when the Blast team removed it (the author does not
 *   turn a removal into a deletion; `social_whys_transition` refuses it too).
 *
 * Retrying is idempotent: a why this author already deleted answers `204`
 * again and writes nothing.
 */
export const SOCIAL_WHY_DELETE_ROUTE = "DELETE /api/social/whys/{why_id}";

/**
 * `POST /api/social/whys/{why_id}/reports { reason? }` (T-022, AC-083): any
 * signed-in account flags someone else's why for the Blast team, once.
 * Account required, bucket `social_report` (30 per hour per account), written
 * on the primary.
 *
 * - `201 { why_id, already_reported: false }` with the report stored;
 * - `200 { why_id, already_reported: true }` when this account already
 *   reported this why: nothing is stored a second time, and the first
 *   report's reason stands (schema `why-report-response`);
 * - `400 invalid_parameter` (`parameter: "why_id"`) for a malformed id;
 * - `400 invalid_request` for a body that is not `{}` or `{ reason: string }`
 *   of at most `WHY_REPORT_MAX_CODE_POINTS` code points (schema
 *   `why-report-request`); `413 body_too_large` over 4 KiB;
 * - `404 not_found` when no why has that id or it is not active (a deleted or
 *   removed why is hidden everywhere, so there is nothing to report);
 * - `422 cannot_report_self` for one's own why.
 *
 * The reason is optional free text, stored NFC-normalized and trimmed, or
 * `null` when it is blank. It is evidence for the Blast team (the report list
 * is T-023), never shown to another member and never read back by this
 * route. Like a why's text, it never reaches a log line or a metric
 * (AC-130).
 */
export const SOCIAL_WHY_REPORT_ROUTE = "POST /api/social/whys/{why_id}/reports";

/** The longest report reason, in Unicode code points. */
export const WHY_REPORT_MAX_CODE_POINTS = 280;

// The published limit describes the submitted value. The route has always
// normalized before applying that limit to the stored value.
const reportReasonSchema = z.string()
  .normalize("NFC")
  .trim()
  .refine((reason) => whyLength(reason) <= WHY_REPORT_MAX_CODE_POINTS)
  .meta({ maxLength: WHY_REPORT_MAX_CODE_POINTS });

export const socialWhyReportRequestSchema = z.strictObject({
  reason: reportReasonSchema.optional(),
}).meta({
  title: "Social why report request",
  description: `POST /api/social/whys/{why_id}/reports body. Closed: an optional reason of at most ${WHY_REPORT_MAX_CODE_POINTS} Unicode code points (the body is at most 4 KiB). A blank reason stores no reason; the stored text is NFC-normalized and trimmed.`,
});

export type SocialWhyReportRequest = Readonly<z.input<typeof socialWhyReportRequestSchema>>;

export const socialWhyReportedSchema = z.strictObject({
  why_id: socialWhyIdSchema,
  already_reported: z.boolean(),
}).meta({
  title: "Social why reported",
  description: "Answer of POST /api/social/whys/{why_id}/reports: the reported why, and whether this account had already reported it (201 with false, 200 with true). The reason is never echoed.",
});

export type SocialWhyReported = Readonly<z.infer<typeof socialWhyReportedSchema>>;

/** One why's own route (`DELETE`). */
export function socialWhyPath(whyId: string): string {
  return `${SOCIAL_WHYS_PREFIX}${encodeURIComponent(whyId)}`;
}

/** One why's reports route (`POST`). */
export function socialWhyReportsPath(whyId: string): string {
  return `${socialWhyPath(whyId)}/reports`;
}
