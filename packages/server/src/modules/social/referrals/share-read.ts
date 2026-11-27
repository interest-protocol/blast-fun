import type { ReadableDatabase } from "@blast/core/modules/database/transaction.ts";
import type { ReferralInviter } from "@blast/core/modules/social/referrals/share.ts";

/** Public identity only. A Mission Control member need not have opened the social app yet. */
export async function readReferralInviter(db: ReadableDatabase, callsign: string): Promise<ReferralInviter | null> {
  const result = await db.read<ReferralInviter>(`SELECT * FROM (WITH holder AS (
    SELECT r.code AS callsign, a.profile_id, i.avatar_url FROM social_referral_reservations r
    LEFT JOIN social_accounts a ON a.account_id=r.owner_account_id
    LEFT JOIN social_account_identities i ON i.account_id=a.account_id
    WHERE r.code=$1 AND a.deleted_at IS NULL
    UNION ALL
    SELECT c.callsign, a.profile_id, i.avatar_url FROM social_account_callsigns c
    JOIN social_accounts a ON a.account_id = c.account_id
    JOIN social_account_identities i ON i.account_id = c.account_id
    WHERE c.callsign = $1 AND NOT EXISTS (SELECT 1 FROM social_referral_reservations WHERE code=$1)
    UNION ALL
    SELECT p.callsign, p.profile_id, COALESCE(p.avatar_reference, p.x_avatar_reference) AS avatar_url FROM mission_control_profiles p
    WHERE p.callsign = $1 AND NOT EXISTS (SELECT 1 FROM social_referral_reservations WHERE code=$1)
      AND NOT EXISTS (SELECT 1 FROM social_account_callsigns WHERE callsign = $1)
      AND NOT EXISTS (SELECT 1 FROM social_accounts a WHERE a.profile_id = p.profile_id AND a.deleted_at IS NOT NULL)
  )
  SELECT h.callsign, h.avatar_url AS "avatarUrl", (c.card_record->>'crew')::int AS crew, c.card_record->>'title' AS title
  FROM holder h LEFT JOIN mission_control_cards c ON c.profile_id = h.profile_id AND c.published_at IS NOT NULL
  LIMIT 1) inviter`, [callsign]);
  return result.rows[0] ?? null;
}
