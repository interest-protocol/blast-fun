import { withRouteLimits } from "@blast/core/modules/web-security/route-limits.ts";
import { withLaunchpadRuntime } from "../modules/launchpad-identity/runtime.ts";
import {
  databaseThesisSource,
  handleThesisListRequest,
} from "../modules/launchpad-social/list-resource.ts";
import { postHandler } from "../modules/launchpad-social/mutation.ts";
import { postMutationDependencies } from "../modules/launchpad-social/runtime.ts";
import { socialPresaleRoutes } from "../modules/social/presales/viewer-runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

/** Relay proof authenticates transport; the unchanged owner authenticates its caller. */
export const VIEWER_THESES_HANDLERS = {
  "social.presales.viewer": (request, { client }) =>
    socialPresaleRoutes().viewer.POST(request, client),
  "launchpad.theses.read": (request, { client }) =>
    withRouteLimits(
      client,
      ["launchpad_theses_read"],
      () => handleThesisListRequest(request, databaseThesisSource()),
      {
        rateLimited: "LAUNCHPAD_RATE_LIMITED",
        unavailable: "LAUNCHPAD_READ_UNAVAILABLE",
      },
    ),
  "launchpad.theses.write": (request, { client }) =>
    withLaunchpadRuntime((launchpad) =>
      postHandler(postMutationDependencies(), launchpad)(request, client),
    ),
} satisfies PrivateHandlers;
