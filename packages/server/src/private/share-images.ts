import { routeParams } from "@blast/core/modules/backend-api/route-path.ts";
import { REFERRAL_CONTEXT_PATH, REFERRAL_IMAGE_PATH } from "@blast/core/modules/backend-api/private/share-images-contracts.ts";
import { referralCallsign } from "@blast/core/modules/social/referrals/contracts.ts";
import { encodeReferralContext } from "@blast/core/modules/social/referrals/share-context.ts";
import { presaleShareRoute } from "../modules/presale/share/runtime.ts";
import { referralInviter, referralShareRoute } from "../modules/social/referrals/share-runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

export const SHARE_IMAGE_HANDLERS = {
  "presale.share.image": (request, { client }) => presaleShareRoute()(request, client),
  "social.referral.image": (request) => referralShareRoute()(callsignOf(REFERRAL_IMAGE_PATH, request)),
  "social.referral.context": async (request) => {
    const callsign = referralCallsign(callsignOf(REFERRAL_CONTEXT_PATH, request));
    const inviter = callsign ? await referralInviter(callsign) : null;
    return new Response(encodeReferralContext(inviter, callsign ?? ""), {
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    });
  },
} satisfies PrivateHandlers;

/** The `:callsign`, URL-decoded once; "" when it does not decode, which the canonical validators reject. */
function callsignOf(path: typeof REFERRAL_IMAGE_PATH | typeof REFERRAL_CONTEXT_PATH, request: Request): string {
  return routeParams(path, new URL(request.url).pathname)?.callsign ?? "";
}
