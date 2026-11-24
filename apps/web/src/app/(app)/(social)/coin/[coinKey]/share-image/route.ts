import { recordMetric } from "@blast/core/lib/metrics.ts";
import { SemaphoreTimeoutError } from "@blast/server/lib/concurrency.ts";
import { parseCoinRouteKey } from "#web/modules/launchpad-coin/read.ts";
import { loadCoinShareImage } from "#web/modules/launchpad-coin/share-image-cache.ts";

export const runtime = "nodejs";

type Params = Promise<{ coinKey: string }>;
const noStore = { "Cache-Control": "private, no-store" };

export async function GET(_request: Request, { params }: { params: Params }): Promise<Response> {
  const coin = parseCoinRouteKey((await params).coinKey);
  if (!coin) return new Response(null, { status: 404, headers: noStore });

  try {
    const card = await loadCoinShareImage(coin);
    if (!card) return new Response(null, { status: 404, headers: noStore });
    return new Response(new Uint8Array(card.bytes), {
      headers: {
        "Cache-Control": card.transient ? noStore["Cache-Control"] : "private, max-age=300",
        "Content-Type": "image/png",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (!(error instanceof SemaphoreTimeoutError)) recordMetric("coin.share_image.failed", { outcome: "unavailable" });
    return new Response(null, { status: 503, headers: { ...noStore, "Retry-After": "5" } });
  }
}
