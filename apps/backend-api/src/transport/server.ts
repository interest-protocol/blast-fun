import { privateRoute } from "@blast/core/modules/backend-api/private-routes.ts";
import type { Server } from "bun";
import { TRANSPORT_LIMITS, type BackendHttpOptions } from "./contracts.ts";
import type { createTransportHttp } from "./http.ts";

export type BackendServerOptions = BackendHttpOptions &
  Readonly<{ port?: number; hostname?: string }>;

/** Bun owns the socket and passes the peer address and request count to the transport. */
export function serveBackend(
  options: Pick<BackendServerOptions, "port" | "hostname" | "privateApi">,
  http: ReturnType<typeof createTransportHttp>,
) {
  const server: Server<undefined> = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    development: false,
    idleTimeout: 5,
    maxRequestBodySize: Math.max(
      TRANSPORT_LIMITS.adminBodyBytes,
      TRANSPORT_LIMITS.privateBodyBytes,
    ),
    fetch(request, native) {
      if (
        options.privateApi &&
        privateRoute(request.method, new URL(request.url).pathname, "browser")
      ) {
        native.timeout(request, 40);
      }
      return http.fetch(
        request,
        native.requestIP(request)?.address ?? null,
        native.pendingRequests,
        (contract) => {
          const seconds = Math.ceil((contract.workBudgetMs ?? 30_000) / 1_000) + 10;
          // Bun accepts at most 255 seconds. Only an authenticated selected long
          // request disables socket idleness; the finite HTTP lifetime still owns it.
          native.timeout(request, seconds > 255 ? 0 : seconds);
        },
      );
    },
    error() {
      return Response.json(
        { error: { code: "service_unavailable" } },
        {
          status: 503,
          headers: {
            "Cache-Control": "private, no-store",
            "Retry-After": "5",
            "X-Content-Type-Options": "nosniff",
            "X-Request-ID": crypto.randomUUID(),
          },
        },
      );
    },
  });
  let stopped: Promise<void> | undefined;
  return {
    server,
    drainTimeoutMs: http.drainTimeoutMs,
    drain() {
      stopped ??= Promise.all([http.drain(), server.stop()]).then(() => {});
      return stopped;
    },
  };
}
