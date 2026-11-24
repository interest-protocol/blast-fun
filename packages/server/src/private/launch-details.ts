import { routeSegments } from "@blast/core/modules/backend-api/route-path.ts";
import { LAUNCH_DETAILS_PATH } from "@blast/core/modules/backend-api/private/coin-page-contracts.ts";
import { parseLaunchId } from "@blast/core/lib/launchpad/launch-id.ts";
import { readLaunchDetails } from "@blast/server/modules/social/launch/details.ts";
import { publicReadCache } from "@blast/server/modules/public-reads/shared-runtime.ts";
import type { PrivateHandlers } from "./handler.ts";

/** Every Home and Bonding render reads the pinned curves' details, and a publication's words change rarely: one read serves them all this long. */
const DETAILS_SHARE_MS = 10_000;

/** The details through the shared public cache; wrapped, so an absent publication (null) is shared too. */
async function sharedLaunchDetails(launchId: string) {
  const { details } = await publicReadCache("market")(
    `launch-details:${launchId}`,
    async () => ({ details: await readLaunchDetails(launchId) }),
    DETAILS_SHARE_MS,
  );
  return details;
}

/** A public projection carried by the signed first-party transport, independently of market reads. */
export function launchDetailsHandler(read = sharedLaunchDetails) {
  return async (request: Request): Promise<Response> => {
    const headers = { "Cache-Control": "private, no-store" };
    const launchId = parseLaunchId(
      routeSegments(LAUNCH_DETAILS_PATH, new URL(request.url).pathname)?.launchId ?? "",
    );
    if (!launchId)
      return Response.json(
        { error: { code: "invalid_launch_id" } },
        { status: 400, headers },
      );
    try {
      return Response.json({ details: await read(launchId) }, { headers });
    } catch {
      return Response.json(
        { error: { code: "launch_details_unavailable" } },
        { status: 503, headers },
      );
    }
  };
}

const read = launchDetailsHandler();
export const LAUNCH_DETAILS_HANDLERS = {
  "launchpad.launch-details.read": (request) => read(request),
} satisfies PrivateHandlers;
