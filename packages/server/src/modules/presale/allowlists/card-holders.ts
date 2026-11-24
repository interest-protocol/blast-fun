import type { AllowlistEntry } from "@interest-protocol/blast-sdk/presale";
import type { Pool } from "pg";
import { autocommitRead } from "@blast/core/modules/database/transaction.ts";
import { PresaleRouteError } from "@blast/core/modules/presale/route-kit/errors.ts";
import { ALLOWLIST_MAX_ROWS } from "./upload.ts";

/** One verified wallet per account with a crew card. Prefer Privy over Slush. */
export async function cardHolderWallets(pool: Pool): Promise<string[]> {
  const result = await autocommitRead<{ sui_address: string }>(pool, "presale-allowlists", `
    SELECT DISTINCT ON (w.profile_id) w.sui_address
    FROM mission_control_account_wallets w
    WHERE EXISTS (SELECT 1 FROM mission_control_cards c WHERE c.profile_id = w.profile_id)
    ORDER BY w.profile_id, (w.wallet_kind = 'embedded') DESC, w.sui_address
  `, [], { label: "presale.allowlist_card_holders" });
  return result.rows.map((row) => row.sui_address);
}

/** Original caps win overlaps. The arithmetic mean rounds down by less than one atom. */
export function addCardHolders(original: readonly AllowlistEntry[], wallets: readonly string[]) {
  const cap = original.reduce((sum, entry) => sum + entry.walletCap, 0n) / BigInt(original.length);
  const entries = new Map(original.map((entry) => [entry.wallet, entry]));
  for (const wallet of wallets) {
    if (!entries.has(wallet)) entries.set(wallet, { wallet, walletCap: cap });
  }
  if (entries.size > ALLOWLIST_MAX_ROWS) throw new PresaleRouteError("allowlist_too_large");
  return { entries: [...entries.values()], cap, added: entries.size - original.length };
}
