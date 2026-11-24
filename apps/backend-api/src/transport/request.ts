import { attestClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { ingressAddress } from "@blast/core/lib/web-security/ingress.ts";
import { cronRoute } from "@blast/core/modules/backend-api/cron-routes.ts";
import {
  INTERNAL_READ_PREFIX,
  stripGatewayHeaders,
  verifyGatewayRequest,
} from "@blast/core/modules/backend-api/gateway.ts";
import {
  OPERATOR_METHODS,
  operatorRoute,
} from "@blast/core/modules/backend-api/operator-routes.ts";
import { privateRoute } from "@blast/core/modules/backend-api/private-routes.ts";
import { bearerMatches } from "@blast/server/lib/bearer.ts";
import { unauthorizedCron } from "./cron.ts";

import { TRANSPORT_LIMITS, type BackendHttpOptions } from "./contracts.ts";
import { operatorRefusal, refusal } from "./responses.ts";

export type RequestTarget = Exclude<ReturnType<typeof requestTarget>, Response>;

/** Classify and authenticate capabilities before any transport admission or owner work. */
export function requestTarget(request: Request, options: BackendHttpOptions) {
  const path = new URL(request.url).pathname;
  if (exceedsHeaderLimit(request)) {
    return refusal(431, "headers_too_large");
  }
  if (path.startsWith("//")) {
    return refusal(400, "invalid_target");
  }
  const cronContract = cronRoute(request.method, path);
  const privateContract =
    privateRoute(request.method, path, "browser") ?? privateRoute(request.method, path, "ssr-read");
  const privateProof = [...request.headers.keys()].some((name) =>
    name.startsWith("x-blast-private-"),
  );
  if (privateProof && (!privateContract || !options.privateApi)) {
    return refusal(403, "private_gateway_forbidden");
  }
  if (privateContract && !privateProof) {
    return refusal(403, "private_gateway_forbidden");
  }
  if (cronContract && !(options.cronApi && bearerMatches(request, options.cronSecret))) {
    return unauthorizedCron();
  }
  if (path === "/api/admin" || path.startsWith("/api/admin/")) {
    const operator = operatorTarget(request, path, options);
    return operator instanceof Response
      ? operator
      : { path, operator, privateContract, cronContract };
  }
  if (!privateContract && !cronContract && !readOnly(request)) {
    return refusal(405, "read_only");
  }
  return { path, operator: null, privateContract, cronContract };
}

function operatorTarget(request: Request, path: string, options: BackendHttpOptions) {
  if (!OPERATOR_METHODS.has(request.method)) {
    return refusal(405, "method_not_allowed");
  }
  const operator = operatorRoute(path)?.route;
  if (!operator) {
    return operatorRefusal(404, "Not found");
  }
  if (operator.auth === "operator" && !bearerMatches(request, options.adminToken)) {
    return operatorRefusal(401, "Unauthorized");
  }
  return operator;
}

export async function authenticate(
  request: Request,
  peer: string | null,
  options: BackendHttpOptions,
  signal: AbortSignal,
  operator: boolean,
) {
  const suppliedGateway = request.headers.has("x-blast-gateway-signature");
  // The v1 proof authenticates a read relay, never an operator or a write capability.
  if (operator && suppliedGateway) {
    return null;
  }
  const gateway = suppliedGateway
    ? verifyGatewayRequest(request, options.gatewaySecret, options.namespace)
    : null;
  if (
    (suppliedGateway && !gateway) ||
    (new URL(request.url).pathname.startsWith(INTERNAL_READ_PREFIX + "/") && !gateway)
  ) {
    return null;
  }
  signal.throwIfAborted();
  const peerIp = ingressAddress(request, peer, options.ingress ?? { mode: "direct" });
  const client = attestClientAddress(gateway ? gateway.ip : peerIp);
  if (!peerIp || !client) {
    throw new Error("Client identity is unavailable.");
  }
  const headers = new Headers(request.headers);
  stripGatewayHeaders(headers);
  const body = operator
    ? await adminBody(
        request,
        AbortSignal.any([signal, AbortSignal.timeout(TRANSPORT_LIMITS.deadlineMs)]),
      )
    : null;
  if (body && request.method === "GET") {
    throw refusal(405, "body_not_allowed");
  }
  return {
    request: new Request(request.url, {
      method: request.method,
      headers,
      body,
      signal,
    }),
    gatewayAuthenticated: !!gateway,
    gateway: gateway ?? undefined,
    client,
  };
}

async function adminBody(
  request: Request,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > TRANSPORT_LIMITS.adminBodyBytes)) {
    throw refusal(413, "body_too_large");
  }
  if (!request.body) {
    return null;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) {
        break;
      }
      bytes += next.value.byteLength;
      if (bytes > TRANSPORT_LIMITS.adminBodyBytes) {
        void reader.cancel().catch(() => {});
        throw refusal(413, "body_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  if (!bytes) {
    return null;
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function exceedsHeaderLimit(request: Request): boolean {
  const encoder = new TextEncoder();
  let bytes = encoder.encode(request.url).byteLength;
  for (const [name, value] of request.headers) {
    bytes += encoder.encode(name).byteLength + encoder.encode(value).byteLength + 4;
    if (bytes > TRANSPORT_LIMITS.headerBytes) {
      return true;
    }
  }
  return bytes > TRANSPORT_LIMITS.headerBytes;
}

function readOnly(request: Request): boolean {
  return (
    ["GET", "HEAD", "OPTIONS"].includes(request.method) &&
    !request.headers.has("transfer-encoding") &&
    Number(request.headers.get("content-length") ?? 0) === 0
  );
}
