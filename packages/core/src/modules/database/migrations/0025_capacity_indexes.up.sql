-- Owner panel lookups by recruiter. Without these, recruit counts and recruit
-- pages scan every referral (EXPLAIN on a seeded database: Seq Scan on
-- mission_control_referrals, then hash joins over all profiles and
-- memberships to sort one owner's recruits).
--
-- The key matches the recruits query's ORDER BY created_at DESC,
-- recruited_profile_id DESC and its (created_at, profile_id) < cursor, so a
-- page reads only its own rows.
--
-- Lock impact: the migration runner wraps each migration in a transaction, so
-- these are plain CREATE INDEX, not CONCURRENTLY. Each holds a SHARE lock on
-- its table while it builds: reads continue, but completions (the only writers
-- of these two tables) wait for the build. Both tables hold one row per
-- recruited member, so each build takes well under a second at launch scale.
CREATE INDEX mission_control_referrals_referrer_recent_idx
  ON mission_control_referrals (referrer_profile_id, created_at DESC, recruited_profile_id DESC);

CREATE INDEX mission_control_seed_creator_attributions_creator_recent_idx
  ON mission_control_seed_creator_attributions (seed_creator_id, created_at DESC, recruited_profile_id DESC);
