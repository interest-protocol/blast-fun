import type { PrivateRouteContract } from "../private-routes.ts";
import type { RoutePath } from "../route-path.ts";

export const SOCIAL_TRANSFER_PATH = "/api/social/me/transfers/:id" satisfies RoutePath;

export const SOCIAL_COINS_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  { id: "social.me.wallet", method: "GET", path: "/api/social/me/wallet", maxBodyBytes: 0, resourceClass: "provider-heavy", workBudgetMs: 60_000 },
  { id: "social.me.wallet", method: "HEAD", path: "/api/social/me/wallet", maxBodyBytes: 0, resourceClass: "provider-heavy", workBudgetMs: 60_000 },
  { id: "social.me.transfers", method: "PUT", path: SOCIAL_TRANSFER_PATH, maxBodyBytes: 192 * 1024, resourceClass: "provider-heavy", workBudgetMs: 60_000 },
]);
