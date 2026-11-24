import { SOCIAL_PNL_PATH, socialPublicPnlPath, socialPnlSchema, type SocialPnl } from "@blast/core/web/contracts/pnl.ts";
import { callSocialApi, type SocialApiOptions } from "#web/components/social/social-api.ts";

export function isSocialPnl(value: unknown): value is SocialPnl {
  return socialPnlSchema.safeParse(value).success;
}

export function fetchPnl(options: SocialApiOptions) {
  return callSocialApi(options, SOCIAL_PNL_PATH, { method: "GET" }, socialPnlSchema);
}

export function fetchPublicPnl(callsign: string) {
  return callSocialApi({ getAccessToken: async () => null }, socialPublicPnlPath(callsign), { method: "GET" }, socialPnlSchema);
}
