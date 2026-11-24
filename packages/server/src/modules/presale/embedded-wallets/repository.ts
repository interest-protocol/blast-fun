import type { Pool } from "pg";

import type { EmbeddedSuiWalletCache } from "@blast/server/lib/privy-adapter/adapter.ts";
import { autocommitRead, autocommitWrite } from "@blast/core/modules/database/transaction.ts";

/**
 * The DID → embedded Sui address cache in `presale_embedded_wallets`
 * (migration 0039). Rows never expire and are never changed: the first
 * resolution of a DID wins, and a concurrent one inserts nothing.
 */
export class PostgresEmbeddedWalletCache implements EmbeddedSuiWalletCache {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async get(privyDid: string): Promise<string | null> {
    const result = await autocommitRead<{ address: string }>(
      this.#pool,
      "presale-embedded-wallets",
      "SELECT address FROM presale_embedded_wallets WHERE privy_did = $1",
      [privyDid],
      { label: "presale.embedded_wallet" },
    );
    return result.rows[0]?.address ?? null;
  }

  async put(privyDid: string, address: string): Promise<void> {
    await autocommitWrite(
      this.#pool,
      "presale-embedded-wallets",
      "presale_embedded_wallets",
      `INSERT INTO presale_embedded_wallets (privy_did, address) VALUES ($1, $2)
       ON CONFLICT (privy_did) DO NOTHING`,
      [privyDid, address],
    );
  }
}
