import type { PrivateRouteContract } from "../private-routes.ts";

// Profile GET/HEAD owner reads one account projection in a DB transaction; no provider work.
export const SOCIAL_PROFILE_EDIT_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  { id: "social.me.profile.read", method: "GET", path: "/api/social/me/profile", maxBodyBytes: 0, resourceClass: "ordinary", workBudgetMs: 60_000 },
  { id: "social.me.profile.read", method: "HEAD", path: "/api/social/me/profile", maxBodyBytes: 0, resourceClass: "ordinary", workBudgetMs: 60_000 },
  { id: "social.me.profile.write", method: "PUT", path: "/api/social/me/profile", maxBodyBytes: 4096, resourceClass: "bulk", workBudgetMs: 60_000 },
  { id: "social.me.profile.picture", method: "PUT", path: "/api/social/me/profile/picture", maxBodyBytes: 2_097_152, resourceClass: "upload", workBudgetMs: 60_000 },
]);
