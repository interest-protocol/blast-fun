import { PRIVATE_ROUTES } from "@blast/core/modules/backend-api/private-routes.ts";
import { createAfterResponseScheduler } from "@blast/server/lib/request-work.ts";
import { createTransportAdmission } from "./admission.ts";
import { privateWorkBudget } from "./budgets.ts";
import type { BackendHttpOptions, TransportContext } from "./contracts.ts";
import { executeOrdinaryRequest, executePartnerRequest } from "./execution.ts";
import { createHealthProbe, createTransportReadiness } from "./health.ts";
import { requestTarget } from "./request.ts";
import { refusal } from "./responses.ts";

/** Dispatch raw Fetch requests and retain admission until work and body cleanup finish. */
export function createTransportHttp(
  options: BackendHttpOptions,
  createProbeHttp: (ready: () => Promise<boolean>) => Readonly<{
    livenessPath: string;
    readinessPath: string;
    handler: (request: Request) => Promise<Response>;
    dispose: () => Promise<void>;
  }>,
  onAfterResponseFailure: () => void,
) {
  const admission = createTransportAdmission(options);
  const background = createAfterResponseScheduler(onAfterResponseFailure);
  const healthy = createHealthProbe(options.ready);
  const { livenessPath, readinessPath, handler, dispose } = createProbeHttp(
    async () => (await healthy()) && !admission.isDraining(),
  );
  const probes = new Map<string, (request: Request) => Response | Promise<Response>>([
    [livenessPath, handler],
    [readinessPath, createTransportReadiness(readinessPath, handler, admission)],
  ]);
  let stopped: Promise<void> | undefined;

  return {
    drainTimeoutMs:
      Math.max(
        60_000,
        ...PRIVATE_ROUTES.map((route) => privateWorkBudget(route, options.maxPrivateWorkMs)),
      ) + 10_000,
    async fetch(
      request: Request,
      peerAddress: string | null,
      pendingRequests = 0,
      authenticatedWork?: (contract: Readonly<{ workBudgetMs?: number }>) => void,
    ): Promise<Response> {
      try {
        const response = await dispatch(request, {
          peerAddress,
          pendingRequests,
          authenticatedWork,
        });
        return withTransportHeaders(response);
      } catch (error) {
        const response =
          error instanceof Response && error.status !== 0
            ? error
            : refusal(503, "service_unavailable", 5);
        return withTransportHeaders(response);
      }
    },

    drain(): Promise<void> {
      background.stop();
      stopped ??= admission
        .drain()
        .then(() => background.drain())
        .finally(dispose);
      return stopped;
    },
  };

  async function dispatch(request: Request, context: TransportContext): Promise<Response> {
    const target = requestTarget(request, options);
    if (target instanceof Response) {
      return target;
    }

    const probe = probes.get(target.path);
    if (probe) {
      return probe(request);
    }
    if (options.preparePartner && target.path.startsWith("/api/v1/")) {
      return executePartnerRequest(request, context, options, admission);
    }
    return executeOrdinaryRequest(request, target, context, options, admission, background);
  }
}

function withTransportHeaders(response: Response): Response {
  // A handler may return immutable headers. Reuse its body stream and copy only the metadata.
  const result = new Response(response.body, {
    status: response.status,
    headers: response.headers,
  });
  const { headers } = result;
  if (!headers.has("X-Content-Type-Options")) {
    headers.set("X-Content-Type-Options", "nosniff");
  }
  if (!headers.has("X-Request-ID")) {
    headers.set("X-Request-ID", crypto.randomUUID());
  }
  return result;
}
