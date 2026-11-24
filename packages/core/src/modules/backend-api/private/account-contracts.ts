import type { PrivateRouteContract } from "../private-routes.ts";
const routes: readonly PrivateRouteContract[] = [
  {
    id: "account.settings.read",
    method: "GET",
    path: "/api/account/settings",
    maxBodyBytes: 0,
  },
  {
    id: "account.settings.write",
    method: "PUT",
    path: "/api/account/settings",
    maxBodyBytes: 65536,
  },
  {
    id: "account.wallets",
    method: "GET",
    path: "/api/account/wallets",
    maxBodyBytes: 0,
  },
];
export const ACCOUNT_PRIVATE_ROUTES: readonly PrivateRouteContract[] =
  Object.freeze([
    ...routes,
    ...routes
      .filter((route) => route.method === "GET")
      .map((route) => ({ ...route, method: "HEAD" })),
  ]);
