import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { withRouteLimits } from "@blast/core/modules/web-security/route-limits.ts";
import { sharedSocialRouteKit } from "./route-kit/shared-runtime.ts";
import {
  createPnlCardShareRoute,
  readPnlCardShare,
} from "./pnl-card-sharing.ts";

export function pnlCardPublishRoute(request: Request, client: ClientAddress): Promise<Response> {
  return createPnlCardShareRoute(sharedSocialRouteKit())(request, client);
}

export function createPnlCardImageRoute(
  read: typeof readPnlCardShare,
  limit = withRouteLimits,
) {
  return (client: ClientAddress, id: string): Promise<Response> =>
    limit(client, ["mission_control_card_image"], async () => {
      try {
        const bytes = await read(id);
        if (!bytes)
          return new Response(null, {
            status: 404,
            headers: { "Cache-Control": "no-store" },
          });
        return new Response(new Uint8Array(bytes), {
          headers: {
            "Content-Type": "image/png",
            "Content-Length": String(bytes.byteLength),
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
          },
        });
      } catch {
        return new Response(null, {
          status: 503,
          headers: { "Cache-Control": "no-store", "Retry-After": "5" },
        });
      }
    });
}

export function createPnlCardPageRoute(read: typeof readPnlCardShare) {
  return async (id: string): Promise<Response> =>
    Response.json(
      { id, exists: (await read(id)) !== null },
      {
        headers: { "Cache-Control": "private, no-store" },
      },
    );
}

export const pnlCardImageRoute = createPnlCardImageRoute(readPnlCardShare);
export const pnlCardPageRoute = createPnlCardPageRoute(readPnlCardShare);
