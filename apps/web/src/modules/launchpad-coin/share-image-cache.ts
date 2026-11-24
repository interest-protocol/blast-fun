import { LRUCache } from "lru-cache";
import { processSingleton } from "@blast/core/lib/process-singleton.ts";
import type { CoinPageKey } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { createSemaphore } from "@blast/server/lib/concurrency.ts";
import { SingleFlight } from "@blast/server/modules/mission-control/card-images/single-flight.ts";
import { webConfig } from "#web/lib/server-config.ts";
import { readCoinRoute } from "./read.ts";
import { coinShareIdentity } from "./share.ts";
import { coinShareLogo, renderCoinShareImage } from "./share-image.ts";

type Card = Readonly<{ bytes: Buffer; transient: boolean }>;

const images = new LRUCache<string, Card>({
  maxSize: 8 * 1024 * 1024,
  sizeCalculation: (card) => card.bytes.length,
  ttl: 300_000,
});
const flights = new SingleFlight<Card | null>();

export async function loadCoinShareImage(coin: CoinPageKey): Promise<Card | null> {
  const key = coin.kind === "launch-id" ? coin.launchId : coin.coinType;
  return images.get(key) ?? flights.run(key, async () => {
    const slots = processSingleton("coin-share-image.slots", () => createSemaphore(webConfig().coinShareImageConcurrency));
    const release = await slots.acquire(0);
    try {
      const identity = coinShareIdentity(await readCoinRoute(coin));
      if (!identity) return null;
      const { logo, transient } = await coinShareLogo(identity);
      const card = { bytes: await renderCoinShareImage(identity, logo), transient };
      if (!transient) images.set(key, card);
      return card;
    } finally {
      release();
    }
  }).promise;
}
