import { WebSocket } from "undici";
import { publicErrorResponse } from "@blast/core/lib/http-errors.ts";
import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import { instanceRouteLimiter, withRouteLimits } from "@blast/core/modules/web-security/route-limits.ts";
import { BLAST_INFRA_KEY_HEADER, blastInfraApiKey, blastInfraSocketUrl } from "@blast/core/modules/read-routing/blast-infra.ts";

import { ActivityHintRelay, type RelaySocket } from "./hint-relay.ts";

if (typeof window !== "undefined") throw new Error("Activity hint relay is server-only.");

export function openActivitySocket(): RelaySocket {
  const key = blastInfraApiKey();
  if (!key) throw new Error("Activity hints require the server's infra key.");
  const url = blastInfraSocketUrl();
  // Undici refuses redirects, keeping the key on the configured origin.
  return new WebSocket(url, { headers: { [BLAST_INFRA_KEY_HEADER]: key } });
}

/** A cross-site request, refused before anything is opened or minted. */
export function hintOriginRefusal(request: Request): Response | null {
  const site = request.headers.get("sec-fetch-site");
  const origin = request.headers.get("origin");
  return (site && site !== "same-origin") || (origin && origin !== new URL(request.url).origin)
    ? publicErrorResponse("origin_invalid", "Use Blast on its own site to continue.", 403)
    : null;
}

export function activityHintRelay(): ActivityHintRelay {
  return processSingleton("social.activity-hints", () => new ActivityHintRelay(openActivitySocket));
}

/** The API gate and launch flags apply in proxy.ts; no viewer data crosses this stream. */
export function activityHintStream(request: Request, client: ClientAddress): Promise<Response> {
  return withRouteLimits(client, ["social_read"], async () => {
    return hintOriginRefusal(request) ?? activityHintRelay().stream(request);
  }, { limiter: instanceRouteLimiter() });
}
