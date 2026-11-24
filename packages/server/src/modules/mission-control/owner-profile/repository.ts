import type { ReadableDatabase, TransactionContext } from "@blast/core/modules/database/transaction.ts";
import type { Fleet, OwnerWalletKind, RecruitCursorPosition } from "@blast/core/modules/mission-control/owner-profile/contracts.ts";
import type { AccountWalletKind } from "@blast/core/modules/mission-control/account-links/contracts.ts";

export interface OwnerCardRow {
  callsign: string;
  card_record: unknown;
}

export interface OwnerSummaryRow {
  avatar_reference: string | null;
  callsign: string;
  callsign_path: string;
  card_id: string;
  code_total: number;
  followed_blast: boolean;
  social_rewarded: boolean;
  shared_on_x: boolean;
  telegram_username: string | null;
  crew_number: string;
  display_name: string | null;
  fleet: Fleet;
  gold: boolean;
  owner_title: string;
  recruit_total: number;
  sui_address: string;
  wallet_kind: OwnerWalletKind;
  wallets: readonly OwnerWalletRow[];
  x_avatar_reference: string | null;
  x_handle: string | null;
  zero_fleet: boolean;
}

export interface OwnerWalletRow {
  wallet_id: string;
  sui_address: string;
  wallet_kind: AccountWalletKind;
  is_primary: boolean;
}

export interface OwnerRecruitRow {
  callsign: string;
  completed_at: Date;
  crew_number: string;
  display_name: string | null;
  fleet: Fleet;
  owner_title: string;
  profile_id: string;
  x_avatar_reference: string | null;
  x_handle: string | null;
}

export class OwnerProfileRepository {
  async card(
    database: ReadableDatabase,
    profileId: string,
  ): Promise<OwnerCardRow | null> {
    const result = await database.read<OwnerCardRow>(
      `SELECT profile.callsign, card.card_record
       FROM mission_control_cards card
       JOIN mission_control_profiles profile ON profile.profile_id = card.profile_id
       WHERE card.profile_id = $1
       LIMIT 1`,
      [profileId],
    );
    return result.rows[0] ?? null;
  }

  /** One statement, so the primary wallet and the wallet list agree. */
  async summary(
    database: ReadableDatabase,
    profileId: string,
  ): Promise<OwnerSummaryRow | null> {
    const result = await database.read<OwnerSummaryRow>(
      `SELECT p.callsign, p.callsign_path, p.display_name, p.avatar_reference,
              p.x_handle, p.x_avatar_reference, wallet.sui_address,
              wallet.wallet_kind,
              m.card_id, m.crew_number, m.fleet, m.owner_title,
              m.zero_fleet, m.gold,
              a.verified_followed_at IS NOT NULL AS followed_blast,
              EXISTS (SELECT 1 FROM mission_control_campaign_events e
                WHERE e.dedupe_key = 'card.shared.v1:' || a.allocation_id::text) AS social_rewarded,
              a.verified_post_id IS NOT NULL AS shared_on_x, a.telegram_username,
              (SELECT COUNT(*)::int FROM (
                 SELECT r.recruited_profile_id
                 FROM mission_control_referrals r
                 WHERE r.referrer_profile_id = p.profile_id
                 UNION ALL
                 SELECT a.recruited_profile_id
                 FROM mission_control_seed_creator_attributions a
                 JOIN mission_control_seed_creators sc
                   ON sc.seed_creator_id = a.seed_creator_id
                 WHERE sc.profile_id = p.profile_id
               ) attributed) AS recruit_total,
              (SELECT COUNT(*)::int FROM mission_control_invitation_codes c
               WHERE c.owner_profile_id = p.profile_id) AS code_total,
              (SELECT COALESCE(json_agg(json_build_object(
                        'wallet_id', w.wallet_id,
                        'sui_address', w.sui_address,
                        'wallet_kind', w.wallet_kind,
                        'is_primary', w.is_primary
                      ) ORDER BY w.is_primary DESC, w.created_at, w.wallet_id), '[]')
               FROM mission_control_account_wallets w
               WHERE w.profile_id = p.profile_id) AS wallets
       FROM mission_control_profiles p
       JOIN mission_control_season_memberships m ON m.profile_id = p.profile_id
       LEFT JOIN mission_control_invitation_allocations a ON a.membership_id = m.membership_id
       JOIN mission_control_account_wallets wallet
         ON wallet.profile_id = p.profile_id AND wallet.is_primary
       WHERE p.profile_id = $1
       ORDER BY m.created_at DESC
       LIMIT 1`,
      [profileId],
    );
    return result.rows[0] ?? null;
  }

  async recruits(
    database: ReadableDatabase,
    input: Readonly<{
      cursor: RecruitCursorPosition | null;
      limit: number;
      profileId: string;
    }>,
  ): Promise<readonly OwnerRecruitRow[]> {
    const result = await database.read<OwnerRecruitRow>(
      `SELECT recruited.profile_id, recruited.callsign, recruited.display_name,
              recruited.x_handle, recruited.x_avatar_reference,
              membership.fleet, membership.owner_title, membership.crew_number,
              referral.created_at AS completed_at
       FROM (
         SELECT r.recruited_profile_id, r.created_at
         FROM mission_control_referrals r
         WHERE r.referrer_profile_id = $1
         UNION ALL
         SELECT a.recruited_profile_id, a.created_at
         FROM mission_control_seed_creator_attributions a
         JOIN mission_control_seed_creators sc
           ON sc.seed_creator_id = a.seed_creator_id
         WHERE sc.profile_id = $1
       ) referral
       JOIN mission_control_profiles recruited
         ON recruited.profile_id = referral.recruited_profile_id
       JOIN mission_control_season_memberships membership
         ON membership.profile_id = recruited.profile_id
       WHERE ($2::timestamptz IS NULL OR
              (referral.created_at, recruited.profile_id) < ($2::timestamptz, $3::uuid))
       ORDER BY referral.created_at DESC, recruited.profile_id DESC
       LIMIT $4`,
      [
        input.profileId,
        input.cursor?.completedAt ?? null,
        input.cursor?.profileId ?? null,
        input.limit + 1,
      ],
    );
    return result.rows;
  }

  async updateDisplayName(
    transaction: TransactionContext,
    profileId: string,
    displayName: string | null,
  ): Promise<Readonly<{ callsign: string; displayName: string | null }> | null> {
    const result = await transaction.forModule("profile").write<{
      callsign: string;
      display_name: string | null;
    }>(
      "mission_control_profiles",
      `UPDATE mission_control_profiles
       SET display_name = $2
       WHERE profile_id = $1
       RETURNING callsign, display_name`,
      [profileId, displayName],
    );
    const row = result.rows[0];
    return row ? { callsign: row.callsign, displayName: row.display_name } : null;
  }
}
