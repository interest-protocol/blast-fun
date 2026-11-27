import type {
  ModuleTransaction,
  ReadableDatabase,
} from "@blast/core/modules/database/transaction.ts";
import type {
  SocialAccountWallet,
  SocialWalletKind,
} from "@blast/core/modules/social/contracts/me.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

import type { SocialCaller } from "../route-kit/route.ts";
import { assertWalletSessionActive } from "./session.ts";

type HolderRow = { taken: boolean | null; held: boolean | null };
type WalletRow = {
  address: string;
  kind: SocialWalletKind;
  linked_at_ms: string;
};

/**
 * Who holds `$1` besides the account `$2`, through every wallet source (each
 * looked up by address): a Mission Control wallet of another profile, the
 * presale embedded wallet of another Privy DID, or another account's proven
 * wallet. A Mission Control member who has not opened the social feed yet
 * still holds their wallets. `held` says the account already holds it.
 */
const HOLDERS = `
  SELECT bool_or(NOT h.mine) AS taken, bool_or(h.mine) AS held
  FROM social_accounts me
  CROSS JOIN LATERAL (
    SELECT a.account_id = me.account_id AS mine
    FROM social_accounts a
    WHERE a.sui_address = $1 AND a.deleted_at IS NULL
    UNION ALL
    SELECT w.profile_id IS NOT DISTINCT FROM me.profile_id AS mine
    FROM mission_control_account_wallets w
    WHERE w.sui_address = $1
    UNION ALL
    SELECT COALESCE(e.privy_did = me.privy_did, false) OR EXISTS (
      SELECT 1 FROM mission_control_account_identities i
      WHERE i.profile_id = me.profile_id AND i.provider = 'privy' AND i.provider_subject = e.privy_did
    )
    FROM presale_embedded_wallets e
    WHERE e.address = $1
    UNION ALL
    SELECT s.account_id = me.account_id
    FROM social_account_wallets s
    WHERE s.address = $1
  ) AS h
  WHERE me.account_id = $2`;

/** The address as `GET /api/social/me` lists it (the same kind rule), when the account holds it. */
const WALLET_BY_ADDRESS = `
  SELECT
    o.address,
    CASE
      WHEN mw.wallet_kind IS NOT NULL THEN mw.wallet_kind
      WHEN o.source = 'presale_embedded'
        OR EXISTS (SELECT 1 FROM presale_embedded_wallets e WHERE e.address = o.address) THEN 'embedded'
      WHEN sw.kind IN ('embedded', 'slush') THEN sw.kind
      ELSE 'external'
    END AS kind,
    floor(extract(epoch FROM o.linked_at) * 1000)::bigint AS linked_at_ms
  FROM social_wallet_owners o
  LEFT JOIN mission_control_account_wallets mw ON mw.sui_address = o.address
  LEFT JOIN social_account_wallets sw ON sw.address = o.address
  WHERE o.address = $1 AND o.account_id = $2`;

const INSERT_WALLET = `
  INSERT INTO social_account_wallets (address, account_id, kind, verified_at)
  VALUES ($1, $2, $3, now())
  ON CONFLICT (address) DO NOTHING
  RETURNING address`;

export async function holders(
  db: ReadableDatabase,
  address: string,
  accountId: string,
): Promise<{ taken: boolean; held: boolean }> {
  const row = (await db.read<HolderRow>(HOLDERS, [address, accountId])).rows[0];
  return { taken: row?.taken === true, held: row?.held === true };
}

export async function linkProvenWallet(
  social: ModuleTransaction<"social">,
  address: string,
  accountId: string,
  kind: SocialWalletKind,
  caller: SocialCaller,
): Promise<{ wallet: SocialAccountWallet; created: boolean }> {
  await lockActiveWalletAccount(social, accountId, caller);
  const current = await holders(social, address, accountId);
  if (current.taken) throw new SocialRouteError("wallet_taken");
  const inserted = current.held
    ? null
    : await social.write("social_account_wallets", INSERT_WALLET, [address, accountId, kind]);
  const after = await holders(social, address, accountId);
  if (after.taken) throw new SocialRouteError("wallet_taken");
  const row = (await social.read<WalletRow>(WALLET_BY_ADDRESS, [address, accountId])).rows[0];
  if (!row) throw new SocialRouteError("wallet_taken");
  const wallet: SocialAccountWallet = {
    address: row.address,
    kind: row.kind,
    linked_at_ms: Number(row.linked_at_ms),
  };
  return { wallet, created: inserted?.rowCount === 1 };
}
/** Serialize changes to an account's wallet list and recheck its sign-in after waiting. */
export async function lockActiveWalletAccount(social: ModuleTransaction<"social">, accountId: string, caller: SocialCaller) {
  const { rows } = await social.read<{ profile_id: string | null; sui_address: string | null }>(
    "SELECT profile_id, sui_address FROM social_accounts WHERE account_id = $1 AND deleted_at IS NULL FOR UPDATE",
    [accountId],
  );
  const account = rows[0];
  if (!account) throw new SocialRouteError("account_required");
  await assertWalletSessionActive(social, caller);
  return account;
}
