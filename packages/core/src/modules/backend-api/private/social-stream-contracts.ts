import type { PrivateRouteContract } from "../private-routes.ts";

export const ACTIVITY_HINT_ROUTE_ID = "social.activity.hints";
export const ACTIVITY_HINT_PATH = "/api/social/activity/hints";

export const SOCIAL_STREAM_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  { id: ACTIVITY_HINT_ROUTE_ID, method: "GET", path: ACTIVITY_HINT_PATH, maxBodyBytes: 0, resourceClass: "ordinary", workBudgetMs: 300_000 },
  { id: ACTIVITY_HINT_ROUTE_ID, method: "HEAD", path: ACTIVITY_HINT_PATH, maxBodyBytes: 0, resourceClass: "ordinary", workBudgetMs: 300_000 },
]);
