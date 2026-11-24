import { z } from "zod";

/**
 * The "why" text rules (T-021, spec AC-077 and AC-078), shared by every path
 * that stores a why: the why route, the intents route and the worker's why
 * attachment, and by the browser's why box (its counter and inline errors).
 * The same Zod schema runs on the server and in the client.
 *
 * Blocked terms are not checked here: they live in the database
 * (`findBlockedTerm`, cached 30 s), so a server path checks them after this.
 */

/** The longest why, in Unicode code points. */
export const WHY_MAX_CODE_POINTS = 280;

/** A why is written within 24 hours of its item's `occurred_at_ms`. */
export const WHY_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** An item holds at most this many why records in any state (active, deleted, removed). */
export const WHY_RECORDS_PER_ITEM = 3;

/** Why a text is refused, as the published error code. */
export type WhyTextRefusal = "why_empty" | "why_too_long" | "why_invalid" | "why_has_link";

export type WhyValidation = Readonly<{ ok: true; text: string }> | Readonly<{ ok: false; code: WhyTextRefusal }>;

/**
 * A link: `http://` or `https://`, `www.`, or a dot-separated host whose last
 * label is a top-level domain of 2 to 24 letters (`blast.fun`), in any case.
 * `v2.0` is not a link (its last label is a digit).
 */
const LINK = /https?:\/\/|www\.|\b[a-z0-9-]+\.[a-z]{2,24}\b/i;

/** Line breaks (any Unicode line terminator) and other control characters: a why is one plain line. */
const NOT_ONE_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** The text's length in Unicode code points (what the counter shows). */
export function whyLength(text: string): number {
  return [...text].length;
}

/**
 * Normalizes `text` (NFC, then trimmed) and checks it, in order: empty is
 * `why_empty`; a line break or another control character is `why_invalid`;
 * more than 280 code points is `why_too_long`; a link is `why_has_link`.
 * Returns the normalized text to store when it passes.
 */
export const whyTextSchema = z.string().transform((text) => text.normalize("NFC").trim())
  .refine((text) => text.length > 0, { message: "why_empty" })
  .refine((text) => !NOT_ONE_LINE.test(text), { message: "why_invalid" })
  .refine((text) => whyLength(text) <= WHY_MAX_CODE_POINTS, { message: "why_too_long" })
  .refine((text) => !LINK.test(text), { message: "why_has_link" });

export function validateWhy(text: string): WhyValidation {
  const parsed = whyTextSchema.safeParse(text);
  if (parsed.success) return { ok: true, text: parsed.data };
  return { ok: false, code: parsed.error.issues[0]!.message as WhyTextRefusal };
}
