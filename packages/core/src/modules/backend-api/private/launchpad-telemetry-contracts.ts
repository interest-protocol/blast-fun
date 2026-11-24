import type { PrivateRouteContract } from "../private-routes.ts";

export const LAUNCHPAD_TELEMETRY_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  { id: "launchpad.telemetry.view", method: "POST", path: "/api/launchpad/telemetry", maxBodyBytes: 1024 },
  { id: "launchpad.telemetry.outcome", method: "POST", path: "/api/launchpad/outcomes", maxBodyBytes: 1024 },
  { id: "launchpad.telemetry.commitment", method: "POST", path: "/api/launchpad/outcomes/commitments", maxBodyBytes: 1024 },
]);
