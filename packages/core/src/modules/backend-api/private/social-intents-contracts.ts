import type { PrivateRouteContract } from "../private-routes.ts";

export const SOCIAL_INTENTS_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  { id: "social.intents", method: "POST", path: "/api/social/intents", maxBodyBytes: 192 * 1024 },
]);
