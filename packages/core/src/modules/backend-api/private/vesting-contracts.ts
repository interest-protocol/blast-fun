import type { PrivateRouteContract } from "../private-routes.ts";
import type { RoutePath } from "../route-path.ts";

export const VESTING_SCHEDULE_PATH = "/api/vesting/:scheduleId" satisfies RoutePath;

export const VESTING_PRIVATE_ROUTES: readonly PrivateRouteContract[] =
  Object.freeze(
    ["GET", "HEAD"].map((method): PrivateRouteContract => ({
      id: "vesting.public.read",
      method,
      path: VESTING_SCHEDULE_PATH,
      maxBodyBytes: 0,
      ssrRead: true,
    })),
  );
