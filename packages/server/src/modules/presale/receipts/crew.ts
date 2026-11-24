import type { Pool } from "pg";

import { autocommitRead } from "@blast/core/modules/database/transaction.ts";

/**
 * A wallet's crew number for its public receipt (owner decision): the Mission
 * Control account that linked the wallet (`mission_control_account_wallets`
 * by `sui_address`), then that profile's latest season membership. Null when
 * the wallet is not linked, the account has no crew, or an operator has
 * suppressed that latest membership and not restored it: the crew of an
 * earlier season is never shown in its place.
 */
export class PostgresCrewDirectory {
  readonly #pool: () => Pool;

  constructor(pool: () => Pool) {
    this.#pool = pool;
  }

  async crewFor(wallet: string): Promise<number | null> {
    const result = await autocommitRead<{ crew_number: string }>(
      this.#pool(),
      "presale-receipts",
      `SELECT latest.crew_number
       FROM (
         SELECT membership.crew_number, membership.suppressed_at, membership.restored_at
         FROM mission_control_account_wallets wallet
         JOIN mission_control_season_memberships membership ON membership.profile_id = wallet.profile_id
         WHERE wallet.sui_address = $1
         ORDER BY membership.created_at DESC, membership.membership_id DESC
         LIMIT 1
       ) latest
       WHERE latest.suppressed_at IS NULL OR latest.restored_at IS NOT NULL`,
      [wallet],
      { label: "presale.receipt_crew" },
    );
    const crew = result.rows[0]?.crew_number;
    return crew === undefined ? null : Number(crew);
  }
}
