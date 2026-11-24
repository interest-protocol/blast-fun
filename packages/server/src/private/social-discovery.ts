import { socialActivityRoute } from "../modules/social/activity/runtime.ts";
import { socialHappeningRoute } from "../modules/social/happening/runtime.ts";
import { socialSearchRoutes } from "../modules/social/search/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

export const SOCIAL_DISCOVERY_HANDLERS = {
  "social.activity": (request, { client }) => socialActivityRoute().GET(request, client),
  "social.happening": (request, { client }) => socialHappeningRoute().GET(request, client),
  "social.search": (request, { client }) => socialSearchRoutes().search.GET(request, client),
} satisfies PrivateHandlers;
