import { cache } from "react";
import { parseCoinPageKey, type CoinPageKey } from "@blast/core/modules/launchpad-coin/page-key.ts";
import { indexedPoolCoin } from "@blast/core/modules/social/portfolio/core-coins.ts";
import { readCoinObjectPageFromBackend, readCoinTypePageFromBackend } from "#web/lib/backend-api/coin-page.ts";

// Metadata and the page share one backend read for the request.
const readObject = cache(readCoinObjectPageFromBackend);
const readType = cache(readCoinTypePageFromBackend);

export function parseCoinRouteKey(value: string): CoinPageKey | null {
  // Next can pass percent-encoded params to the page and decoded params to metadata.
  try {
    return parseCoinPageKey(decodeURIComponent(value));
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

export async function readCoinRoute(key: CoinPageKey) {
  if (key.kind === "launch-id") return readObject(key.launchId);
  const poolCoin = indexedPoolCoin(key.coinType);
  if (poolCoin) {
    const { coinType, name, symbol, logoUrl } = poolCoin;
    return { kind: "generic", coinType, name, symbol, iconUrl: logoUrl } as const;
  }
  return readType(key.coinType);
}
