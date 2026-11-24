import { socialDepositRoutes } from "../modules/social/deposits/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

export const SOCIAL_DEPOSITS_HANDLERS = {
  "social.me.deposits": (request, { client }) => socialDepositRoutes().bridge(request, client),
  "social.me.deposit": (request, { client }) => socialDepositRoutes().deposit(request, client),
} satisfies PrivateHandlers;
