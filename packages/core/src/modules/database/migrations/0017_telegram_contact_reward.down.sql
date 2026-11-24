DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM mission_control_invitation_allocations WHERE telegram_submitted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'Cannot roll back Telegram rewards after codes have been issued';
  END IF;
END $$;
ALTER TABLE mission_control_invitation_allocations
  DROP CONSTRAINT mission_control_contact_rewards,
  DROP COLUMN telegram_username,
  DROP COLUMN telegram_submitted_at,
  ADD CONSTRAINT mission_control_share_reward CHECK (
    (code_count = 0 AND verified_post_id IS NULL AND verified_shared_at IS NULL) OR
    (code_count = 2 AND verified_post_id IS NOT NULL AND verified_shared_at IS NOT NULL)
  );
CREATE OR REPLACE FUNCTION mission_control_guard_share_reward()
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
