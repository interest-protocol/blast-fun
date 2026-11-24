import { socialIntentRoutes } from "../modules/social/intents/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

export const SOCIAL_INTENTS_HANDLERS = {
  "social.intents": (request, { client }) => socialIntentRoutes().register.POST(request, client),
} satisfies PrivateHandlers;
