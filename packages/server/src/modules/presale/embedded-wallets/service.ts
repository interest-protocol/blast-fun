import type { Pool } from "pg";

import { createEmbeddedSuiWalletResolver } from "@blast/server/lib/privy-adapter/adapter.ts";
import { PrivyAdapterError } from "@blast/core/lib/privy-adapter/errors.ts";
import type { PrivyProviderGateway } from "@blast/core/lib/privy-adapter/types.ts";
import { PresaleRouteError, toPresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { PostgresEmbeddedWalletCache } from "@blast/server/modules/presale/embedded-wallets/repository.ts";

export type PresaleEmbeddedWallets = Readonly<{
  /** The caller's embedded Sui address, or null without one (the linked-wallet list). */
  find(privyDid: string): Promise<string | null>;
  /** The caller's embedded Sui address, or `not_embedded_wallet` (sponsorship, sender checks). */
  require(privyDid: string): Promise<string>;
}>;

/**
 * Resolves a verified Privy DID to its embedded Sui wallet through the Privy
 * adapter's `resolveEmbeddedSuiWallet` and the Postgres cache. A Privy outage
 * on a cache miss is `identity_unavailable` with `Retry-After: 5`; missing
 * Privy settings are `service_unavailable`; a database failure propagates for
 * the route kit (`service_unavailable`).
 */
export function createPresaleEmbeddedWallets(input: Readonly<{
  pool: Pool;
  gateway: Pick<PrivyProviderGateway, "getUser">;
}>): PresaleEmbeddedWallets {
  const resolver = createEmbeddedSuiWalletResolver({
    cache: new PostgresEmbeddedWalletCache(input.pool),
    gateway: input.gateway,
  });

  async function find(privyDid: string): Promise<string | null> {
    try {
      return await resolver.resolveEmbeddedSuiWallet(privyDid);
    } catch (error) {
      // One mapping for Privy failures, the kit's: an outage is identity_unavailable,
      // missing settings service_unavailable, an invalid DID unauthorized.
      if (error instanceof PrivyAdapterError) throw toPresaleRouteError(error);
      throw error;
    }
  }

  return Object.freeze({
    find,
    async require(privyDid: string) {
      const address = await find(privyDid);
      if (!address) throw new PresaleRouteError("not_embedded_wallet");
      return address;
    },
  });
}
