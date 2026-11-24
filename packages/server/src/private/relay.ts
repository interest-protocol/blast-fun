import { MARKET_STREAM_ROUTE_ID } from "@blast/core/modules/launchpad-contract/market-stream.ts";
import { isLaunchEnabled } from "@blast/core/lib/launch-flags.ts";
import { privateBodyDeadlineMs } from "@blast/core/modules/backend-api/private-body.ts";
import { frontendClientAddress } from "@blast/core/modules/backend-api/frontend-ingress.ts";
import {
  privateRoute,
  type PrivatePurpose,
} from "@blast/core/modules/backend-api/private-routes.ts";
import { stripPrivateHeaders } from "@blast/core/modules/backend-api/private-gateway.ts";
import { callBackend } from "@blast/core/modules/backend-api/relay-client.ts";
import { relayConfig, type RelayConfig, type RelayUpstream } from "@blast/server/private/relay-config.ts";

type Dependencies = Readonly<{
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  clientAddress?: (request: Request) => string | null;
}>;

function unavailable(): Response {
  return Response.json(
    { error: { code: "service_unavailable" } },
    {
      status: 503,
      headers: { "Cache-Control": "private, no-store", "Retry-After": "5" },
    },
  );
}

/** Connected streams go to the isolated hints role alone; without it they fail closed. */
function upstream(id: string, config: RelayConfig): RelayUpstream | null {
  if (id === "social.activity.hints" || id === MARKET_STREAM_ROUTE_ID) return config.hints;
  if (config.apiOrigin === null || config.gatewaySecret === null) return null;
  return { origin: config.apiOrigin, secret: config.gatewaySecret };
}

/** A bounded same-origin adapter: it owns transport only, never session or business decisions. */
export function privateBackendRelay(
  config: RelayConfig,
  dependencies: Dependencies = {},
) {
  return async (
    request: Request,
    purpose: PrivatePurpose = "browser",
  ): Promise<Response> => {
    try {
      const source = new URL(request.url);
      const contract = privateRoute(request.method, source.pathname, purpose);
      if (!contract)
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      if (request.headers.has("x-blast-partner-key"))
        return Response.json(
          { error: { code: "private_gateway_forbidden" } },
          { status: 403 },
        );
      const ip = (
        dependencies.clientAddress ??
        ((incoming) => frontendClientAddress(incoming, config.ingress))
      )(request);
      if (!ip) return unavailable();
      const target = upstream(contract.id, config);
      if (!target || config.quotaNamespace === null) return unavailable();
      if (source.origin !== config.siteOrigin) return unavailable();
      // The signed stream follows the same launch gates as the presale activity read.
      if (contract.id === MARKET_STREAM_ROUTE_ID && source.searchParams.has("presale") &&
          !(isLaunchEnabled("presale") && isLaunchEnabled("social") && isLaunchEnabled("trading"))) {
        source.searchParams.delete("presale");
      }
      const body = await readBody(request, contract.maxBodyBytes);
      const headers = new Headers(request.headers);
      stripPrivateHeaders(headers);
      headers.set("accept-encoding", "identity");
      return await callBackend({
        url: new URL(source.pathname + source.search, target.origin),
        method: request.method,
        headers,
        body,
        signing: {
          scheme: "private",
          secret: target.secret,
          context: { namespace: config.quotaNamespace, purpose, siteOrigin: config.siteOrigin, ip },
        },
        signal: request.signal,
        timeoutMs: (contract.workBudgetMs ?? 30_000) + 5_000,
        // Owners retain redirect policy; transport never follows with signed credentials.
        redirect: "manual",
        cache: "no-store",
        fetch: dependencies.fetch,
      });
    } catch (error) {
      return error instanceof Response ? error : unavailable();
    }
  };
}

/** A config that does not parse answers 503, as a missing upstream does. */
function configuredRelay(): ReturnType<typeof privateBackendRelay> | null {
  try {
    return privateBackendRelay(relayConfig());
  } catch {
    return null;
  }
}

export async function backendPrivateRequest(request: Request): Promise<Response> {
  return (await configuredRelay()?.(request)) ?? unavailable();
}

export async function backendPrivateServerRead(request: Request): Promise<Response> {
  return (await configuredRelay()?.(request, "ssr-read")) ?? unavailable();
}

async function readBody(
  request: Request,
  maximum: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const tooLarge = () =>
    Response.json({ error: { code: "body_too_large" } }, { status: 413 });
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maximum))
    throw tooLarge();
  if (!request.body) return new Uint8Array();
  const signal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(privateBodyDeadlineMs(maximum)),
  ]);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximum) {
        void reader.cancel().catch(() => {});
        throw tooLarge();
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
