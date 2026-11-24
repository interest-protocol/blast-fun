import {
  CREATOR_CAPS_PATH,
  creatorCapsClaimSchema,
  creatorCommitmentSchema,
  CREATOR_COMMITMENT_PATH,
  type CreatorCapsClaim,
  type CreatorCommitment,
} from "@blast/core/web/contracts/creator-claims.ts";

import { callSocialApi, type ApiResult, type SocialApiOptions } from "#web/components/social/social-api.ts";

/**
 * LP-16's two routes, through the shared session helper (`callSocialApi`):
 *
 * - `GET /api/social/me/creator-commitment`: the signed-in account's commitment, the recipient a
 *   launch names to make this account its creator (minted on the first read, never changed);
 * - `POST /api/social/me/creator-caps {launch_id}`: the claim of a launch's creator caps, built
 *   by the server for the caller's Blast wallet after it checked the recipient on chain, with an
 *   account claim's expiring attestation inside, and sponsored for a Privy embedded wallet.
 *
 * Each answer is checked before anything reads it, so nothing is signed that is not this shape.
 */

export function isCreatorCommitment(value: unknown): value is CreatorCommitment {
  return creatorCommitmentSchema.safeParse(value).success;
}

export function isCreatorCapsClaim(value: unknown): value is CreatorCapsClaim {
  return creatorCapsClaimSchema.safeParse(value).success;
}

export function fetchCreatorCommitment(options: SocialApiOptions): Promise<ApiResult<CreatorCommitment>> {
  return callSocialApi(options, CREATOR_COMMITMENT_PATH, { method: "GET" }, creatorCommitmentSchema);
}

export function requestCreatorCaps(options: SocialApiOptions, launchId: string): Promise<ApiResult<CreatorCapsClaim>> {
  return callSocialApi(options, CREATOR_CAPS_PATH, { method: "POST", body: { launch_id: launchId } }, creatorCapsClaimSchema);
}
