import { headers } from "next/headers";

import { webConfig } from "#web/lib/server-config.ts";

import { CoinTheses } from "./CoinTheses";
import { thesesPosting } from "./posting";

/**
 * The coin page's Theses with posting: the deployment's network for direct
 * wallets, Privy when configured, and the request's CSP nonce for Privy's
 * styles. Without a named deployment the page says posting is unavailable.
 */
export async function CoinThesesSlot({ launchId, symbol }: Readonly<{ launchId: string; symbol: string | null }>) {
  const nonce = (await headers()).get("x-nonce") ?? "";
  return <CoinTheses launchId={launchId} symbol={symbol} posting={thesesPosting(webConfig(), nonce)} />;
}
