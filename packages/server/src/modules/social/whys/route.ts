import { createWhy, retractWhy, reportWhy } from "./store.ts";
import { z } from "zod";
import { socialParameter } from "@blast/server/modules/social/route-kit/validation.ts";

import { randomUUID } from "node:crypto";

import { DatabaseError } from "pg";

import type { SocialConfig } from "@blast/core/modules/social/contracts/config.ts";
import { routeParams } from "@blast/core/modules/backend-api/route-path.ts";
import {
  SOCIAL_WHY_PATH,
  SOCIAL_WHY_RECORD_PATH,
  SOCIAL_WHY_REPORTS_PATH,
} from "@blast/core/modules/backend-api/private/social-read-contracts.ts";
import { SOCIAL_ENTRY_ID_PATTERN } from "@blast/core/modules/social/contracts/viewer-state.ts";
import {
  SOCIAL_WHY_CREATE_ROUTE,
  SOCIAL_WHY_DELETE_ROUTE,
  SOCIAL_WHY_REPORT_ROUTE,
  socialWhyCreateRequestSchema,
  socialWhyIdSchema,
  socialWhyReportRequestSchema,
  type SocialWhyCreated,
  type SocialWhyReported,
} from "@blast/core/modules/social/contracts/whys.ts";
import { visibleEntry } from "@blast/server/modules/social/read-model/index.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import {
  readSocialJsonWithSchema,
  type SocialRequestContext,
  type SocialRouteKit,
} from "@blast/server/modules/social/route-kit/route.ts";
import { WHY_WINDOW_MS, validateWhy } from "@blast/core/modules/social/whys/validate.ts";

export type SocialWhyRouteDependencies = Readonly<{
  kit: SocialRouteKit;
  /** The tuning values of this request (`getSocialConfig`): the presale-post thresholds of the visibility check. */
  config: () => Promise<SocialConfig>;
  /** `findBlockedTerm`: the blocked term the text contains, or null (cached 30 s). */
  findBlockedTerm: (text: string) => Promise<string | null>;
  now?: () => number;
  createId?: () => string;
}>;

/** The `{entry_id}` of `/api/social/items/{entry_id}/why`, URL-decoded once; else `invalid_parameter`. */
export function whyEntryParameter(request: Request): string {
  const entryId = routeParams(SOCIAL_WHY_PATH, new URL(request.url).pathname)?.entry_id;
  const parsed = z.string().regex(SOCIAL_ENTRY_ID_PATTERN).safeParse(entryId);
  if (!parsed.success) {
    throw new SocialRouteError("invalid_parameter", { extra: { parameter: "entry_id" } });
  }
  return parsed.data;
}

/**
 * The `{why_id}` of `/api/social/whys/{why_id}` (`withReports`:
 * `…/{why_id}/reports`), URL-decoded once; else `invalid_parameter`.
 */
export function whyIdParameter(request: Request, withReports: boolean): string {
  const path = withReports ? SOCIAL_WHY_REPORTS_PATH : SOCIAL_WHY_RECORD_PATH;
  const whyId = routeParams(path, new URL(request.url).pathname)?.why_id;
  return socialParameter(socialWhyIdSchema, whyId, "why_id");
}

const isUniqueViolation = (error: unknown) => error instanceof DatabaseError && error.code === "23505";

/** A `204` with the kit's headers for a `no-store` route (the delete answers no body). */
function noContent(context: SocialRequestContext): Response {
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store", "X-Request-ID": context.requestId } });
}

/**
 * The why routes (contract in `contracts/whys.ts`).
 *
 * `create.POST` (T-021): account required, bucket `social_why`. After the
 * kit: the path, the closed body, `validateWhy`, the blocked terms; then one
 * primary transaction that reads the item through the naming rule
 * (`visibleEntry`: not shown is `not_found`, another named actor or none is
 * `not_author`), checks the 24-hour window from the item's time, takes the
 * item's transaction lock (two first whys on one item cannot both pass the
 * limit checks), reads the item's why records (`social_whys_entry_idx`) and
 * inserts the why. The partial unique index on the active why backs the lock.
 *
 * `remove.DELETE` (T-022): account required, bucket `social_why`. After the
 * kit: the path, then one primary transaction that locks the why's row
 * (`not_found`, `not_author`, `why_removed`) and sets `state = 'deleted'`
 * with `deleted_at`. The row is kept; the lock and the `state = 'active'`
 * guard make a repeated delete a `204` that writes nothing.
 *
 * `report.POST` (T-022): account required, bucket `social_report`. After the
 * kit: the path, the closed body with an optional normalized reason, then
 * one primary transaction that reads the why (`not_found` unless it is
 * active, `cannot_report_self` for one's own) and inserts the one report row
 * per account per why. `201` when it stored one, `200` when this account had
 * already reported it. The reason never leaves the transaction.
 */
export function createSocialWhyRoutes(dependencies: SocialWhyRouteDependencies) {
  const { kit, config, findBlockedTerm } = dependencies;
  const now = dependencies.now ?? Date.now;
  const createId = dependencies.createId ?? randomUUID;

  async function create(context: SocialRequestContext): Promise<Response> {
    const entryId = whyEntryParameter(context.request);
    const { text } = await readSocialJsonWithSchema(context.request, socialWhyCreateRequestSchema);
    const checked = validateWhy(text);
    if (!checked.ok) throw new SocialRouteError(checked.code);
    if ((await findBlockedTerm(checked.text)) !== null) throw new SocialRouteError("blocked_term", { extra: { field: "text" } });

    const values = await config();
    const accountId = context.account!.account_id;
    const whyId = createId();
    try {
      await context.transaction(async (social) => {
        const entry = await visibleEntry(social, entryId, { bigCommitUsd: values.big_commit_usd, bigTradeUsd: values.big_trade_usd });
        if (!entry || context.hiddenKinds.includes(entry.kind)) throw new SocialRouteError("not_found");
        if (entry.namedAccountId !== accountId) throw new SocialRouteError("not_author");
        if (now() > entry.occurredAtMs + WHY_WINDOW_MS) throw new SocialRouteError("why_window_closed");
        await createWhy(social, { whyId, entryId, accountId, text: checked.text });
      }, { label: "social.why" });
    } catch (error) {
      // Another active why committed first (only possible past the lock through a non-route writer).
      if (isUniqueViolation(error)) throw new SocialRouteError("why_exists");
      throw error;
    }
    const created: SocialWhyCreated = { why_id: whyId, text: checked.text };
    return context.json(created, 201);
  }

  /** The author's retraction (AC-082): `204`, the record kept as `deleted`. */
  async function remove(context: SocialRequestContext): Promise<Response> {
    const whyId = whyIdParameter(context.request, false);
    const accountId = context.account!.account_id;
    await context.transaction((social) => retractWhy(social, whyId, accountId), { label: "social.why-delete" });
    return noContent(context);
  }

  /** One report per account per why (AC-083): `201` stored, `200` already reported. */
  async function report(context: SocialRequestContext): Promise<Response> {
    const whyId = whyIdParameter(context.request, true);
    const { reason } = await readSocialJsonWithSchema(context.request, socialWhyReportRequestSchema);
    const accountId = context.account!.account_id;
    const stored = await context.transaction((social) => reportWhy(social, whyId, accountId, reason), { label: "social.why-report" });
    const answer: SocialWhyReported = { why_id: whyId, already_reported: !stored };
    return context.json(answer, stored ? 201 : 200);
  }

  return Object.freeze({
    create: Object.freeze({
      POST: kit.route({ name: SOCIAL_WHY_CREATE_ROUTE, auth: "account", account: "required", bucket: "social_why" }, create),
    }),
    remove: Object.freeze({
      DELETE: kit.route({ name: SOCIAL_WHY_DELETE_ROUTE, auth: "account", account: "required", bucket: "social_why" }, remove),
    }),
    report: Object.freeze({
      POST: kit.route({ name: SOCIAL_WHY_REPORT_ROUTE, auth: "account", account: "required", bucket: "social_report" }, report),
    }),
  });
}

export type SocialWhyRoutes = ReturnType<typeof createSocialWhyRoutes>;
