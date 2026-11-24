DROP TRIGGER IF EXISTS mission_control_seed_creator_attributions_immutable
  ON mission_control_seed_creator_attributions;
DROP TRIGGER IF EXISTS mission_control_seed_creators_immutable
  ON mission_control_seed_creators;
DROP FUNCTION IF EXISTS mission_control_guard_seed_creator();

DROP TABLE IF EXISTS mission_control_seed_creator_attributions;

DROP INDEX IF EXISTS mission_control_invitation_codes_seed_creator_idx;

ALTER TABLE mission_control_invitation_codes
  DROP CONSTRAINT mission_control_invitation_codes_owner_check,
  DROP CONSTRAINT mission_control_invitation_codes_kind_check,
  DROP COLUMN seed_creator_id,
  ADD CONSTRAINT mission_control_invitation_codes_kind_check CHECK (
    code_kind IN ('sticky', 'team', 'member')
  ),
  ADD CONSTRAINT mission_control_invitation_codes_owner_check CHECK (
    (code_kind = 'member' AND owner_profile_id IS NOT NULL AND sticky_position IS NULL)
    OR
    (code_kind IN ('sticky', 'team') AND owner_profile_id IS NULL)
  );

DROP TABLE IF EXISTS mission_control_seed_creators;

CREATE OR REPLACE FUNCTION mission_control_guard_invitation_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    OLD.owner_profile_id,
    OLD.source_allocation_id,
    OLD.allocation_ordinal
  ) IS DISTINCT FROM (
    NEW.owner_profile_id,
    NEW.source_allocation_id,
    NEW.allocation_ordinal
  ) OR OLD.consumed_at IS NOT NULL AND (
    OLD.consumed_at,
    OLD.consumed_by_profile_id
  ) IS DISTINCT FROM (
    NEW.consumed_at,
    NEW.consumed_by_profile_id
  ) THEN
    RAISE EXCEPTION 'invitation ownership and consumption are permanent'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mission_control_invitation_lifecycle_immutable';
  END IF;
  RETURN NEW;
END;
$$;
