import type { Pool } from "pg";

import { autocommitRead, autocommitWrite } from "@blast/core/modules/database/transaction.ts";
import type { AccountSettings } from "@blast/core/modules/presale/contracts/web-api.ts";
import type { AccountSettingsStore } from "@blast/server/modules/presale/settings/routes.ts";

/**
 * Each account's settings in `presale_account_settings` (migration 0045), on
 * the primary so a save is read back at once from any device. A save
 * replaces both values. The pool is resolved on each call, never at
 * construction, so a database configuration error fails that request inside
 * the route kit (`service_unavailable`).
 */
export class PostgresAccountSettingsStore implements AccountSettingsStore {
  readonly #pool: () => Pool;

  constructor(pool: () => Pool) {
    this.#pool = pool;
  }

  async find(privyDid: string): Promise<AccountSettings | null> {
    const result = await autocommitRead<AccountSettings>(
      this.#pool(),
      "presale-settings",
      "SELECT explorer, theme FROM presale_account_settings WHERE privy_did = $1",
      [privyDid],
      { label: "presale.account_settings" },
    );
    const row = result.rows[0];
    return row ? { explorer: row.explorer, theme: row.theme } : null;
  }

  async save(privyDid: string, settings: AccountSettings): Promise<void> {
    await autocommitWrite(
      this.#pool(),
      "presale-settings",
      "presale_account_settings",
      `INSERT INTO presale_account_settings (privy_did, explorer, theme) VALUES ($1, $2, $3)
       ON CONFLICT (privy_did) DO UPDATE
       SET explorer = EXCLUDED.explorer, theme = EXCLUDED.theme, updated_at = now()`,
      [privyDid, settings.explorer, settings.theme],
    );
  }
}
