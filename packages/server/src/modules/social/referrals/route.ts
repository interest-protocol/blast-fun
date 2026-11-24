import type { SocialRouteKit } from "@blast/server/modules/social/route-kit/route.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";
import { isReferralCursor } from "@blast/core/modules/social/referrals/contracts.ts";
import { readReferralInvitees, readReferralSummary } from "@blast/server/modules/social/referrals/read.ts";

export function createReferralRoute(kit: SocialRouteKit) {
  return Object.freeze({
    GET: kit.route(
      { name: "GET /api/social/me/referrals", auth: "account", account: "required", bucket: "social_read", cache: "private" },
      async (context) => context.json(await context.transaction(
        (social) => readReferralSummary(social, context.account!.account_id),
        { label: "social.referrals", isolationLevel: "REPEATABLE READ" },
      )),
    ),
  });
}

export function createReferralInviteesRoute(kit: SocialRouteKit) {
  return Object.freeze({
    GET: kit.route(
      { name: "GET /api/social/me/referrals/invitees", auth: "account", account: "required", bucket: "social_read", cache: "private" },
      async (context) => {
        const values = new URL(context.request.url).searchParams.getAll("cursor");
        const cursor = values[0] ?? null;
        if (values.length > 1 || (cursor !== null && !isReferralCursor(cursor))) {
          throw new SocialRouteError("invalid_parameter", { extra: { parameter: "cursor" } });
        }
        return context.json(await context.transaction(
          (social) => readReferralInvitees(social, context.account!.account_id, cursor),
          { label: "social.referrals.invitees", isolationLevel: "REPEATABLE READ" },
        ));
      },
    ),
  });
}
