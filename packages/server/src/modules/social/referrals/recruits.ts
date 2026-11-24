export const RECRUITS_SQL = `WITH attributed AS (
  SELECT account_id AS recruit_id, account_id, created_at FROM social_accounts WHERE referrer_account_id = $1
  UNION ALL
  SELECT a.account_id, a.account_id, a.created_at FROM social_accounts a
  JOIN social_referral_reservations r ON r.code = a.referrer_reservation_code
  WHERE r.owner_account_id = $1 AND a.account_id <> $1
    AND COALESCE(a.x_subject,(SELECT p.x_subject FROM mission_control_profiles p WHERE p.profile_id=a.profile_id)) IS DISTINCT FROM r.x_subject
  UNION ALL
  SELECT COALESCE(recruit.account_id, r.recruited_profile_id), recruit.account_id, r.created_at
  FROM mission_control_referrals r
  JOIN social_accounts owner ON owner.profile_id = r.referrer_profile_id
  LEFT JOIN social_accounts recruit ON recruit.profile_id = r.recruited_profile_id
  WHERE owner.account_id = $1
  UNION ALL
  SELECT COALESCE(recruit.account_id, r.recruited_profile_id), recruit.account_id, r.created_at
  FROM mission_control_seed_creator_attributions r
  JOIN mission_control_seed_creators seed ON seed.seed_creator_id = r.seed_creator_id
  JOIN social_accounts owner ON owner.profile_id = seed.profile_id
  LEFT JOIN social_accounts recruit ON recruit.profile_id = r.recruited_profile_id
  WHERE owner.account_id = $1
), recruits AS (
  SELECT recruit_id, account_id, min(created_at) AS joined_at FROM attributed GROUP BY recruit_id, account_id
)`;
