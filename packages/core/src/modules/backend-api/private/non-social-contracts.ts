import type { PrivateRouteContract } from "../private-routes.ts";

/** Account, legacy recovery and launchpad security routes. */
const NON_SOCIAL_METHODS = [
  {
    id: "mission-control.owner.card",
    method: "GET",
    path: "/api/mission-control/owner/card",
    maxBodyBytes: 0, resourceClass: "bulk",
    workBudgetMs: 60_000,
  },
  {
    id: "mission-control.owner",
    method: "GET",
    path: "/api/mission-control/owner",
    maxBodyBytes: 0,
  },
  {
    id: "mission-control.owner.recruits",
    method: "GET",
    path: "/api/mission-control/owner/recruits",
    maxBodyBytes: 0,
  },
  {
    id: "mission-control.owner.display-name",
    method: "PATCH",
    path: "/api/mission-control/owner/display-name",
    maxBodyBytes: 1024,
  },
  {
    id: "mission-control.logout",
    method: "POST",
    path: "/api/auth/logout",
    maxBodyBytes: 4096,
  },
  {
    id: "mission-control.owner.wallets",
    method: "GET",
    path: "/api/mission-control/owner/wallets",
    maxBodyBytes: 0,
  },
  {
    id: "mission-control.owner.wallets.primary",
    method: "PATCH",
    path: "/api/mission-control/owner/wallets/primary",
    maxBodyBytes: 16383,
  },
  {
    id: "launchpad.csrf",
    method: "GET",
    path: "/api/launchpad/csrf",
    maxBodyBytes: 0,
  },
  {
    id: "mission-control.owner.wallets.challenge",
    method: "POST",
    path: "/api/mission-control/owner/wallets/challenge",
    maxBodyBytes: 16383, resourceClass: "bulk",
    workBudgetMs: 60_000,
  },
  {
    id: "mission-control.owner.wallets.link",
    method: "POST",
    path: "/api/mission-control/owner/wallets",
    maxBodyBytes: 16383, resourceClass: "bulk",
    workBudgetMs: 60_000,
  },
  {
    id: "mission-control.restore.challenge",
    method: "PUT",
    path: "/api/mission-control/restore",
    maxBodyBytes: 16384, resourceClass: "bulk",
    workBudgetMs: 60_000,
  },
  {
    id: "mission-control.restore.verify",
    method: "POST",
    path: "/api/mission-control/restore",
    maxBodyBytes: 16384, resourceClass: "bulk",
    workBudgetMs: 60_000,
  },
] as const satisfies readonly PrivateRouteContract[];

export type NonSocialRouteId = (typeof NON_SOCIAL_METHODS)[number]["id"];

export const NON_SOCIAL_PRIVATE_ROUTES: readonly PrivateRouteContract[] =
  Object.freeze([
    ...NON_SOCIAL_METHODS,
    ...NON_SOCIAL_METHODS.filter((route) => route.method === "GET").map(
      (route) => ({ ...route, method: "HEAD" }),
    ),
  ]);
