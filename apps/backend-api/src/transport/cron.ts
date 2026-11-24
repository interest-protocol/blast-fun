import type { CronRouteContract } from "@blast/core/modules/backend-api/cron-routes.ts";
import { boundedPrivateBody } from "./body.ts";

export type CronApi = Readonly<{
  handle(request: Request): Promise<Response>;
}>;

export function unauthorizedCron(): Response {
  return Response.json(
    {
      error: {
        code: "UNAUTHORIZED",
        message: "Cron authorization is required.",
      },
    },
    { status: 401, headers: { "Cache-Control": "no-store" } },
  );
}

/** Authentication precedes admission. Jobs use their own bounded lifetimes, owned until settlement. */
export async function cronRequest(
  request: Request,
  contract: CronRouteContract,
  api: CronApi,
  signal: AbortSignal,
): Promise<Response> {
  await boundedPrivateBody(request, contract.maxBodyBytes, signal);
  signal.throwIfAborted();
  const canonical = new Request(new URL(contract.path, request.url), {
    method: contract.method,
    signal,
  });
  return api.handle(canonical);
}
