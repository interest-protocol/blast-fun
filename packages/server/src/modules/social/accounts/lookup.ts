import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
/** The account holding `callsign` (a member's profile callsign or a new account's own), or null. */
export async function accountIdOf(
  social: ReadableDatabase,
  callsign: string,
): Promise<string | null> {
  const result = await social.read<{ account_id: string }>(
    "SELECT account_id::text AS account_id FROM social_account_callsigns WHERE callsign = $1",
    [callsign],
  );
  return result.rows[0]?.account_id ?? null;
}

/** Serializes capped social writes without blocking foreign-key references to the account. */
export async function lockSocialAccount(
  social: ReadableDatabase,
  accountId: string,
): Promise<void> {
  await social.read("SELECT 1 FROM social_accounts WHERE account_id = $1 FOR NO KEY UPDATE", [
    accountId,
  ]);
}
