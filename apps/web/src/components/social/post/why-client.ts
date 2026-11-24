import { z } from "zod";
import { diagnosticMessage } from "#web/lib/errors.ts";
import {
  socialItemWhyPath,
  socialWhyCreatedSchema,
  socialWhyPath,
  socialWhyReportedSchema,
  socialWhyReportsPath,
  type SocialWhyCreated,
  type SocialWhyReported,
} from "@blast/core/web/contracts/whys.ts";
import type { WhyTextRefusal } from "@blast/core/modules/social/whys/validate.ts";

import { callSocialApi, type ApiResult, type SocialApiOptions } from "#web/components/social/social-api.ts";

/**
 * The post card's why writes, through the shared signed-in call
 * (`callSocialApi`: the viewer's Privy token, or the wallet session cookie,
 * OA-16), never cached. A why's text and a report's reason never leave this
 * module except in the request body.
 */

/** A `204` answer: `callSocialApi` reads no body from it. */
const noContentSchema = z.null();

/** `POST /api/social/items/{entry_id}/why`: 201 with the stored why. */
export function addWhy(options: SocialApiOptions, entryId: string, text: string): Promise<ApiResult<SocialWhyCreated>> {
  return callSocialApi(options, socialItemWhyPath(entryId), { method: "POST", body: { text } }, socialWhyCreatedSchema);
}

/** `DELETE /api/social/whys/{why_id}`: 204, and the author may write a new why inside the window (T-022). */
export function deleteWhy(options: SocialApiOptions, whyId: string): Promise<ApiResult<null>> {
  return callSocialApi(options, socialWhyPath(whyId), { method: "DELETE" }, noContentSchema);
}

/**
 * `POST /api/social/whys/{why_id}/reports`: 201 the first time, 200 when this
 * account already reported it (the card says the same thing either way). The
 * design's menu item sends no reason (§3.7); the route takes an optional one.
 */
export function reportWhy(options: SocialApiOptions, whyId: string, reason?: string): Promise<ApiResult<SocialWhyReported>> {
  const trimmed = reason?.trim();
  return callSocialApi(
    options,
    socialWhyReportsPath(whyId),
    { method: "POST", body: trimmed ? { reason: trimmed } : {} },
    socialWhyReportedSchema,
  );
}

/** The why box's words for a text the shared rules refuse (the design's two, then ours). */
export const WHY_TEXT_MESSAGES: Readonly<Record<WhyTextRefusal, string>> = {
  why_has_link: "Links aren’t allowed in a why.",
  why_too_long: "Keep it to 280 characters.",
  why_invalid: "Keep it to one line.",
  why_empty: "Write your why first.",
};

/** The why box's words for a refused or failed publish; each says what happened and what is left to do. */
export function addWhyFailureMessage(result: Exclude<ApiResult<unknown>, { status: "ok" }>): string {
  if (result.status !== "refused") return diagnosticMessage("Couldn’t post your why. Check your connection and try again.", result);
  switch (result.code) {
    case "why_has_link":
    case "why_too_long":
    case "why_invalid":
    case "why_empty":
      return diagnosticMessage(WHY_TEXT_MESSAGES[result.code], result);
    case "blocked_term":
      return diagnosticMessage("That why contains a word that is not allowed.", result);
    case "why_window_closed":
      return diagnosticMessage("A why can be added only within 24 hours of the post.", result);
    case "why_exists":
      return diagnosticMessage("This post already has a why. Reload to see it.", result);
    case "why_removed":
      return diagnosticMessage("The Blast team removed this post’s why, so it can’t take another.", result);
    case "why_limit":
      return diagnosticMessage("This post has had all the whys it can take.", result);
    case "not_author":
      return diagnosticMessage("Only the author can add a why to this post.", result);
    case "not_found":
      return diagnosticMessage("This post is no longer shown.", result);
    case "rate_limited":
      return diagnosticMessage("You’ve posted a lot of whys. Try again later.", result);
    case "unauthorized":
      return diagnosticMessage("Sign in again to post your why.", result);
    default:
      return diagnosticMessage("Couldn’t post your why. Try again.", result);
  }
}

/** The toast for a delete the route refused or the network lost (T-022). */
export function deleteWhyFailureMessage(result: Exclude<ApiResult<unknown>, { status: "ok" }>): string {
  if (result.status !== "refused") return diagnosticMessage("Couldn’t delete your why. Check your connection and try again.", result);
  switch (result.code) {
    case "not_found":
      return diagnosticMessage("This why is no longer shown.", result);
    case "not_author":
      return diagnosticMessage("Only the author can delete this why.", result);
    case "why_removed":
      return diagnosticMessage("The Blast team removed this why.", result);
    case "rate_limited":
      return diagnosticMessage("You’ve changed a lot of whys. Try again later.", result);
    case "unauthorized":
      return diagnosticMessage("Sign in again to delete your why.", result);
    default:
      return diagnosticMessage("Couldn’t delete your why. Try again.", result);
  }
}

/** The toast for a report the route refused or the network lost (T-022). */
export function reportWhyFailureMessage(result: Exclude<ApiResult<unknown>, { status: "ok" }>): string {
  if (result.status !== "refused") return diagnosticMessage("Couldn’t send your report. Check your connection and try again.", result);
  switch (result.code) {
    case "not_found":
      return diagnosticMessage("This why is no longer shown.", result);
    case "cannot_report_self":
      return diagnosticMessage("You can’t report your own why.", result);
    case "rate_limited":
      return diagnosticMessage("You’ve reported a lot of whys. Try again later.", result);
    case "unauthorized":
      return diagnosticMessage("Sign in again to report this why.", result);
    default:
      return diagnosticMessage("Couldn’t send your report. Try again.", result);
  }
}

/** What the card says once a report is stored, whether or not this account had already sent one (§3.7). */
export const WHY_REPORTED_TOAST = "Thanks. The Blast team will review it.";

/** What the card says once the author's why is gone. */
export const WHY_DELETED_TOAST = "Why deleted";
