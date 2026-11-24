import { headers } from "next/headers";

import { webConfig } from "#web/lib/server-config.ts";

import { CoinMigration } from "./CoinMigration";

/**
 * The coin page's `migration` action slot, rendered only for a MigrationReady
 * launch on a supported recorded route. It names the app's signing chain,
 * Privy app and request CSP nonce; the action itself runs its own fresh
 * preflight before any signature.
 */
export async function CoinMigrationSlot({ launchId, venue }: Readonly<{ launchId: string; venue: string }>) {
  const nonce = (await headers()).get("x-nonce") ?? "";
  return (
    <CoinMigration
      launchId={launchId}
      venue={venue}
      config={webConfig().signingChain}
      privyAppId={webConfig().privyAppId}
      nonce={nonce}
    />
  );
}
