DROP TRIGGER IF EXISTS mission_control_season_memberships_permanent
  ON mission_control_season_memberships;
DROP TRIGGER IF EXISTS mission_control_seasons_permanent_allocator
  ON mission_control_seasons;
DROP TRIGGER IF EXISTS mission_control_profiles_immutable_identity
  ON mission_control_profiles;
DROP TRIGGER IF EXISTS mission_control_profiles_reserved_callsign
  ON mission_control_profiles;

DROP FUNCTION IF EXISTS mission_control_guard_membership();
DROP FUNCTION IF EXISTS mission_control_guard_season_allocator();
DROP FUNCTION IF EXISTS mission_control_reject_reserved_callsign();
DROP FUNCTION IF EXISTS mission_control_guard_profile_identity();

DROP TABLE IF EXISTS mission_control_season_memberships;
DROP TABLE IF EXISTS mission_control_profiles;
DROP TABLE IF EXISTS mission_control_callsign_attempt_limits;
DROP TABLE IF EXISTS mission_control_reserved_callsigns;
DROP TABLE IF EXISTS mission_control_seasons;
