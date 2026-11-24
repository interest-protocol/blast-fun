import { socialClaimRoutes } from "../modules/social/claims/runtime.ts";
import { creatorClaimRoutes } from "../modules/social/creator-claims/runtime.ts";
import { creatorEarningsRoute } from "../modules/social/creator-earnings/runtime.ts";
import { launchClaimRoutes } from "../modules/social/launch-claims/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

export const SOCIAL_CLAIMS_HANDLERS = {
  "social.me.claim": (request, { client }) => socialClaimRoutes().claim(request, client),
  "social.me.creator-earnings": (request, { client }) => creatorEarningsRoute()(request, client),
  "social.me.creator-commitment": (request, { client }) => creatorClaimRoutes().commitment(request, client),
  "social.me.creator-caps": (request, { client }) => creatorClaimRoutes().caps(request, client),
  "social.me.launch-claims": (request, { client }) => launchClaimRoutes().claim(request, client),
} satisfies PrivateHandlers;
