import type { PrivateRouteContract } from "../private-routes.ts";

/** Launchpad security routes. */
const NON_SOCIAL_METHODS = [
  {
    id: "launchpad.csrf",
    method: "GET",
    path: "/api/launchpad/csrf",
    maxBodyBytes: 0,
  },
] as const satisfies readonly PrivateRouteContract[];

export const NON_SOCIAL_PRIVATE_ROUTES: readonly PrivateRouteContract[] =
  Object.freeze([
    ...NON_SOCIAL_METHODS,
    ...NON_SOCIAL_METHODS.filter((route) => route.method === "GET").map(
      (route) => ({ ...route, method: "HEAD" }),
    ),
  ]);
