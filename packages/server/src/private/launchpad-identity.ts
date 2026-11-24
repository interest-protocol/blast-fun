import { createLaunchpadWalletProofRoutes } from "../modules/launchpad-identity/route.ts";
import { withLaunchpadRuntime } from "../modules/launchpad-identity/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

export const LAUNCHPAD_IDENTITY_HANDLERS = {
  "launchpad.wallet-proofs.issue": (request, { client }) =>
    withLaunchpadRuntime((launchpad) => createLaunchpadWalletProofRoutes(launchpad).issue(request, client)),
} satisfies PrivateHandlers;
