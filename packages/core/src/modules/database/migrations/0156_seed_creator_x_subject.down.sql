CREATE OR REPLACE FUNCTION mission_control_guard_seed_creator()
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

ALTER TABLE mission_control_seed_creators
  DROP CONSTRAINT mission_control_seed_creators_claim_subject,
  DROP CONSTRAINT mission_control_seed_creators_subject_unique,
  DROP COLUMN expected_x_subject;
