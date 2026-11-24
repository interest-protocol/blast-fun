import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { partnerV1Route, type PartnerV1Read } from "@blast/server/modules/partner-api/v1/paths.ts";
import { projectedResponse, v1Projection } from "@blast/server/modules/partner-api/v1/presales.ts";

type ReadHandler = (request: Request, client: ClientAddress) => Promise<Response>;
export type PartnerV1Handlers = Readonly<Record<PartnerV1Read, ReadHandler>>;

/**
 * The v1 transport boundary. Authentication/quota run in the regional request boundary before this adapter. Bind v1 explicitly to shared read services, not frontend route exports.
 * Future incompatible service changes require a v1 adapter or a new v2 binding.
 */
export function createPartnerV1Read(handlers: PartnerV1Handlers): ReadHandler {
  return async (request, client) => {
    const url = new URL(request.url);
    const route = partnerV1Route(url.pathname);
    if (!route) return publicErrorResponse("not_found", "Not found.", 404);
    if (!["GET", "HEAD"].includes(request.method)) {
      return publicErrorResponse("partner_read_only", "Partner access is read-only.", 405, { headers: { Allow: "GET, HEAD, OPTIONS" } });
    }
    const projection = v1Projection(route.name, url.pathname);
    url.pathname = route.sourcePath;
    // Preserve repeated query parameters, encoded types and opaque cursors.
    const headers = new Headers(request.headers);
    for (const name of ["cookie", "authorization", "x-blast-api-key", "x-blast-partner-key"]) headers.delete(name);
    const answer = await handlers[route.name](new Request(url, { method: "GET", headers, signal: request.signal }), client);
    const response = projection ? await projectedResponse(answer, projection) : answer;
    const responseHeaders = new Headers(response.headers);
    responseHeaders.set("Cache-Control", "private, no-store");
    responseHeaders.set("CDN-Cache-Control", "no-store");
    responseHeaders.set("Vercel-CDN-Cache-Control", "no-store");
    responseHeaders.set("X-Blast-Api-Version", "1");
    if (request.method === "HEAD") await response.body?.cancel();
    return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers: responseHeaders });
  };
}
