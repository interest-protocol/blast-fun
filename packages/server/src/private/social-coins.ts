import { socialCoinsRoutes } from "../modules/social/coins/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

export const SOCIAL_COINS_HANDLERS = {
  "social.me.wallet": (request, { client }) => socialCoinsRoutes().wallet(request, client),
  "social.me.transfers": (request, { client }) => socialCoinsRoutes().transfer(request, client),
} satisfies PrivateHandlers;
