import { privateRoute } from "@blast/core/modules/backend-api/private-routes.ts";
import type { Server } from "bun";
import { TRANSPORT_LIMITS, type BackendHttpOptions } from "./contracts.ts";
import type { createTransportHttp } from "./http.ts";
import { LIVE_SOCKET, type LiveSocket, type LiveSocketData } from "./live-socket.ts";

export type BackendServerOptions = BackendHttpOptions &
  Readonly<{ port?: number; hostname?: string }>;

/** Bun owns the socket and passes the peer address and request count to the transport. */
export function serveBackend(
  options: Pick<BackendServerOptions, "port" | "hostname" | "privateApi">,
  http: ReturnType<typeof createTransportHttp>,
  live?: LiveSocket,
) {
  const server: Server<LiveSocketData> = Bun.serve<LiveSocketData>({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    development: false,
    idleTimeout: 5,
    maxRequestBodySize: Math.max(
      TRANSPORT_LIMITS.adminBodyBytes,
      TRANSPORT_LIMITS.privateBodyBytes,
    ),
    // Without a live host nothing upgrades, so the empty handler never runs.
    websocket: live?.websocket ?? { message() {} },
    fetch(request, native) {
      if (live && new URL(request.url).pathname === LIVE_SOCKET.path) {
        return live.upgrade(request, native, native.requestIP(request)?.address ?? null);
      }
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
      stopped ??= Promise.all([http.drain(), live?.drain(), server.stop()]).then(() => {});
      return stopped;
    },
  };
}
