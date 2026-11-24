import type { Pool } from "pg";

import { autocommitRead } from "@blast/core/modules/database/transaction.ts";
import type { LinkedWallet, LinkedWalletStore } from "@blast/server/modules/presale/account/wallets.ts";

/**
 * The Blast Account wallets of a Privy DID, read from the account module's
 * `mission_control_account_identities` and `mission_control_account_wallets`
 * (migration 0012) on the primary, so a wallet linked a moment ago is listed.
 * Read only: this module never writes them. The pool is resolved on each
 * call, so a database configuration error fails that request inside the
 * route kit (`service_unavailable`).
 */
export class PostgresLinkedWalletStore implements LinkedWalletStore {
  readonly #pool: () => Pool;

  constructor(pool: () => Pool) {
    this.#pool = pool;
  }

  async list(privyDid: string): Promise<LinkedWallet[]> {
    const result = await autocommitRead<{ sui_address: string; wallet_kind: LinkedWallet["kind"]; is_primary: boolean }>(
      this.#pool(),
      "account",
      `SELECT w.sui_address, w.wallet_kind, w.is_primary
       FROM mission_control_account_identities AS i
       JOIN mission_control_account_wallets AS w ON w.profile_id = i.profile_id
       WHERE i.provider = 'privy' AND i.provider_subject = $1 AND w.verified_at IS NOT NULL
       ORDER BY w.is_primary DESC, w.created_at, w.sui_address`,
      [privyDid],
      { label: "presale.account_wallets" },
    );
    return result.rows.map((row) => ({ address: row.sui_address, kind: row.wallet_kind, primary: row.is_primary }));
  }
}
