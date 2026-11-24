import {
  SOCIAL_LAUNCH_DRAFTS_PATH,
  launchDraftListSchema,
  launchDraftResponseSchema,
  launchPublishResponseSchema,
  socialLaunchDraftCoverPath,
  socialLaunchDraftLogoPath,
  socialLaunchDraftPath,
  socialLaunchDraftPublishedPath,
  socialLaunchDraftPublishPath,
  type LaunchDraftList,
  type LaunchDraftResponse,
  type LaunchPublishCoin,
  type LaunchPublishPlan,
  type LaunchPublishStepKind,
} from "@blast/core/web/contracts/launch.ts";
import type { LaunchDraft } from "@blast/core/modules/social/launch/model.ts";

import { call, type CreateApiOptions, type CreateApiResult } from "../create/create-client";

/**
 * The Launch page's calls (contract in `contracts/launch.ts`), with the
 * viewer's credentials and never cached, through Create's client: a refusal
 * keeps its published code and fields (`error.draft` of a conflict,
 * `error.reasons` of an unavailable publish, `error.coin_type` of a coin the
 * draft already published).
 */
export type LaunchApiOptions = CreateApiOptions;
export type LaunchApiResult<Body> = CreateApiResult<Body>;

/** The newest unpublished draft to resume, or null for a fresh form. */
export async function fetchLatestLaunchDraftId(options: LaunchApiOptions): Promise<LaunchApiResult<string | null>> {
  const list = await call<LaunchDraftList>(options, SOCIAL_LAUNCH_DRAFTS_PATH, { method: "GET" }, launchDraftListSchema);
  return list.status === "ok" ? { ...list, body: list.body.drafts[0]?.draft_id ?? null } : list;
}

export function fetchLaunchDraft(options: LaunchApiOptions, draftId: string): Promise<LaunchApiResult<LaunchDraftResponse>> {
  return call(options, socialLaunchDraftPath(draftId), { method: "GET" }, launchDraftResponseSchema);
}

export function saveLaunchDraft(options: LaunchApiOptions, draftId: string, version: number, draft: LaunchDraft): Promise<LaunchApiResult<LaunchDraftResponse>> {
  return call(options, socialLaunchDraftPath(draftId), { method: "PUT", json: { version, draft } }, launchDraftResponseSchema);
}

export function uploadLaunchLogo(options: LaunchApiOptions, draftId: string, file: Blob): Promise<LaunchApiResult<LaunchDraftResponse>> {
  return call(options, socialLaunchDraftLogoPath(draftId), { method: "PUT", raw: file }, launchDraftResponseSchema);
}

export function uploadLaunchCover(options: LaunchApiOptions, draftId: string, file: File): Promise<LaunchApiResult<LaunchDraftResponse>> {
  const form = new FormData();
  form.set("cover", file, file.name || "cover");
  return call(options, socialLaunchDraftCoverPath(draftId), { method: "POST", form }, launchDraftResponseSchema);
}

export function removeLaunchCover(options: LaunchApiOptions, draftId: string): Promise<LaunchApiResult<LaunchDraftResponse>> {
  return call(options, socialLaunchDraftCoverPath(draftId), { method: "DELETE" }, launchDraftResponseSchema);
}

/** One step of the publish plan, after the preceding transaction confirmed. */
export function requestLaunchStep(
  options: LaunchApiOptions,
  draftId: string,
  version: number,
  creator: string,
  step: LaunchPublishStepKind,
  coin: LaunchPublishCoin | null,
  fee: "sponsored" | "wallet",
): Promise<LaunchApiResult<LaunchPublishPlan>> {
  return call(options, socialLaunchDraftPublishPath(draftId), { method: "POST", json: { version, step, creator, fee, ...(coin ? { coin } : {}) } }, launchPublishResponseSchema);
}

/** Records the launch the draft became, after its creation confirmed. */
export function recordLaunchPublished(options: LaunchApiOptions, draftId: string, launchId: string): Promise<LaunchApiResult<LaunchDraftResponse>> {
  return call(options, socialLaunchDraftPublishedPath(draftId), { method: "POST", json: { launch_id: launchId } }, launchDraftResponseSchema);
}
