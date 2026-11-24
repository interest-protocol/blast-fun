CREATE TABLE mission_control_seed_creators (
  seed_creator_id UUID PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES mission_control_seasons(season_id),
  display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 100),
  expected_x_handle TEXT NOT NULL CHECK (
    expected_x_handle = lower(expected_x_handle) AND
    expected_x_handle ~ '^[a-z0-9_]{1,15}$'
  ),
  x_subject TEXT UNIQUE,
  profile_id UUID UNIQUE REFERENCES mission_control_profiles(profile_id),
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mission_control_seed_creators_handle_unique
    UNIQUE (season_id, expected_x_handle),
  CONSTRAINT mission_control_seed_creators_claim_check CHECK (
    (x_subject IS NULL AND profile_id IS NULL AND claimed_at IS NULL) OR
    (x_subject IS NOT NULL AND profile_id IS NOT NULL AND claimed_at IS NOT NULL)
  )
);

ALTER TABLE mission_control_invitation_codes
  ADD COLUMN seed_creator_id UUID REFERENCES mission_control_seed_creators(seed_creator_id);

ALTER TABLE mission_control_invitation_codes
  DROP CONSTRAINT mission_control_invitation_codes_kind_check,
  DROP CONSTRAINT mission_control_invitation_codes_owner_check,
  ADD CONSTRAINT mission_control_invitation_codes_kind_check CHECK (
    code_kind IN ('sticky', 'team', 'member', 'creator')
  ),
  ADD CONSTRAINT mission_control_invitation_codes_owner_check CHECK (
    (
      code_kind = 'member' AND
      owner_profile_id IS NOT NULL AND
      seed_creator_id IS NULL AND
      sticky_position IS NULL
    ) OR (
      code_kind = 'creator' AND
      owner_profile_id IS NULL AND
      seed_creator_id IS NOT NULL AND
      sticky_position IS NULL
    ) OR (
      code_kind IN ('sticky', 'team') AND
      owner_profile_id IS NULL AND
      seed_creator_id IS NULL
    )
  );

CREATE INDEX mission_control_invitation_codes_seed_creator_idx
  ON mission_control_invitation_codes (seed_creator_id)
  WHERE seed_creator_id IS NOT NULL;

CREATE TABLE mission_control_seed_creator_attributions (
  recruited_profile_id UUID PRIMARY KEY REFERENCES mission_control_profiles(profile_id),
  seed_creator_id UUID NOT NULL REFERENCES mission_control_seed_creators(seed_creator_id),
  source_code_id UUID NOT NULL UNIQUE REFERENCES mission_control_invitation_codes(code_id),
  created_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX mission_control_seed_creator_attributions_creator_idx
  ON mission_control_seed_creator_attributions (seed_creator_id, created_at DESC);

CREATE FUNCTION mission_control_guard_seed_creator()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'seed creator records are permanent'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mission_control_seed_creator_immutable';
  END IF;
  IF (
    OLD.seed_creator_id,
    OLD.season_id,
    OLD.display_name,
    OLD.expected_x_handle,
    OLD.created_at
  ) IS DISTINCT FROM (
    NEW.seed_creator_id,
    NEW.season_id,
    NEW.display_name,
    NEW.expected_x_handle,
    NEW.created_at
  ) OR NOT (
    (OLD.x_subject, OLD.profile_id, OLD.claimed_at) IS NOT DISTINCT FROM
      (NEW.x_subject, NEW.profile_id, NEW.claimed_at)
    OR (
      OLD.x_subject IS NULL AND OLD.profile_id IS NULL AND OLD.claimed_at IS NULL AND
      NEW.x_subject IS NOT NULL AND NEW.profile_id IS NOT NULL AND NEW.claimed_at IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'seed creator identity and claim are immutable'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mission_control_seed_creator_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mission_control_seed_creators_immutable
BEFORE UPDATE OR DELETE ON mission_control_seed_creators
FOR EACH ROW EXECUTE FUNCTION mission_control_guard_seed_creator();

CREATE TRIGGER mission_control_seed_creator_attributions_immutable
BEFORE UPDATE OR DELETE ON mission_control_seed_creator_attributions
FOR EACH ROW EXECUTE FUNCTION mission_control_guard_completion_immutable();

CREATE OR REPLACE FUNCTION mission_control_guard_invitation_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    OLD.owner_profile_id,
    OLD.seed_creator_id,
    OLD.source_allocation_id,
    OLD.allocation_ordinal
  ) IS DISTINCT FROM (
    NEW.owner_profile_id,
    NEW.seed_creator_id,
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
