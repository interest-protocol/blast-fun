import type { PrivateRouteContract } from "../private-routes.ts";
import type { RoutePath } from "../route-path.ts";

export const PRESALE_SPONSOR_EXECUTE_PATH = "/api/presale/sponsor/:reservation_id/execute" satisfies RoutePath;
export const PRESALE_ALLOWLIST_PATH = "/api/presale/allowlists/:allowlist_id" satisfies RoutePath;
export const PRESALE_ALLOWLIST_ENTRIES_PATH = "/api/presale/allowlists/:allowlist_id/entries" satisfies RoutePath;
export const PRESALE_ALLOWLIST_BIND_PATH = "/api/presale/allowlists/:allowlist_id/bind" satisfies RoutePath;
export const PRESALE_PROOF_PATH = "/api/presale/presales/:presale_id/proof" satisfies RoutePath;
export const PRESALE_BRIDGE_TRANSFER_PATH = "/api/presale/bridge/transfers/:id" satisfies RoutePath;

/** Existing financial owners retain authentication, parsing and idempotency. */
const routes: readonly PrivateRouteContract[] = [
  {
    id: "presale.sponsor.create",
    method: "POST",
    path: "/api/presale/sponsor",
    maxBodyBytes: 32768,
  },
  {
    id: "presale.sponsor.execute",
    method: "POST",
    path: PRESALE_SPONSOR_EXECUTE_PATH,
    maxBodyBytes: 16384, resourceClass: "provider-heavy",
    workBudgetMs: 90000,
  },
  {
    id: "presale.outcomes.commitments",
    method: "POST",
    path: "/api/presale/outcomes/commitments",
    maxBodyBytes: 1024,
  },
  {
    id: "presale.outcomes.record",
    method: "POST",
    path: "/api/presale/outcomes",
    maxBodyBytes: 1024,
  },
  {
    id: "presale.outcomes.visitor",
    method: "POST",
    path: "/api/presale/outcomes/visitor",
    maxBodyBytes: 0,
  },
  {
    id: "presale.allowlists.create",
    method: "POST",
    path: "/api/presale/allowlists",
    maxBodyBytes: 4 * 1024 * 1024, resourceClass: "bulk",
    workBudgetMs: 300_000,
  },
  {
    id: "presale.allowlists.read",
    method: "GET",
    path: PRESALE_ALLOWLIST_PATH,
    maxBodyBytes: 0,
  },
  {
    id: "presale.allowlists.entries",
    method: "GET",
    path: PRESALE_ALLOWLIST_ENTRIES_PATH,
    maxBodyBytes: 0,
  },
  {
    id: "presale.allowlists.bind",
    method: "POST",
    path: PRESALE_ALLOWLIST_BIND_PATH,
    maxBodyBytes: 1024,
  },
  {
    id: "presale.allowlists.proof",
    method: "GET",
    path: PRESALE_PROOF_PATH,
    maxBodyBytes: 0,
  },
  {
    id: "presale.bridge.quote",
    method: "GET",
    path: "/api/presale/bridge/quote",
    maxBodyBytes: 0,
  },
  {
    id: "presale.bridge.register",
    method: "POST",
    path: "/api/presale/bridge/transfers",
    maxBodyBytes: 65536,
  },
  {
    id: "presale.bridge.status",
    method: "GET",
    path: PRESALE_BRIDGE_TRANSFER_PATH,
    maxBodyBytes: 0,
  },
  {
    id: "presale.rewards.manifest",
    method: "GET",
    path: "/api/presale/rewards/rounds/:round_id/manifest",
    maxBodyBytes: 0,
  },
];

export const PRESALE_PRIVATE_ROUTES: readonly PrivateRouteContract[] =
  Object.freeze([
    ...routes,
    ...routes
      .filter((route) => route.method === "GET")
      .map((route) => ({ ...route, method: "HEAD" })),
  ]);
