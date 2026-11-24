import { frontendClientAddress } from "@blast/core/modules/backend-api/frontend-ingress.ts";
import { relayConfig, type RelayConfig } from "@blast/server/private/relay-config.ts";
import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import { INTERNAL_READ_PREFIX } from "@blast/core/modules/backend-api/gateway.ts";
import { callBackend } from "@blast/core/modules/backend-api/relay-client.ts";
import { firstPartyReadCodes } from "@blast/server/modules/partner-api/v1/failures.ts";
import {
  canonicalFirstPartyAlias,
  firstPartyReadRoute,
  partnerV1Route,
} from "@blast/server/modules/partner-api/v1/paths.ts";
import { projectedResponse, v1Projection } from "@blast/server/modules/partner-api/v1/presales.ts";
import { partnerResponseHeaders } from "@blast/core/modules/backend-api/partner-http.ts";
import {
  anonymousPartnerHeaders,
  applyPartnerApiHeaders,
} from "@blast/server/modules/partner-api/v1/response.ts";

type ReadHandler = (request: Request) => Promise<Response>;

function unavailable(code = "partner_api_unavailable"): Response {
  return publicErrorResponse(
    code,
    "Public API is temporarily unavailable.",
    503,
    { headers: { "Retry-After": "5" } },
  );
}

function partnerUnavailable(request: Request): Response {
  return applyPartnerApiHeaders(
    unavailable(),
    partnerResponseHeaders(request.headers.get("origin")),
  );
}

export function createBackendRelay(
  origin: string,
  secret: string,
  options: {
    namespace: string;
    firstParty?: boolean;
    clientAddress: (request: Request) => string | null;
    fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  },
): ReadHandler {
  return async (request) => {
    try {
      if (options.firstParty && request.headers.has("x-blast-partner-key")) {
        return publicErrorResponse(
          "partner_read_forbidden",
          "Use the partner API for partner credentials.",
          403,
        );
      }
      const clientAddress = options.clientAddress(request);
      if (!clientAddress) throw new Error("Untrusted frontend ingress");
      const source = new URL(request.url);
      const canonicalPath = options.firstParty
        ? firstPartyCanonicalPath(source.pathname)
        : source.pathname;
      if (!canonicalPath || !(options.firstParty ? firstPartyReadRoute(canonicalPath) : partnerV1Route(canonicalPath))) {
        if (options.firstParty)
          return publicErrorResponse(
            "partner_read_forbidden",
            "This endpoint is not available.",
            403,
          );
        return applyPartnerApiHeaders(
          publicErrorResponse("not_found", "Not found.", 404),
          partnerResponseHeaders(request.headers.get("origin")),
        );
      }
      const target = new URL(
        (options.firstParty ? INTERNAL_READ_PREFIX : "") +
          canonicalPath +
          source.search,
        origin,
      );
      const relayed = await callBackend({
        url: target,
        method: request.method,
        headers: relayRequestHeaders(request, options.firstParty),
        signing: { scheme: "gateway", secret, ip: clientAddress, namespace: options.namespace },
        signal: request.signal,
        timeoutMs: 5_000,
        redirect: "error",
        fetch: options.fetch,
      });
      // Partners get the published v1 shape whatever the backend's version; first-party reads
      // keep every field (blast-v2#566).
      const projection = options.firstParty || request.method !== "GET" ? null : v1Projection(partnerV1Route(canonicalPath)!.name, canonicalPath);
      return projection ? await projectedResponse(relayed, projection) : relayed;
    } catch {
      if (!options.firstParty) return partnerUnavailable(request);
      const path = firstPartyCanonicalPath(new URL(request.url).pathname);
      return unavailable(firstPartyReadCodes(path ?? "").unavailable);
    }
  };
}

/** Anonymous upstream headers; only the partner (not first-party) relay forwards its key. */
function relayRequestHeaders(
  request: Request,
  firstParty: boolean | undefined,
): Headers {
  const headers = anonymousPartnerHeaders(request);
  if (!firstParty && request.headers.has("x-blast-partner-key"))
    headers.set(
      "x-blast-partner-key",
      request.headers.get("x-blast-partner-key")!,
    );
  headers.set("accept-encoding", "identity");
  return headers;
}

/** The relay `config` configures, or null while its origin, secret or namespace is unset. */
function configuredRelay(config: RelayConfig, firstParty: boolean): ReadHandler | null {
  if (config.apiOrigin === null || config.gatewaySecret === null || config.quotaNamespace === null) return null;
  return createBackendRelay(config.apiOrigin, config.gatewaySecret, {
    firstParty,
    namespace: config.quotaNamespace,
    clientAddress: (request) => frontendClientAddress(request, config.ingress),
  });
}

/** The partner relay over `config`, else the process's; a missing or unparsable config answers 503. */
export function backendPartnerRelay(config?: RelayConfig): ReadHandler {
  try {
    return configuredRelay(config ?? relayConfig(), false) ?? (async (request) => partnerUnavailable(request));
  } catch {
    return async (request) => partnerUnavailable(request);
  }
}

/** Only explicitly public frontend paths can use the authenticated read relay. */
export function firstPartyCanonicalPath(path: string): string | null {
  if (partnerV1Route(path)?.name === "defillama") return path;
  let canonical: string;
  if (path.startsWith("/api/social/presales") || path === "/api/social/prices")
    canonical = "/api/v1" + path.slice("/api/social".length);
  else if (
    path.startsWith("/api/launchpad/market/") ||
    path.startsWith("/api/launchpad/wallets/") ||
    ["/api/launchpad/discovery", "/api/launchpad/search"].includes(path)
  )
    canonical = "/api/v1" + path.slice("/api/launchpad".length);
  else return null;
  // The validated browser client uses blast-infra’s resource name.
  canonical = canonicalFirstPartyAlias(canonical);
  return firstPartyReadRoute(canonical) ? canonical : null;
}

export async function backendFirstPartyRead(
  request: Request,
  config?: RelayConfig,
): Promise<Response> {
  let relay: ReadHandler | null;
  try {
    relay = configuredRelay(config ?? relayConfig(), true);
  } catch {
    relay = null;
  }
  if (relay) return relay(request);
  return unavailable(
    firstPartyReadCodes(
      firstPartyCanonicalPath(new URL(request.url).pathname) ?? "",
    ).unavailable,
  );
}
