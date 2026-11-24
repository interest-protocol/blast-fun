DROP TRIGGER IF EXISTS mission_control_season_member_capacity
  ON mission_control_season_memberships;

DROP FUNCTION IF EXISTS mission_control_claim_member_capacity();

ALTER TABLE mission_control_seasons
  DROP COLUMN member_count,
  DROP COLUMN member_capacity;
