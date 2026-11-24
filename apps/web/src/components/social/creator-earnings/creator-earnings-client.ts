import { creatorEarningsSchema } from "@blast/core/web/contracts/creator-earnings.ts";
import { callSocialApi, type SocialApiOptions } from "#web/components/social/social-api.ts";

export function fetchCreatorEarnings(options: SocialApiOptions, cursor: string | null) {
  return callSocialApi(
    options,
    `/api/social/me/creator-earnings${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    { method: "GET" },
    creatorEarningsSchema,
  );
}
