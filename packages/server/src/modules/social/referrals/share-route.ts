import { LRUCache } from "lru-cache";
import { referralCallsign } from "@blast/core/modules/social/referrals/contracts.ts";
import { createSemaphore } from "@blast/server/lib/concurrency.ts";
import { SingleFlight } from "@blast/server/modules/mission-control/card-images/single-flight.ts";
import type { PresaleReceiptLogo } from "@blast/core/modules/mission-control/card-renderer/presale-receipt.ts";
import type { CoinLogoOutcome } from "@blast/server/modules/presale/receipts/logo.ts";
import type { ReferralInviter } from "@blast/core/modules/social/referrals/share.ts";

export function createReferralImageRoute(deps: Readonly<{
  read: (callsign: string) => Promise<ReferralInviter | null>;
  avatar: (url: string | null) => Promise<CoinLogoOutcome>;
  render: (inviter: ReferralInviter, avatar: PresaleReceiptLogo | null) => Promise<Buffer>;
}>) {
  const images = new LRUCache<string, Buffer>({ maxSize: 8 * 1024 * 1024, sizeCalculation: (bytes) => bytes.length, ttl: 300_000 });
  const flights = new SingleFlight<Readonly<{ bytes: Buffer; transient: boolean }>>();
  const slots = createSemaphore(1);
  return async (value: string): Promise<Response> => {
    const noStore = { "Cache-Control": "private, no-store" };
    const callsign = referralCallsign(value);
    if (!callsign) return new Response(null, { status: 404, headers: noStore });
    try {
      const inviter = await deps.read(callsign);
      if (!inviter) return new Response(null, { status: 404, headers: noStore });
      const key = JSON.stringify(inviter);
      const cached = images.get(key);
      const image = cached ? { bytes: cached, transient: false } : await flights.run(key, async () => {
        const release = await slots.acquire(0);
        try {
          const avatar = await deps.avatar(inviter.avatarUrl);
          const bytes = await deps.render(inviter, avatar.logo);
          if (!avatar.transient) images.set(key, bytes);
          return { bytes, transient: avatar.transient };
        } finally { release(); }
      }).promise;
      return new Response(new Uint8Array(image.bytes), { headers: {
        "Content-Type": "image/png", "X-Content-Type-Options": "nosniff",
        "Cache-Control": image.transient ? "private, no-store" : "public, max-age=300, s-maxage=300, stale-while-revalidate=60",
      } });
    } catch {
      return new Response(null, { status: 503, headers: { ...noStore, "Retry-After": "5" } });
    }
  };
}
