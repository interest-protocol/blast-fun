import type { PrivateRouteContract } from "../private-routes.ts";

/** Existing viewer authentication and thesis mutation guards remain with their owners. */
export const VIEWER_THESES_PRIVATE_ROUTES: readonly PrivateRouteContract[] =
  Object.freeze([
    {
      id: "social.presales.viewer",
      method: "POST",
      path: "/api/social/presales/viewer",
      maxBodyBytes: 4096,
      workBudgetMs: 30_000,
    },
    {
      id: "launchpad.theses.read",
      method: "GET",
      path: "/api/launchpad/theses",
      maxBodyBytes: 0,
      workBudgetMs: 30_000,
    },
    {
      id: "launchpad.theses.read",
      method: "HEAD",
      path: "/api/launchpad/theses",
      maxBodyBytes: 0,
      workBudgetMs: 30_000,
    },
    {
      id: "launchpad.theses.write",
      method: "POST",
      path: "/api/launchpad/theses",
      maxBodyBytes: 16_384,
      workBudgetMs: 30_000,
    },
  ]);
