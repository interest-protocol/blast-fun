import { ingressAddress } from "@blast/core/lib/web-security/ingress.ts";
import { MARKET_STREAM_ROUTE_ID } from "@blast/core/modules/launchpad-contract/market-stream.ts";
import {
  type createAfterResponseScheduler,
  createRequestWork,
  runWithRequestWork,
} from "@blast/server/lib/request-work.ts";
import { cronRequest } from "./cron.ts";
import { privateRequest } from "./private.ts";

import type { TransportAdmission } from "./admission.ts";
import { privateWorkBudget, workBudget } from "./budgets.ts";
import type { BackendHttpOptions, TransportContext } from "./contracts.ts";
import { requestLifetime } from "./lifetime.ts";
import type { RequestTarget } from "./request.ts";
import { authenticate } from "./request.ts";
import { refusal, unavailableCode } from "./responses.ts";

type BackgroundWork = ReturnType<typeof createAfterResponseScheduler>;

export async function executePartnerRequest(
  request: Request,
  transportContext: TransportContext,
  options: BackendHttpOptions,
  admission: TransportAdmission,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const release = admission.reservePartner();
  let releaseLane: (() => void) | undefined;
  const lifetime = requestLifetime(
    request,
    () => {
      releaseLane?.();
      release();
    },
    unavailableCode(path),
  );
  const operation = invokePartner().then(lifetime.responseBody).catch(lifetime.failed);
  return Promise.race([operation, lifetime.aborted]);

  async function invokePartner(): Promise<Response> {
    const transport = await authenticate(
      request,
      transportContext.peerAddress,
      options,
      lifetime.signal,
      false,
    );
    if (!transport) {
      return refusal(403, "gateway_forbidden");
    }
    const prepared = await options.preparePartner!(
      transport.request,
      transport.client,
      transport.gateway,
    );
    if (!prepared) {
      return options.handle(
        transport.request,
        transport.client,
        transport.gatewayAuthenticated,
        transport.gateway,
      );
    }
    if (prepared.response) {
      return prepared.response;
    }
    releaseLane = prepared.release;
    lifetime.signal.throwIfAborted();
    return prepared.handle();
  }
}

export async function executeOrdinaryRequest(
  request: Request,
  target: RequestTarget,
  transportContext: TransportContext,
  options: BackendHttpOptions,
  admission: TransportAdmission,
  background: BackgroundWork,
): Promise<Response> {
  const { path, operator, privateContract, cronContract } = target;
  const permit = admission.reserveOrdinary(target, transportContext.pendingRequests);
  let disconnectHint: (() => void) | undefined;
  let releasePrivateLane: (() => void) | undefined;
  const work = privateContract || cronContract || operator ? createRequestWork(background) : null;
  const lifetime = requestLifetime(
    request,
    () => {
      disconnectHint?.();
      const release = () => {
        releasePrivateLane?.();
        permit.release();
      };
      if (work) {
        void work.complete().then(release);
      } else {
        release();
      }
    },
    unavailableCode(path),
    workBudget(target, options.maxPrivateWorkMs),
  );

  function promoteConnectedHint(response: Response): Response {
    const stream =
      (privateContract?.id === "social.activity.hints" ||
        privateContract?.id === MARKET_STREAM_ROUTE_ID) &&
      request.method === "GET" &&
      response.status === 200 &&
      response.headers.get("content-type")?.split(";")[0]?.trim() === "text/event-stream";
    if (!stream) {
      return response;
    }
    disconnectHint = permit.connectHint(lifetime.abort, lifetime.signal);
    return response;
  }

  const operatorSignal = operator?.operationDeadlineMs
    ? AbortSignal.any([lifetime.signal, AbortSignal.timeout(operator.operationDeadlineMs)])
    : lifetime.signal;
  const operation = invokeOwner()
    .then(promoteConnectedHint)
    .then(lifetime.responseBody)
    .catch(lifetime.failed);
  return Promise.race([operation, lifetime.aborted]);

  async function invokeOwner(): Promise<Response> {
    if (cronContract && options.cronApi) {
      transportContext.authenticatedWork?.(cronContract);
      return runWithRequestWork(
        work!,
        () => cronRequest(request, cronContract, options.cronApi!, lifetime.signal),
        lifetime.signal,
      );
    }
    const privateApi = options.privateApi;
    if (privateContract && privateApi) {
      if (
        !ingressAddress(
          request,
          transportContext.peerAddress,
          options.ingress ?? { mode: "direct" },
        )
      ) {
        return refusal(403, "private_gateway_forbidden");
      }
      return runWithRequestWork(
        work!,
        () =>
          privateRequest(
            request,
            privateContract,
            {
              ...options,
              redis: options.privateReplayRedis ?? options.redis,
              privateApi,
              onAuthenticated(proof) {
                releasePrivateLane = admission.reservePrivate(proof.route);
                transportContext.authenticatedWork?.({
                  workBudgetMs: privateWorkBudget(proof.route, options.maxPrivateWorkMs),
                });
              },
            },
            lifetime.signal,
          ),
        lifetime.signal,
      );
    }
    const transport = await authenticate(
      request,
      transportContext.peerAddress,
      options,
      lifetime.signal,
      !!operator,
    );
    if (!transport) {
      return refusal(403, "gateway_forbidden");
    }
    if (operator?.workBudgetMs) {
      transportContext.authenticatedWork?.({ workBudgetMs: operator.workBudgetMs });
    }
    const handle = () =>
      options.handle(
        transport.request,
        transport.client,
        transport.gatewayAuthenticated,
        transport.gateway,
      );
    return operator ? runWithRequestWork(work!, handle, operatorSignal) : handle();
  }
}
