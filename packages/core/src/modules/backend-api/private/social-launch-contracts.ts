import type { PrivateRouteContract } from "../private-routes.ts";
import type { RoutePath } from "../route-path.ts";

export const SOCIAL_LAUNCH_PATH = "/api/social/me/launches/:id" satisfies RoutePath;
export const SOCIAL_LAUNCH_LOGO_PATH = "/api/social/me/launches/:id/logo" satisfies RoutePath;
export const SOCIAL_LAUNCH_COVER_PATH = "/api/social/me/launches/:id/cover" satisfies RoutePath;
export const SOCIAL_LAUNCH_PUBLISHED_PATH = "/api/social/me/launches/:id/published" satisfies RoutePath;
export const SOCIAL_LAUNCH_PUBLISH_PATH = "/api/social/me/launches/:id/publish" satisfies RoutePath;

const routes: readonly PrivateRouteContract[] = [
  {
    id: "social.launch.discovery",
    method: "GET",
    path: "/api/social/me/launches/discovery",
    maxBodyBytes: 0,
  },
  {
    id: "social.launch.list",
    method: "GET",
    path: "/api/social/me/launches",
    maxBodyBytes: 0,
  },
  {
    id: "social.launch.read",
    method: "GET",
    path: SOCIAL_LAUNCH_PATH,
    maxBodyBytes: 0,
  },
  {
    id: "social.launch.save",
    method: "PUT",
    path: SOCIAL_LAUNCH_PATH,
    maxBodyBytes: 16_384,
    resourceClass: "bulk",
    workBudgetMs: 60_000,
  },
  {
    id: "social.launch.delete",
    method: "DELETE",
    path: SOCIAL_LAUNCH_PATH,
    maxBodyBytes: 0,
  },
  {
    id: "social.launch.logo",
    method: "PUT",
    path: SOCIAL_LAUNCH_LOGO_PATH,
    maxBodyBytes: 2_097_152,
    resourceClass: "upload",
    workBudgetMs: 90_000,
  },
  {
    id: "social.launch.cover.upload",
    method: "POST",
    path: SOCIAL_LAUNCH_COVER_PATH,
    maxBodyBytes: 4_016_384,
    resourceClass: "upload",
    workBudgetMs: 90_000,
  },
  {
    id: "social.launch.cover.delete",
    method: "DELETE",
    path: SOCIAL_LAUNCH_COVER_PATH,
    maxBodyBytes: 0,
    resourceClass: "bulk",
    workBudgetMs: 60_000,
  },
  {
    id: "social.launch.published",
    method: "POST",
    path: SOCIAL_LAUNCH_PUBLISHED_PATH,
    maxBodyBytes: 1024,
    resourceClass: "provider-heavy",
    workBudgetMs: 60_000,
  },
  {
    id: "social.launch.publish",
    method: "POST",
    path: SOCIAL_LAUNCH_PUBLISH_PATH,
    maxBodyBytes: 4096,
    resourceClass: "provider-heavy",
    workBudgetMs: 120_000,
  },
];

export const SOCIAL_LAUNCH_PRIVATE_ROUTES: readonly PrivateRouteContract[] =
  Object.freeze([
    ...routes,
    ...routes
      .filter((route) => route.method === "GET")
      .map((route) => ({ ...route, method: "HEAD" })),
    {
      id: "social.launch.context",
      method: "GET",
      path: "/api/social/launch-context",
      maxBodyBytes: 0,
      ssrRead: true,
      ssrOnly: true,
    },
  ]);
