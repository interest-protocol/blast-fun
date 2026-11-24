import type { PrivateRouteContract } from "../private-routes.ts";
import type { RoutePath } from "../route-path.ts";

export const SOCIAL_VESTING_ATTEMPT_PATH = "/api/social/me/vesting/attempts/:requestId" satisfies RoutePath;
export const SOCIAL_BRIDGE_WITHDRAWAL_SETTLE_PATH = "/api/social/me/bridge-withdrawals/:withdrawal_id/settle" satisfies RoutePath;

/** Existing personal financial owners; each retains its account/bucket/parser contract. */
const routes: readonly PrivateRouteContract[] = [
  {
    id: "social.vesting.mine",
    method: "GET",
    path: "/api/social/me/vesting",
    maxBodyBytes: 0, resourceClass: "bulk",
    workBudgetMs: 60_000,
  },
  {
    id: "social.vesting.attempt.read",
    method: "GET",
    path: SOCIAL_VESTING_ATTEMPT_PATH,
    maxBodyBytes: 0,
  },
  {
    id: "social.vesting.attempt.prepare",
    method: "PUT",
    path: SOCIAL_VESTING_ATTEMPT_PATH,
    maxBodyBytes: 65_536, resourceClass: "provider-heavy",
    workBudgetMs: 120_000,
  },
  {
    id: "social.bridge.withdraw.quote",
    method: "GET",
    path: "/api/social/me/bridge-withdrawals/quote",
    maxBodyBytes: 0,
  },
  {
    id: "social.bridge.withdraw.create",
    method: "POST",
    path: "/api/social/me/bridge-withdrawals",
    maxBodyBytes: 4096, resourceClass: "provider-heavy",
    workBudgetMs: 120_000,
  },
  {
    id: "social.bridge.withdraw.settle",
    method: "POST",
    path: SOCIAL_BRIDGE_WITHDRAWAL_SETTLE_PATH,
    maxBodyBytes: 0,
  },
];
export const FINANCIAL_PRIVATE_ROUTES: readonly PrivateRouteContract[] =
  Object.freeze([
    ...routes,
    ...routes
      .filter((route) => route.method === "GET")
      .map((route) => ({ ...route, method: "HEAD" })),
  ]);
