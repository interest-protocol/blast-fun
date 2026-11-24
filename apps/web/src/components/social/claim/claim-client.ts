import {
  socialClaimSchema,
  socialClaimPath,
  type SocialClaim,
  type SocialClaimRequest,
} from "@blast/core/web/contracts/claims.ts";

import { callSocialApi, type ApiResult, type SocialApiOptions } from "#web/components/social/social-api.ts";

/**
 * The claim log's call (R3-63), through the shared session helper
 * (`callSocialApi`: the Privy token, or the wallet session cookie — OA-16, so
 * no Authorization header is ever built here): `PUT
 * /api/social/me/claims/{request_id}` records the attempt (and answers the
 * claim's transaction kind to sign), then its digest, or why nothing was sent.
 * The sponsor's calls are `sponsored-transaction.ts`'s.
 */

/** Whether `value` is a well-formed claim answer (everything the flow reads). */
export function isSocialClaim(value: unknown): value is SocialClaim {
  return socialClaimSchema.safeParse(value).success;
}

export function putClaim(options: SocialApiOptions, requestId: string, body: SocialClaimRequest): Promise<ApiResult<SocialClaim>> {
  return callSocialApi(options, socialClaimPath(requestId), { method: "PUT", body }, socialClaimSchema);
}
