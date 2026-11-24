import {
  presaleSponsorRoute,
  presaleSponsorExecuteRoute,
} from "../modules/sponsor/runtime.ts";
import {
  presaleOutcomeRouteHandlers,
  presaleVisitorRouteHandler,
} from "../modules/presale/outcomes/runtime.ts";
import {
  presaleAllowlistRoutes,
  presaleAllowlistBindingRoutes,
} from "../modules/presale/allowlists/runtime.ts";
import { presaleBridgeRoutes } from "../modules/presale/bridge/runtime.ts";
import { presaleRewardManifestRoutes } from "../modules/presale/rewards/runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

/** Signed relay proof is transport only; each existing presale kit owns business authority. */
export const PRESALE_HANDLERS = {
  "presale.sponsor.create": (request, { client }) => presaleSponsorRoute()(request, client),
  "presale.sponsor.execute": (request, { client }) => presaleSponsorExecuteRoute()(request, client),
  "presale.outcomes.commitments": (request, { client }) =>
    presaleOutcomeRouteHandlers().commitments(request, client),
  "presale.outcomes.record": (request, { client }) =>
    presaleOutcomeRouteHandlers().outcomes(request, client),
  "presale.outcomes.visitor": (request, { client }) =>
    presaleVisitorRouteHandler()(request, client),
  "presale.allowlists.create": (request, { client }) =>
    presaleAllowlistRoutes().create(request, client),
  "presale.allowlists.read": (request, { client }) =>
    presaleAllowlistRoutes().read(request, client),
  "presale.allowlists.entries": (request, { client }) =>
    presaleAllowlistRoutes().entries(request, client),
  "presale.allowlists.bind": (request, { client }) =>
    presaleAllowlistBindingRoutes().bind(request, client),
  "presale.allowlists.proof": (request, { client }) =>
    presaleAllowlistBindingRoutes().proof(request, client),
  "presale.bridge.quote": (request, { client }) => presaleBridgeRoutes().quote(request, client),
  "presale.bridge.register": (request, { client }) =>
    presaleBridgeRoutes().register(request, client),
  "presale.bridge.status": (request, { client }) => presaleBridgeRoutes().status(request, client),
  "presale.rewards.manifest": (request, { client }) =>
    presaleRewardManifestRoutes().manifest(request, client),
} satisfies PrivateHandlers;
