import type { PrivateRouteContract } from "../private-routes.ts";

/** Bootstrap credentials do not grant account or partner authority. */
export const FRONTEND_SECURITY_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  { id: "frontend.gate.refresh", method: "GET", path: "/api/gate", maxBodyBytes: 0, workBudgetMs: 30_000 },
]);
