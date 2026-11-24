import { socialRewardsResponseSchema, type SocialRewardsPage } from "@blast/core/web/contracts/rewards.ts";

import { callSocialApi, type ApiResult } from "#web/components/social/social-api.ts";
import type { AccessTokenSource } from "../social-fetch";

/**
 * `GET /api/social/me/rewards` (OA-45) with the viewer's credentials
 * (`callSocialApi`, never a hand-built header): one page, checked before it
 * is drawn. A malformed answer is an error, never half-rendered.
 */

export function isRewardsPage(value: unknown): value is SocialRewardsPage {
  return socialRewardsResponseSchema.safeParse(value).success;
}

/** One page at `path` (`socialRewardsPath`). */
export function fetchRewardsPage(
  options: Readonly<{ getAccessToken: AccessTokenSource }>,
  path: string,
): Promise<ApiResult<SocialRewardsPage>> {
  return callSocialApi(options, path, { method: "GET" }, socialRewardsResponseSchema);
}
