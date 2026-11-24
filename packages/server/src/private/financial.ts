import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import {
  myVestingsRoute,
  vestingAttemptRoute,
} from "../modules/vesting/routes.ts";
import { socialBridgeWithdrawRoutes } from "../modules/social/bridge-withdraw/runtime.ts";
import type { PrivateHandler, PrivateHandlers } from "./handler.ts";

/** A verified HEAD follows the existing GET business branch; HTTP owns body settlement. */
function headAsGet(handler: (request: Request, client: ClientAddress) => Promise<Response>): PrivateHandler {
  return (request, { client }) =>
    handler(
      request.method === "HEAD"
        ? new Request(request, { method: "GET" })
        : request,
      client,
    );
}

export const FINANCIAL_HANDLERS = {
  "social.vesting.mine": headAsGet(myVestingsRoute),
  "social.vesting.attempt.read": headAsGet(vestingAttemptRoute),
  "social.vesting.attempt.prepare": headAsGet(vestingAttemptRoute),
  "social.bridge.withdraw.quote": headAsGet((request, client) =>
    socialBridgeWithdrawRoutes().quote.GET(request, client),
  ),
  "social.bridge.withdraw.create": headAsGet((request, client) =>
    socialBridgeWithdrawRoutes().create.POST(request, client),
  ),
  "social.bridge.withdraw.settle": headAsGet((request, client) =>
    socialBridgeWithdrawRoutes().settle.POST(request, client),
  ),
} satisfies PrivateHandlers;
