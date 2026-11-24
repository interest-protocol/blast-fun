DROP INDEX IF EXISTS mission_control_account_wallets_one_primary;
DROP TABLE IF EXISTS mission_control_account_wallets;
DROP TABLE IF EXISTS mission_control_account_identities;

ALTER TABLE mission_control_wallet_challenges
  DROP CONSTRAINT mission_control_wallet_challenges_action_check,
  DROP CONSTRAINT mission_control_wallet_challenges_context_kind_check,
  DROP CONSTRAINT mission_control_wallet_challenges_action_context_check;

DELETE FROM mission_control_wallet_challenges
WHERE action = 'link_wallet' OR context_kind = 'account';

ALTER TABLE mission_control_wallet_challenges
  ADD CONSTRAINT mission_control_wallet_challenges_action_check
    CHECK (action IN ('onboarding', 'restore_crew_access')),
  ADD CONSTRAINT mission_control_wallet_challenges_context_kind_check
    CHECK (context_kind IN ('attempt', 'recovery')),
  ADD CONSTRAINT mission_control_wallet_challenges_check1
    CHECK (
      (action = 'onboarding' AND context_kind = 'attempt') OR
      (action = 'restore_crew_access' AND context_kind = 'recovery')
    );
