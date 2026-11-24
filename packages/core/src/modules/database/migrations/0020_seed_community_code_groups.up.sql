CREATE TABLE mission_control_seed_code_groups (
  seed_code_group_id UUID PRIMARY KEY,
  seed_creator_id UUID NOT NULL REFERENCES mission_control_seed_creators(seed_creator_id),
  group_label TEXT NOT NULL CHECK (length(group_label) BETWEEN 1 AND 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mission_control_seed_code_groups_label_unique
    UNIQUE (seed_creator_id, group_label)
);

INSERT INTO mission_control_seed_code_groups (
  seed_code_group_id, seed_creator_id, group_label, created_at
)
SELECT seed_creator_id, seed_creator_id, display_name, created_at
FROM mission_control_seed_creators;

ALTER TABLE mission_control_invitation_codes
  ADD COLUMN seed_code_group_id UUID
    REFERENCES mission_control_seed_code_groups(seed_code_group_id);

UPDATE mission_control_invitation_codes
SET seed_code_group_id = seed_creator_id
WHERE code_kind = 'creator';

ALTER TABLE mission_control_invitation_codes
  DROP CONSTRAINT mission_control_invitation_codes_owner_check,
  ADD CONSTRAINT mission_control_invitation_codes_owner_check CHECK (
    (
      code_kind = 'member' AND
      owner_profile_id IS NOT NULL AND
      seed_creator_id IS NULL AND
      seed_code_group_id IS NULL AND
      sticky_position IS NULL
    ) OR (
      code_kind = 'creator' AND
      owner_profile_id IS NULL AND
      seed_creator_id IS NOT NULL AND
      seed_code_group_id IS NOT NULL AND
      sticky_position IS NULL
    ) OR (
      code_kind IN ('sticky', 'team') AND
      owner_profile_id IS NULL AND
      seed_creator_id IS NULL AND
      seed_code_group_id IS NULL
    )
  );

CREATE INDEX mission_control_invitation_codes_seed_group_idx
  ON mission_control_invitation_codes (seed_code_group_id)
  WHERE seed_code_group_id IS NOT NULL;

CREATE TRIGGER mission_control_seed_code_groups_immutable
BEFORE UPDATE OR DELETE ON mission_control_seed_code_groups
FOR EACH ROW EXECUTE FUNCTION mission_control_guard_completion_immutable();

CREATE OR REPLACE FUNCTION mission_control_guard_invitation_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    OLD.owner_profile_id,
    OLD.seed_creator_id,
    OLD.seed_code_group_id,
    OLD.source_allocation_id,
    OLD.allocation_ordinal
  ) IS DISTINCT FROM (
    NEW.owner_profile_id,
    NEW.seed_creator_id,
    NEW.seed_code_group_id,
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
