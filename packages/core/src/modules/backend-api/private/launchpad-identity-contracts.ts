import type { PrivateRouteContract } from "../private-routes.ts";

export const LAUNCHPAD_IDENTITY_PRIVATE_ROUTES: readonly PrivateRouteContract[] = Object.freeze([
  { id: "launchpad.wallet-proofs.issue", method: "POST", path: "/api/launchpad/wallet-proofs", maxBodyBytes: 1024 },
]);
