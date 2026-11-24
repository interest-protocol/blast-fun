import type { PrivateRouteContract } from "../private-routes.ts";

/** Original launch-image JSON bound; existing mutation owns CSRF and wallet/session proof. */
export const ASSET_PRIVATE_ROUTES: readonly PrivateRouteContract[] =
  Object.freeze([
    {
      id: "launch.assets.create",
      method: "POST",
      path: "/api/launchpad/launch-assets",
      maxBodyBytes: 65536, resourceClass: "upload",
    },
  ]);
