import type { ClientAddress } from "@blast/core/lib/web-security/client-address.ts";
import { LRUCache } from "lru-cache";
import { settledAll } from "@blast/server/lib/settled-all.ts";
import { errorLabel, recordMetric } from "@blast/core/lib/metrics.ts";

import { isPresaleId } from "@blast/core/modules/presale/presale-id.ts";
import { createSemaphore, SemaphoreTimeoutError } from "@blast/server/lib/concurrency.ts";
import { SingleFlight } from "@blast/server/modules/mission-control/card-images/single-flight.ts";
import type { SocialPresaleSummary } from "@blast/core/modules/social/contracts/presales.ts";
import type { CoinLogoOutcome } from "@blast/server/modules/presale/receipts/logo.ts";
import type { PresaleShareArtwork } from "@blast/server/modules/presale/share/image.ts";
import { presaleShareRevision } from "@blast/core/modules/presale/share/revision.ts";

type Dependencies = Readonly<{
  readSale: (presaleId: string, request: Request, client: ClientAddress) => Promise<SocialPresaleSummary | null>;
  logo: (url: string | null) => Promise<CoinLogoOutcome>;
  cover: (url: string | null) => Promise<CoinLogoOutcome>;
  render: (sale: SocialPresaleSummary, artwork: PresaleShareArtwork) => Promise<Buffer>;
}>;

/** One render per process, bounded image memory, and no cached responses that could outlive team access. */
export function createPresaleShareImageRoute(dependencies: Dependencies) {
  const images = new LRUCache<string, Buffer>({ maxSize: 8 * 1024 * 1024, sizeCalculation: (bytes) => bytes.length, ttl: 60_000 });
  const flights = new SingleFlight<Buffer>();
  const slots = createSemaphore(1);

  return async (request: Request, presaleId: string, client: ClientAddress): Promise<Response> => {
    const headers = { "Cache-Control": "private, no-store" };
    if (!isPresaleId(presaleId)) return new Response(null, { status: 404, headers });
    try {
      const sale = await dependencies.readSale(presaleId, request, client);
      if (!sale) return new Response(null, { status: 404, headers });
      const key = `${presaleId}:${presaleShareRevision(sale)}`;
      const bytes = images.get(key) ?? await flights.run(key, async () => {
        const release = await slots.acquire(0);
        try {
          const [logo, cover] = await settledAll([dependencies.logo(sale.icon_url), dependencies.cover(sale.metadata?.cover?.url ?? null)]);
          const rendered = await dependencies.render(sale, { logo: logo.logo, cover: cover.logo });
          // A transient asset failure gets another chance on the next request.
          if (!logo.transient && !cover.transient) images.set(key, rendered);
          return rendered;
        } finally {
          release();
        }
      }).promise;
      return new Response(new Uint8Array(bytes), { headers: { ...headers, "Content-Type": "image/png", "X-Content-Type-Options": "nosniff" } });
    } catch (error) {
      if (!(error instanceof SemaphoreTimeoutError)) {
        recordMetric("presale.share_image.failed", { error: errorLabel(error) });
      }
      return new Response(null, { status: 503, headers: { ...headers, "Retry-After": "5" } });
    }
  };
}
