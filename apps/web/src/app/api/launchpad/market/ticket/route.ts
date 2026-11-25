import { mintLiveTicket } from "@blast/core/modules/launchpad-contract/live-ticket.ts";
import { LIVE_BUCKET_HEADER } from "#web/lib/live-stream/live-socket-source.ts";
import { webConfig } from "#web/lib/server-config.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A 60-second, single-use ticket for the direct market socket. 204 while the
 * socket is off or this browser's bucket is outside the rollout: the tab keeps
 * the SSE relay. The proxy's API gate admits only first-party browsers; the
 * socket's per-address limits bound how often tickets are spent.
 */
export function POST(request: Request): Response {
  const { liveSocket, relay } = webConfig();
  const header = request.headers.get(LIVE_BUCKET_HEADER);
  const bucket = header && /^\d{1,2}$/.test(header) ? Number(header) : 100;
  const headers = { "Cache-Control": "no-store" };
  if (!liveSocket || !relay.hints || bucket >= liveSocket.rolloutPercent) {
    return new Response(null, { status: 204, headers });
  }
  const { ticket, expiresAtMs } = mintLiveTicket(relay.hints.secret, relay.siteOrigin);
  return Response.json({ url: liveSocket.url, ticket, expires_at_ms: expiresAtMs }, { headers });
}
