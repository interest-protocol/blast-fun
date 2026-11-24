DROP TABLE IF EXISTS social_wallet_sessions;

-- A wallet-only account cannot be expressed without 0058: refuse rather than
-- delete members' records.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM social_accounts WHERE profile_id IS NULL AND privy_did IS NULL) THEN
    RAISE EXCEPTION 'wallet-only social accounts exist; 0058 cannot be rolled back'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
END $$;

ALTER TABLE social_accounts
  DROP CONSTRAINT social_accounts_new_account_identity,
  DROP COLUMN sui_address,
  ADD CONSTRAINT social_accounts_new_account_privy_did CHECK (profile_id IS NOT NULL OR privy_did IS NOT NULL);

DELETE FROM mission_control_wallet_challenges WHERE action = 'sign_in';

ALTER TABLE mission_control_wallet_challenges
  DROP CONSTRAINT mission_control_wallet_challenges_action_check,
  DROP CONSTRAINT mission_control_wallet_challenges_action_context_check;

ALTER TABLE mission_control_wallet_challenges
  ADD CONSTRAINT mission_control_wallet_challenges_action_check
    CHECK (action IN ('onboarding', 'restore_crew_access', 'link_wallet')),
  ADD CONSTRAINT mission_control_wallet_challenges_action_context_check
    CHECK (
      (action = 'onboarding' AND context_kind = 'attempt') OR
      (action = 'restore_crew_access' AND context_kind = 'recovery') OR
      (action = 'link_wallet' AND context_kind = 'account')
    );
