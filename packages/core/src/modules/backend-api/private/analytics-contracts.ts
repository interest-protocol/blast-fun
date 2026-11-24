import type { PrivateRouteContract } from "../private-routes.ts";

export const ANALYTICS_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  {
    id: "analytics.account.activity",
    method: "POST",
    path: "/api/analytics/activity",
    maxBodyBytes: 0,
    workBudgetMs: 8000,
  },
]);
