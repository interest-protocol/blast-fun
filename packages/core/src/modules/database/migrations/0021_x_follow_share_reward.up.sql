ALTER TABLE mission_control_invitation_allocations
  ADD COLUMN verified_followed_at TIMESTAMPTZ;

UPDATE mission_control_invitation_allocations
SET verified_followed_at = verified_shared_at
WHERE verified_post_id IS NOT NULL;

ALTER TABLE mission_control_invitation_allocations
  DROP CONSTRAINT mission_control_contact_rewards,
  ADD CONSTRAINT mission_control_contact_rewards CHECK (
    ((verified_post_id IS NULL AND verified_shared_at IS NULL) OR
     (verified_post_id IS NOT NULL AND verified_shared_at IS NOT NULL)) AND
    ((telegram_username IS NULL AND telegram_submitted_at IS NULL) OR
     (telegram_username IS NOT NULL AND telegram_submitted_at IS NOT NULL)) AND
    code_count =
      (CASE WHEN verified_post_id IS NOT NULL AND verified_followed_at IS NOT NULL THEN 2 ELSE 0 END) +
      (CASE WHEN telegram_submitted_at IS NULL THEN 0 ELSE 1 END)
  );

CREATE OR REPLACE FUNCTION mission_control_guard_share_reward()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reward allocation cannot be deleted' USING ERRCODE = 'check_violation';
  END IF;
  IF (OLD.allocation_id, OLD.profile_id, OLD.membership_id, OLD.policy_version, OLD.created_at)
     IS DISTINCT FROM
     (NEW.allocation_id, NEW.profile_id, NEW.membership_id, NEW.policy_version, NEW.created_at)
     OR (OLD.verified_post_id IS NOT NULL AND
       (OLD.verified_post_id, OLD.verified_shared_at) IS DISTINCT FROM (NEW.verified_post_id, NEW.verified_shared_at))
     OR (OLD.verified_followed_at IS NOT NULL AND
       OLD.verified_followed_at IS DISTINCT FROM NEW.verified_followed_at)
     OR (OLD.telegram_submitted_at IS NOT NULL AND
       OLD.telegram_submitted_at IS DISTINCT FROM NEW.telegram_submitted_at) THEN
    RAISE EXCEPTION 'each reward can only be unlocked once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
