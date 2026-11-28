import { CREATOR_CAPS_PATH } from "../../social/contracts/creator-claims.ts";
import type { PrivateRouteContract } from "../private-routes.ts";
import type { RoutePath } from "../route-path.ts";

export const SOCIAL_CLAIM_PATH = "/api/social/me/claims/:id" satisfies RoutePath;
export const SOCIAL_LAUNCH_CLAIM_PATH = "/api/social/me/launch-claims/:id" satisfies RoutePath;

export const SOCIAL_CLAIMS_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  { id: "social.me.claim", method: "PUT", path: SOCIAL_CLAIM_PATH, maxBodyBytes: 192 * 1024, resourceClass: "provider-heavy", workBudgetMs: 90_000 },
  { id: "social.me.creator-earnings", method: "GET", path: "/api/social/me/creator-earnings", maxBodyBytes: 0, resourceClass: "provider-heavy", workBudgetMs: 300_000 },
  { id: "social.me.creator-earnings", method: "HEAD", path: "/api/social/me/creator-earnings", maxBodyBytes: 0, resourceClass: "provider-heavy", workBudgetMs: 300_000 },
  { id: "social.me.creator-commitment", method: "GET", path: "/api/social/me/creator-commitment", maxBodyBytes: 0, resourceClass: "ordinary", workBudgetMs: 30_000 },
  { id: "social.me.creator-commitment", method: "HEAD", path: "/api/social/me/creator-commitment", maxBodyBytes: 0, resourceClass: "ordinary", workBudgetMs: 30_000 },
  { id: "social.me.launch-claims", method: "PUT", path: SOCIAL_LAUNCH_CLAIM_PATH, maxBodyBytes: 192 * 1024, resourceClass: "provider-heavy", workBudgetMs: 90_000 },
  { id: "social.me.creator-caps.eligibility", method: "GET", path: CREATOR_CAPS_PATH, maxBodyBytes: 0, resourceClass: "provider-heavy", workBudgetMs: 30_000 },
  { id: "social.me.creator-caps", method: "POST", path: CREATOR_CAPS_PATH, maxBodyBytes: 16 * 1024, resourceClass: "provider-heavy", workBudgetMs: 90_000 },
]);
