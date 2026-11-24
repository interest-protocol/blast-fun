import { launchClaimPath, launchClaimSchema, type LaunchClaim, type LaunchClaimRequest } from "@blast/core/web/contracts/launch-claims.ts";

import { callSocialApi, type ApiResult, type SocialApiOptions } from "#web/components/social/social-api.ts";

/**
 * The launch claim's call (LP-12), through the shared session helper (`callSocialApi`):
 * `PUT /api/social/me/launch-claims/{request_id}` records the attempt (with what to sign: the
 * kind, and when Blast pays its gas the sponsored transaction), then its digest, or why
 * nothing was sent. The sponsored transaction is executed through the presale sponsor
 * (`executeSponsored`), as every sponsored claim is.
 */

/** Whether `value` is a well-formed launch claim answer (everything the flow reads). */
export function isLaunchClaim(value: unknown): value is LaunchClaim {
  return launchClaimSchema.safeParse(value).success;
}

export function putLaunchClaim(options: SocialApiOptions, requestId: string, body: LaunchClaimRequest): Promise<ApiResult<LaunchClaim>> {
  return callSocialApi(options, launchClaimPath(requestId), { method: "PUT", body }, launchClaimSchema);
}
