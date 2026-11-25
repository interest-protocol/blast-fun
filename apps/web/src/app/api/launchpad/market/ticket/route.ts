import { mintLiveTicket } from "@blast/core/modules/launchpad-contract/live-ticket.ts";
import { webConfig } from "#web/lib/server-config.ts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * A 60-second, single-use ticket for the direct market socket. 204 while the
 * socket is off (`BLAST_LIVE_SOCKET_URL` unset): the tab has no live stream
 * and asks again later. The proxy's API gate admits only first-party browsers;
 * the socket's per-address limits bound how often tickets are spent.
 */
export function POST(): Response {
  const { liveSocket, relay } = webConfig();
  const headers = { "Cache-Control": "no-store" };
  if (!liveSocket || !relay.hints) {
    return new Response(null, { status: 204, headers });
  }
  const { ticket, expiresAtMs } = mintLiveTicket(relay.hints.secret, relay.siteOrigin);
  return Response.json({ url: liveSocket.url, ticket, expires_at_ms: expiresAtMs }, { headers });
}
