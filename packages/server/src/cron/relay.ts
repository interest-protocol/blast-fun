import { cronRoute } from "@blast/core/modules/backend-api/cron-routes.ts";
import { callBackend } from "@blast/core/modules/backend-api/relay-client.ts";
import { relayConfig, type RelayConfig } from "@blast/server/private/relay-config.ts";

type Dependencies = Readonly<{ fetch?: typeof fetch }>;

function unavailable(): Response {
  return Response.json(
    { error: { code: "service_unavailable" } },
    {
      status: 503,
      headers: { "Cache-Control": "no-store", "Retry-After": "5" },
    },
  );
}

/** A cron relay grants no authority itself: only the backend verifies the Authorization header. */
export function cronBackendRelay(
  config: Pick<RelayConfig, "apiOrigin">,
  dependencies: Dependencies = {},
) {
  return async (request: Request): Promise<Response> => {
    try {
      const contract = cronRoute(request.method, new URL(request.url).pathname);
      if (!contract)
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      const origin = config.apiOrigin;
      if (origin === null) return unavailable();
      const length = request.headers.get("content-length");
      if (length && (!/^\d+$/.test(length) || Number(length) !== 0)) {
        return Response.json(
          { error: { code: "body_too_large" } },
          { status: 413 },
        );
      }
      const headers = new Headers();
      const authorization = request.headers.get("authorization");
      if (authorization) headers.set("authorization", authorization);
      const response = await callBackend({
        url: new URL(contract.path, origin),
        method: contract.method,
        headers,
        signing: { scheme: "unsigned" },
        signal: request.signal,
        timeoutMs: contract.workBudgetMs + 5_000,
        redirect: "error",
        cache: "no-store",
        fetch: dependencies.fetch,
      });
      if (request.method !== "HEAD") return response;
      await response.body?.cancel();
      return new Response(null, { status: response.status, headers: response.headers });
    } catch {
      return unavailable();
    }
  };
}

export async function backendCronRequest(request: Request): Promise<Response> {
  let config: RelayConfig;
  try {
    config = relayConfig();
  } catch {
    return unavailable();
  }
  return cronBackendRelay(config)(request);
}
