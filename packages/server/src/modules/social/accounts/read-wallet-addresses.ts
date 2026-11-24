import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";

type AddressRow = { address: string };

/**
 * The account's wallet addresses exactly as `social_wallet_owners` lists
 * them, without computing that view for every wallet: the candidates come
 * from each source by the account's keys, and a candidate stays only when no
 * other account reaches it through any source (each looked up by address).
 * Every step is an index lookup.
 */
const ADDRESSES_OF_ACCOUNT = `
  SELECT mine.address
  FROM (
    SELECT w.sui_address AS address
    FROM social_accounts a JOIN mission_control_account_wallets w ON w.profile_id = a.profile_id
    WHERE a.account_id = $1
    UNION
    SELECT e.address
    FROM social_accounts a JOIN presale_embedded_wallets e ON e.privy_did = a.privy_did
    WHERE a.account_id = $1
    UNION
    SELECT e.address
    FROM social_accounts a
    JOIN mission_control_account_identities i ON i.profile_id = a.profile_id AND i.provider = 'privy'
    JOIN presale_embedded_wallets e ON e.privy_did = i.provider_subject
    WHERE a.account_id = $1
    UNION
    SELECT s.address FROM social_account_wallets s WHERE s.account_id = $1
  ) AS mine
  WHERE NOT EXISTS (
    SELECT 1 FROM mission_control_account_wallets w JOIN social_accounts o ON o.profile_id = w.profile_id
    WHERE w.sui_address = mine.address AND o.account_id <> $1
    UNION ALL
    SELECT 1 FROM presale_embedded_wallets e JOIN social_accounts o ON o.privy_did = e.privy_did
    WHERE e.address = mine.address AND o.account_id <> $1
    UNION ALL
    SELECT 1
    FROM presale_embedded_wallets e
    JOIN mission_control_account_identities i ON i.provider = 'privy' AND i.provider_subject = e.privy_did
    JOIN social_accounts o ON o.profile_id = i.profile_id
    WHERE e.address = mine.address AND o.account_id <> $1
    UNION ALL
    SELECT 1 FROM social_account_wallets s WHERE s.address = mine.address AND s.account_id <> $1
  )
  ORDER BY mine.address`;


export async function readAccountAddresses(db: ReadableDatabase, accountId: string): Promise<string[]> {
  return (await db.read<AddressRow>(ADDRESSES_OF_ACCOUNT, [accountId])).rows.map((row) => row.address);
}
