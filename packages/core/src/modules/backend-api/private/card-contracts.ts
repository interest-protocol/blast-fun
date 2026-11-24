import type { PrivateRouteContract } from "../private-routes.ts";
import type { RoutePath } from "../route-path.ts";

export const CARD_IMAGE_PATH = "/card/:id/image" satisfies RoutePath;
export const PNL_CARD_IMAGE_PATH = "/card/pnl/:id/image" satisfies RoutePath;
export const CARD_PAGE_PATH = "/api/mission-control/card-page/:id" satisfies RoutePath;
export const PNL_CARD_PAGE_PATH = "/api/social/pnl-card-page/:id" satisfies RoutePath;

const CARD_READS: readonly PrivateRouteContract[] = [
  {
    id: "social.card-identities",
    method: "GET",
    path: "/api/social/card-identities",
    maxBodyBytes: 0,
  },
  {
    id: "social.owner-card",
    method: "GET",
    path: "/api/social/me/card",
    maxBodyBytes: 0, resourceClass: "render",
    workBudgetMs: 60_000,
  },
  {
    id: "mission-control.card.image",
    method: "GET",
    path: CARD_IMAGE_PATH,
    maxBodyBytes: 0, resourceClass: "render",
    workBudgetMs: 60_000,
  },
  {
    id: "social.pnl-card.image",
    method: "GET",
    path: PNL_CARD_IMAGE_PATH,
    maxBodyBytes: 0, resourceClass: "render",
    workBudgetMs: 60_000,
  },
];

export const CARD_PRIVATE_ROUTES: readonly PrivateRouteContract[] =
  Object.freeze([
    ...CARD_READS,
    ...CARD_READS.map((route) => ({ ...route, method: "HEAD" })),
    {
      id: "mission-control.card.page",
      method: "GET",
      path: CARD_PAGE_PATH,
      maxBodyBytes: 0,
      ssrRead: true,
      ssrOnly: true,
    },
    {
      id: "social.pnl-card.page",
      method: "GET",
      path: PNL_CARD_PAGE_PATH,
      maxBodyBytes: 0,
      ssrRead: true,
      ssrOnly: true,
    },
    {
      id: "social.pnl-card.publish",
      method: "POST",
      path: "/api/social/me/pnl/card",
      maxBodyBytes: 4194304, resourceClass: "upload",
      workBudgetMs: 60_000,
    },
  ]);
