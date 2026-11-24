import { routeSegments } from "@blast/core/modules/backend-api/route-path.ts";
import { VESTING_SCHEDULE_PATH } from "@blast/core/modules/backend-api/private/vesting-contracts.ts";
import { VestingReadError } from "@blast/core/modules/vesting/errors.ts";
import { readVesting } from "../modules/vesting/read.ts";
import type { PrivateHandlers } from "./handler.ts";

export function vestingReadHandler(read: typeof readVesting = readVesting) {
  return async (request: Request): Promise<Response> => {
    try {
      const scheduleId = routeSegments(VESTING_SCHEDULE_PATH, new URL(request.url).pathname)?.scheduleId ?? "";
      return Response.json(await read(decodeURIComponent(scheduleId)), {
        headers: { "Cache-Control": "no-store" },
      });
    } catch (error) {
      const reason =
        error instanceof VestingReadError ? error.reason : "unavailable";
      return Response.json(
        { error: { code: reason } },
        {
          status:
            reason === "not_found" ? 404 : reason === "unsupported" ? 422 : 503,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
  };
}

const handleRead = vestingReadHandler();

export const VESTING_HANDLERS = {
  "vesting.public.read": (request) => handleRead(request),
} satisfies PrivateHandlers;
