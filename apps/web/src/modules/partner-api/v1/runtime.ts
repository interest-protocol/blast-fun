import "server-only";
import {
  PARTNER_KEY_HEADER,
  partnerResponseHeaders,
  requestedHeaders,
} from "@blast/core/modules/backend-api/partner-http.ts";
import { partnerV1Route } from "@blast/server/modules/partner-api/v1/paths.ts";
import { applyPartnerApiHeaders } from "@blast/server/modules/partner-api/v1/response.ts";
import { backendFirstPartyRead, backendPartnerRelay } from "./relay.ts";

export async function partnerV1Read(request: Request): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (
    partnerV1Route(path)?.name !== "defillama" ||
    request.headers.has(PARTNER_KEY_HEADER) ||
    !["GET", "HEAD", "OPTIONS"].includes(request.method) ||
    (request.method === "OPTIONS" && requestedHeaders(request).includes(PARTNER_KEY_HEADER))
  ) {
    return backendPartnerRelay()(request);
  }

  const headers = partnerResponseHeaders("*");
  headers.set("X-Blast-Api-Version", "1");
  if (request.method === "OPTIONS") {
    const methods = "GET, HEAD, OPTIONS";
    headers.set("Allow", methods);
    headers.set("Access-Control-Allow-Methods", methods);
    return applyPartnerApiHeaders(new Response(null, { status: 204 }), headers);
  }

  const response = await backendFirstPartyRead(request);
  return applyPartnerApiHeaders(response, headers);
}
