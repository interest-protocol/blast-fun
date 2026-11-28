import type { TransactionContext } from "@blast/core/modules/database/transaction.ts";
import type { SocialWalletUnlinked } from "@blast/core/modules/social/contracts/wallets.ts";
import { SocialRouteError } from "@blast/core/modules/social/route-kit/errors.ts";

import { WALLETS_BY_ACCOUNT } from "../accounts/repository.ts";
import type { SocialCaller } from "../route-kit/route.ts";
import { lockActiveWalletAccount } from "./store.ts";

export async function unlinkSlushWallet(
  transaction: TransactionContext,
  accountId: string,
  caller: SocialCaller,
  address: string,
  confirmAccountDeletion: boolean,
): Promise<SocialWalletUnlinked> {
  const social = transaction.forModule("social");
  const account = await lockActiveWalletAccount(social, accountId, caller);
  const { rows: wallets } = await social.read<{ address: string; kind: string }>(WALLETS_BY_ACCOUNT, [accountId]);
  if (!wallets.some((wallet) => wallet.address === address && wallet.kind === "slush")) {
    throw new SocialRouteError("wallet_unlink_changed");
  }

  const backup = wallets.find((wallet) => wallet.address !== address);
  const accountDeleted = !backup;
  if (accountDeleted !== confirmAccountDeletion) {
    throw new SocialRouteError("wallet_unlink_changed");
  }

  if (account.profile_id) {
    const missionControl = transaction.forModule("account");
    const { rows: removed } = await missionControl.write<{ is_primary: boolean }>(
      "mission_control_account_wallets",
      `DELETE FROM mission_control_account_wallets
       WHERE profile_id = $1 AND sui_address = $2 AND wallet_kind = 'slush'
       RETURNING is_primary`,
      [account.profile_id, address],
    );
    if (removed[0]?.is_primary) {
      await missionControl.write(
        "mission_control_account_wallets",
        `UPDATE mission_control_account_wallets SET is_primary = true
         WHERE profile_id = $1 AND wallet_kind = 'embedded'`,
        [account.profile_id],
      );
    }
  }
  await social.write(
    "social_account_wallets",
    "DELETE FROM social_account_wallets WHERE account_id = $1 AND address = $2",
    [accountId, address],
  );
  if (accountDeleted) {
    await social.write(
      "social_accounts",
      `UPDATE social_accounts SET deleted_at = now(), sui_address = NULL,
         privacy = 'private', sharing_since = NULL, portfolio_public = false
       WHERE account_id = $1`,
      [accountId],
    );
  } else if (account.sui_address === address) {
    await social.write(
      "social_accounts",
      "UPDATE social_accounts SET sui_address = $2 WHERE account_id = $1",
      [accountId, backup.address],
    );
  }
  await social.write(
    "social_wallet_sessions",
    `UPDATE social_wallet_sessions SET revoked_at = GREATEST(statement_timestamp(), created_at)
     WHERE wallet_address = $1 AND revoked_at IS NULL`,
    [address],
  );
  return { account_deleted: accountDeleted, signed_out: accountDeleted || (caller.kind === "wallet" && caller.address === address) };
}
