import { socialTransactionsRoute } from "../modules/social/transactions/runtime.ts";
import { socialRewardsRoute } from "../modules/social/rewards/runtime.ts";
import { createReferralRoute, createReferralInviteesRoute } from "../modules/social/referrals/route.ts";
import { sharedSocialRouteKit } from "../modules/social/route-kit/shared-runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

export const SOCIAL_PERSONAL_HANDLERS = {
  "social.me.transactions": (request, { client }) => socialTransactionsRoute().GET(request, client),
  "social.me.rewards": (request, { client }) => socialRewardsRoute().GET(request, client),
  "social.me.referrals": (request, { client }) => createReferralRoute(sharedSocialRouteKit()).GET(request, client),
  "social.me.referrals.invitees": (request, { client }) => createReferralInviteesRoute(sharedSocialRouteKit()).GET(request, client),
} satisfies PrivateHandlers;
