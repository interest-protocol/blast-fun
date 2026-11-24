import type { PrivateRouteContract } from "../private-routes.ts";
import type { RoutePath } from "../route-path.ts";

export const SOCIAL_DEPOSIT_PATH = "/api/social/me/deposits/:id" satisfies RoutePath;

export const SOCIAL_DEPOSITS_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  { id: "social.me.deposits", method: "GET", path: "/api/social/me/deposits", maxBodyBytes: 0, resourceClass: "provider-heavy", workBudgetMs: 60_000 },
  { id: "social.me.deposits", method: "HEAD", path: "/api/social/me/deposits", maxBodyBytes: 0, resourceClass: "provider-heavy", workBudgetMs: 60_000 },
  { id: "social.me.deposit", method: "PUT", path: SOCIAL_DEPOSIT_PATH, maxBodyBytes: 4096, resourceClass: "provider-heavy", workBudgetMs: 60_000 },
]);
