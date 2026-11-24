import type { TransactionContext } from "@blast/core/modules/database/transaction.ts";

interface RecoveryProfileRow {
  profile_id: string;
}

export class CrewAccessRepository {
  async findCompletedProfileByWallet(
    transaction: TransactionContext,
    input: Readonly<{ address: string; privyDid: string | null }>,
  ): Promise<string | null> {
    const result = await transaction.read<RecoveryProfileRow>(
      `SELECT profile.profile_id
       FROM mission_control_profiles AS profile
       INNER JOIN mission_control_account_wallets AS wallet
         ON wallet.profile_id = profile.profile_id
       INNER JOIN mission_control_season_memberships AS membership
         ON membership.profile_id = profile.profile_id
       INNER JOIN mission_control_invitation_allocations AS allocation
         ON allocation.profile_id = profile.profile_id
       INNER JOIN mission_control_cards AS card
         ON card.profile_id = profile.profile_id
       WHERE wallet.sui_address = $1
         AND (
           $2::text IS NULL OR EXISTS (
             SELECT 1
             FROM mission_control_account_identities AS identity
             WHERE identity.profile_id = profile.profile_id
               AND identity.provider = 'privy'
               AND identity.provider_subject = $2
           )
         )
       LIMIT 1`,
      [input.address, input.privyDid],
    );
    return result.rows[0]?.profile_id ?? null;
  }
}
