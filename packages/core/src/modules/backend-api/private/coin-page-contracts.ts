import type { PrivateRouteContract } from "../private-routes.ts";
import type { RoutePath } from "../route-path.ts";

export const COIN_PAGE_PATH = "/api/launchpad/coin-page/:coinType" satisfies RoutePath;
export const COIN_PAGE_RESOLVE_PRESALE = "resolvePresale";
export const LAUNCH_DETAILS_PATH = "/api/launchpad/launch-details/:launchId" satisfies RoutePath;

export const COIN_PAGE_PRIVATE_ROUTES: readonly PrivateRouteContract[] =
  Object.freeze([
    {
      id: "launchpad.coin-page.read",
      method: "GET",
      path: COIN_PAGE_PATH,
      maxBodyBytes: 0,
      ssrRead: true,
      ssrOnly: true,
    },
    ...["GET", "HEAD"].map((method): PrivateRouteContract => ({
      id: "launchpad.launch-details.read",
      method,
      path: LAUNCH_DETAILS_PATH,
      maxBodyBytes: 0,
      // The Bonding page reads its hero's details while rendering, so the hero is in the first paint.
      ssrRead: method === "GET",
    })),
  ]);
