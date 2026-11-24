import type { PrivateRouteContract } from "../private-routes.ts";
import type { RoutePath } from "../route-path.ts";

export const SOCIAL_DRAFT_PATH = "/api/social/me/drafts/:id" satisfies RoutePath;
export const SOCIAL_DRAFT_LOGO_PATH = "/api/social/me/drafts/:id/logo" satisfies RoutePath;
export const SOCIAL_DRAFT_COVER_PATH = "/api/social/me/drafts/:id/cover" satisfies RoutePath;
export const SOCIAL_DRAFT_PUBLISHED_PATH = "/api/social/me/drafts/:id/published" satisfies RoutePath;
export const SOCIAL_DRAFT_PUBLISH_PATH = "/api/social/me/drafts/:id/publish" satisfies RoutePath;

const routes: readonly PrivateRouteContract[] = [
  { id: "social.create.list", method: "GET", path: "/api/social/me/drafts", maxBodyBytes: 0 },
  { id: "social.create.read", method: "GET", path: SOCIAL_DRAFT_PATH, maxBodyBytes: 0 },
  { id: "social.create.save", method: "PUT", path: SOCIAL_DRAFT_PATH, maxBodyBytes: 65_536, resourceClass: "bulk", workBudgetMs: 60_000 },
  { id: "social.create.delete", method: "DELETE", path: SOCIAL_DRAFT_PATH, maxBodyBytes: 0 },
  { id: "social.create.logo", method: "PUT", path: SOCIAL_DRAFT_LOGO_PATH, maxBodyBytes: 2_097_152, resourceClass: "upload", workBudgetMs: 90_000 },
  { id: "social.create.cover.upload", method: "POST", path: SOCIAL_DRAFT_COVER_PATH, maxBodyBytes: 4_016_384, resourceClass: "upload", workBudgetMs: 90_000 },
  { id: "social.create.cover.delete", method: "DELETE", path: SOCIAL_DRAFT_COVER_PATH, maxBodyBytes: 0, resourceClass: "bulk", workBudgetMs: 60_000 },
  { id: "social.create.published", method: "POST", path: SOCIAL_DRAFT_PUBLISHED_PATH, maxBodyBytes: 1024, resourceClass: "provider-heavy", workBudgetMs: 60_000 },
  { id: "social.create.publish", method: "POST", path: SOCIAL_DRAFT_PUBLISH_PATH, maxBodyBytes: 4096, resourceClass: "provider-heavy", workBudgetMs: 120_000 },
];

export const SOCIAL_CREATE_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  ...routes,
  ...routes.filter((route) => route.method === "GET").map((route) => ({ ...route, method: "HEAD" })),
  { id: "social.create.context", method: "GET", path: "/api/social/create-context", maxBodyBytes: 0, ssrRead: true, ssrOnly: true },
]);
