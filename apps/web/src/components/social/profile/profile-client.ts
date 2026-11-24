import { socialMePresalesSchema } from "@blast/core/web/contracts/me-presales.ts";
import {
  profilePresaleSchema,
  SOCIAL_ME_PRESALES_PATH,
  SOCIAL_PROFILE_EDIT_PATH,
  SOCIAL_PROFILE_PICTURE_PATH,
  socialProfileCallsSchema,
  socialProfileEditSchema,
  socialProfileMutualsSchema,
  socialProfileCallsPath,
  socialProfileMutualsPath,
  type ProfilePresale,
  type SocialMePresales,
  type SocialProfileCalls,
  type SocialProfileEdit,
  type SocialProfileEditRequest,
  type SocialProfileMutuals,
} from "@blast/core/web/contracts/profile-page.ts";
import { socialPortfolioSchema, socialPublicPortfolioPath, type SocialPortfolio } from "@blast/core/web/contracts/portfolio.ts";
import { withProfileBio } from "@blast/core/web/contracts/profiles.ts";

import { callSocialApi, type ApiResult, type SocialApiOptions, type SocialResponseBody } from "#web/components/social/social-api.ts";

/**
 * The profile page's reads and the edit sheet's writes. Public reads (calls,
 * someone's public portfolio) go without an access token; viewer reads and writes
 * go through the shared social API helper with the viewer's credentials.
 * Every answer is checked before it is shown: anything malformed is an error,
 * never half-rendered.
 */

export function isProfilePresale(value: unknown): value is ProfilePresale {
  return profilePresaleSchema.safeParse(value).success;
}

export function isProfileCalls(value: unknown): value is SocialProfileCalls {
  return socialProfileCallsSchema.safeParse(value).success;
}

export function isMePresales(value: unknown): value is SocialMePresales {
  return socialMePresalesSchema.safeParse(value).success;
}

export type PublicReadResult<Body> = Readonly<{ status: "ok"; body: Body }> | Readonly<{ status: "refused"; code: string; httpStatus?: number; retryAfterSeconds?: number | null; requestId?: string }> | Readonly<{ status: "error"; code?: string; httpStatus?: number; requestId?: string }>;

async function publicRead<Body>(path: string, accept: SocialResponseBody<Body>, signal?: AbortSignal): Promise<PublicReadResult<Body>> {
  return callSocialApi({ getAccessToken: async () => null, signal }, path, { method: "GET" }, accept);
}

/** `GET /api/social/profiles/{callsign}/calls` (public). */
export function fetchProfileCalls(callsign: string, signal?: AbortSignal): Promise<PublicReadResult<SocialProfileCalls>> {
  return publicRead(socialProfileCallsPath(callsign), socialProfileCallsSchema, signal);
}

/** `GET /api/social/profiles/{callsign}/portfolio` (public, only while its owner opened it). */
export function fetchPublicPortfolio(callsign: string, signal?: AbortSignal): Promise<PublicReadResult<SocialPortfolio>> {
  return publicRead(socialPublicPortfolioPath(callsign), socialPortfolioSchema, signal);
}

/** `GET /api/social/profiles/{callsign}/mutuals` (viewer). */
export function fetchMutuals(options: SocialApiOptions, callsign: string): Promise<ApiResult<SocialProfileMutuals>> {
  return callSocialApi(options, socialProfileMutualsPath(callsign), { method: "GET" }, socialProfileMutualsSchema);
}

/** `GET /api/social/me/presales` (viewer). */
export function fetchMePresales(options: SocialApiOptions, positionsOnly = false): Promise<ApiResult<SocialMePresales>> {
  return callSocialApi(options, positionsOnly ? `${SOCIAL_ME_PRESALES_PATH}?view=positions` : SOCIAL_ME_PRESALES_PATH, { method: "GET" }, socialMePresalesSchema);
}

/** `GET /api/social/me/profile`: what the edit sheet shows. */
export function fetchProfileEdit(options: SocialApiOptions): Promise<ApiResult<SocialProfileEdit>> {
  return callSocialApi(options, withProfileBio(SOCIAL_PROFILE_EDIT_PATH), { method: "GET" }, socialProfileEditSchema);
}

/** `PUT /api/social/me/profile`. */
export function saveProfileEdit(options: SocialApiOptions, change: SocialProfileEditRequest): Promise<ApiResult<SocialProfileEdit>> {
  return callSocialApi(options, withProfileBio(SOCIAL_PROFILE_EDIT_PATH), { method: "PUT", body: change }, socialProfileEditSchema);
}

/** `PUT /api/social/me/profile/picture` with the prepared image. */
export function uploadProfilePicture(options: SocialApiOptions, image: Blob): Promise<ApiResult<SocialProfileEdit>> {
  return callSocialApi(options, withProfileBio(SOCIAL_PROFILE_PICTURE_PATH), { method: "PUT", raw: image }, socialProfileEditSchema);
}
