DROP TRIGGER IF EXISTS mission_control_operator_action_events_immutable
  ON mission_control_operator_action_events;
DROP TRIGGER IF EXISTS mission_control_operator_actions_immutable
  ON mission_control_operator_actions;
DROP FUNCTION IF EXISTS mission_control_guard_operator_evidence();

DROP TRIGGER IF EXISTS mission_control_season_memberships_restoration
  ON mission_control_season_memberships;
DROP FUNCTION IF EXISTS mission_control_guard_membership_restoration();
ALTER TABLE mission_control_season_memberships
  DROP CONSTRAINT IF EXISTS mission_control_season_memberships_restoration_check,
  DROP COLUMN IF EXISTS restored_at;

DROP INDEX IF EXISTS mission_control_invitation_codes_batch_idx;
ALTER TABLE mission_control_invitation_codes
  DROP CONSTRAINT IF EXISTS mission_control_invitation_codes_sticky_kind_check,
  DROP CONSTRAINT IF EXISTS mission_control_invitation_codes_owner_check,
  DROP CONSTRAINT IF EXISTS mission_control_invitation_codes_kind_check,
  DROP COLUMN IF EXISTS operator_action_id,
  DROP COLUMN IF EXISTS batch_id,
  DROP COLUMN IF EXISTS owner_profile_id,
  DROP COLUMN IF EXISTS code_kind;

DROP TABLE IF EXISTS mission_control_operator_action_events;
DROP TABLE IF EXISTS mission_control_operator_actions;

CREATE OR REPLACE FUNCTION mission_control_guard_profile_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    OLD.privy_did,
    OLD.x_subject,
    OLD.sui_address,
    OLD.provider_wallet_reference,
    OLD.callsign,
    OLD.callsign_path,
    OLD.disclosure_version,
    OLD.disclosure_accepted_at
  ) IS DISTINCT FROM (
    NEW.privy_did,
    NEW.x_subject,
    NEW.sui_address,
    NEW.provider_wallet_reference,
    NEW.callsign,
    NEW.callsign_path,
    NEW.disclosure_version,
    NEW.disclosure_accepted_at
  ) THEN
    RAISE EXCEPTION 'profile identity, callsign, and disclosure evidence are immutable'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mission_control_profiles_immutable_identity';
  END IF;
  RETURN NEW;
END;
$$;
