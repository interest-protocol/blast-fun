DROP TRIGGER IF EXISTS mission_control_sticky_invitation_immutable
  ON mission_control_invitation_codes;
DROP FUNCTION IF EXISTS mission_control_guard_sticky_invitation();
DROP TABLE IF EXISTS mission_control_admission_failures;
DROP TABLE IF EXISTS mission_control_admission_attempts;
DROP TABLE IF EXISTS mission_control_invitation_codes;
