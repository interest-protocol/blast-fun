import type { PrivateRouteContract } from "../private-routes.ts";

/** Builds an existing account's commit transaction; signing and submission are separate. */
export const COMMIT_PRIVATE_ROUTES: readonly PrivateRouteContract[] =
  Object.freeze([
    {
      id: "social.commit.build",
      method: "POST",
      path: "/api/social/me/commits",
      maxBodyBytes: 4096, resourceClass: "provider-heavy",
      workBudgetMs: 120_000,
    },
  ]);
