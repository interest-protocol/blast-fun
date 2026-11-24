import type { RedisCommands } from "@blast/core/lib/redis.ts";
import { attestClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import {
  PRIVATE_PROOF_TTL_SECONDS,
  stripPrivateHeaders,
  verifyPrivateBody,
  verifyPrivateEnvelope,
  type VerifiedPrivateProof,
} from "@blast/core/modules/backend-api/private-gateway.ts";
import type { PrivateRouteContract } from "@blast/core/modules/backend-api/private-routes.ts";
import type { PrivateHandler } from "@blast/server/private/handler.ts";
import { boundedPrivateBody } from "./body.ts";

export type PrivateApi = Readonly<{
  siteOrigin: string;
  /** A narrow process may accept only its own capabilities. */
  allowedRoutes?: readonly string[];
  handle: PrivateHandler;
}>;

/** Verify the received bytes, burn a purpose-specific nonce, then restore the frontend URL. */
export async function privateRequest(
  request: Request,
  contract: PrivateRouteContract,
  options: Readonly<{
    redis: RedisCommands;
    namespace: string;
    gatewaySecret: string;
    privateApi: PrivateApi;
    onAuthenticated?: (proof: VerifiedPrivateProof) => void;
  }>,
  signal: AbortSignal,
): Promise<Response> {
  const refuse = (status: number, code: string) =>
    Response.json(
      { error: { code } },
      { status, headers: { "Cache-Control": "private, no-store" } },
    );
  if (options.privateApi.allowedRoutes && !options.privateApi.allowedRoutes.includes(contract.id)) {
    return refuse(403, "private_gateway_forbidden");
  }
  const proof = verifyPrivateEnvelope(request, options.gatewaySecret, {
    namespace: options.namespace,
    siteOrigin: options.privateApi.siteOrigin,
  });
  // The envelope admits only a canonical proof.ip, so a null client here is a broken proof.
  const client = attestClientAddress(proof?.ip ?? null);
  if (!proof || !client || proof.route.id !== contract.id) {
    return refuse(403, "private_gateway_forbidden");
  }
  options.onAuthenticated?.(proof);
  const body = await boundedPrivateBody(request, contract.maxBodyBytes, signal);
  if (!verifyPrivateBody(body, proof)) {
    return refuse(403, "private_gateway_forbidden");
  }
  const accepted = await options.redis.execute([
    "SET",
    `${options.namespace}:{partner-quota}:private-replay:${proof.nonce}`,
    "1",
    "NX",
    "EX",
    String(PRIVATE_PROOF_TTL_SECONDS),
  ]);
  if (accepted !== "OK") {
    return refuse(403, "private_gateway_replayed");
  }
  signal.throwIfAborted();
  const source = new URL(request.url);
  const headers = new Headers(request.headers);
  stripPrivateHeaders(headers);
  headers.delete("host");
  headers.delete("content-length");
  if (proof.purpose === "ssr-read") {
    headers.set("origin", proof.siteOrigin);
    headers.set("sec-fetch-site", "same-origin");
  }
  const canonical = new Request(proof.siteOrigin + source.pathname + source.search, {
    method: request.method,
    headers,
    signal,
    ...(body.byteLength ? { body } : {}),
  });
  return options.privateApi.handle(canonical, { proof, client });
}
