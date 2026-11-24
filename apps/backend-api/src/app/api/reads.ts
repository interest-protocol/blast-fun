import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import { recordMetric } from "@blast/core/lib/metrics.ts";
import type { RateBucket, RateLimitPort } from "@blast/core/lib/web-security/rate-limits.ts";
import {
  firstPartyReadRoute,
  partnerV1Route,
  type PartnerV1Read,
} from "@blast/server/modules/partner-api/v1/paths.ts";
import { projectedResponse, v1Projection } from "@blast/server/modules/partner-api/v1/presales.ts";
import {
  anonymousPartnerHeaders,
  applyPartnerApiHeaders,
} from "@blast/server/modules/partner-api/v1/response.ts";
import type { PartnerV1Handlers } from "@blast/server/modules/partner-api/v1/route.ts";

import type { Admitted } from "./admission/contract.ts";
import { createReadHttp } from "./read-http.ts";

/** Serves admitted reads; handlers draw their endpoint budget only from the prepaid port. */
export function createReadHandlers(createHandlers: (limiter: RateLimitPort) => PartnerV1Handlers) {
  const handlersByBucket = new Map<RateBucket, PartnerV1Handlers>();
  const http = createReadHttp();

  return { readPartner, readFirstParty, dispose: http.dispose };

  async function readPartner(admission: Admitted) {
    const { request, headers } = admission;
    try {
      const response = await read(admission, true);
      response.headers.set("Cache-Control", "private, no-store");
      response.headers.set("CDN-Cache-Control", "no-store");
      response.headers.set("Vercel-CDN-Cache-Control", "no-store");
      response.headers.set("X-Blast-Api-Version", "1");
      return applyPartnerApiHeaders(response, headers);
    } catch (cause) {
      const response = publicErrorResponse(
        "partner_api_unavailable",
        "Partner API is temporarily unavailable.",
        503,
        { cause },
      );
      if (request.method === "HEAD") {
        await response.body?.cancel();
      }
      return applyPartnerApiHeaders(
        new Response(request.method === "HEAD" ? null : response.body, {
          status: response.status,
          headers: response.headers,
        }),
        headers,
      );
    }
  }

  function readFirstParty(admission: Admitted): Promise<Response> {
    recordMetric("backend.read", { caller: "anonymous" });
    return read(admission, false);
  }

  function read({ request, client, endpoint, prepaid }: Admitted, partner: boolean) {
    const path = new URL(request.url).pathname;
    const headers = anonymousPartnerHeaders(request);
    // Admission validated Origin; downstream public reads are anonymous.
    headers.delete("origin");
    const owners = handlersFor(endpoint, prepaid);
    const route = partner ? partnerV1Route(path) : firstPartyReadRoute(path);
    if (route?.name === "market") {
      return serve(route.name, route.sourcePath);
    }
    return http.handle(request, ({ name, prefix }) =>
      serve(name, prefix + path.slice("/api/v1".length)),
    );

    async function serve(name: PartnerV1Read, sourcePath: string) {
      const url = new URL(request.url);
      const projection = partner ? v1Projection(name, path) : null;
      url.pathname = sourcePath;
      const answer = await owners[name](
        new Request(url, { method: "GET", headers, signal: request.signal }),
        client,
      );
      const response = projection ? await projectedResponse(answer, projection) : answer;
      if (request.method === "HEAD") {
        await response.body?.cancel();
      }
      return new Response(request.method === "HEAD" ? null : response.body, {
        status: response.status,
        headers: response.headers,
      });
    }
  }

  function handlersFor(bucket: RateBucket, prepaid: RateLimitPort): PartnerV1Handlers {
    const existing = handlersByBucket.get(bucket);
    if (existing) {
      return existing;
    }
    const created = createHandlers(prepaid);
    handlersByBucket.set(bucket, created);
    return created;
  }
}
