ALTER TABLE mission_control_invitation_allocations
  DROP CONSTRAINT mission_control_invitation_allocations_policy_version_check,
  DROP CONSTRAINT mission_control_invitation_allocation_weight_check,
  DROP COLUMN secure_draw,
  DROP COLUMN x_premium_verified,
  ADD COLUMN verified_post_id TEXT UNIQUE CHECK (verified_post_id ~ '^[0-9]{1,25}$'),
  ADD COLUMN verified_shared_at TIMESTAMPTZ,
  ADD CONSTRAINT mission_control_share_policy CHECK (policy_version = 'season-zero-v3'),
  ADD CONSTRAINT mission_control_share_reward CHECK (
    (code_count = 0 AND verified_post_id IS NULL AND verified_shared_at IS NULL) OR
    (code_count = 2 AND verified_post_id IS NOT NULL AND verified_shared_at IS NOT NULL)
  );

DROP TRIGGER mission_control_invitation_allocations_immutable
  ON mission_control_invitation_allocations;

CREATE FUNCTION mission_control_guard_share_reward()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'share allocation cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.allocation_id, OLD.profile_id, OLD.membership_id, OLD.policy_version, OLD.created_at)
     IS DISTINCT FROM
     (NEW.allocation_id, NEW.profile_id, NEW.membership_id, NEW.policy_version, NEW.created_at)
     OR OLD.verified_post_id IS NOT NULL
     OR NEW.verified_post_id IS NULL THEN
    RAISE EXCEPTION 'share allocation can only be unlocked once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER mission_control_share_reward_once
BEFORE UPDATE OR DELETE ON mission_control_invitation_allocations
FOR EACH ROW EXECUTE FUNCTION mission_control_guard_share_reward();

ALTER TABLE mission_control_cards ADD COLUMN published_at TIMESTAMPTZ;
