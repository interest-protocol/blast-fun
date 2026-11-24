-- Never discard retained refusal facts to make an older schema fit.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM presale_sponsor_budget_attempts WHERE state = 'refused')
    OR EXISTS (SELECT 1 FROM social_bridge_withdrawals WHERE failure_code = 'sponsor_refused') THEN
    RAISE EXCEPTION '0134 down: retained sponsor refusals prevent rollback';
  END IF;
END
$$;
ALTER TABLE social_bridge_withdrawals DROP CONSTRAINT social_bridge_withdrawals_refused;
ALTER TABLE social_bridge_withdrawals ADD CONSTRAINT social_bridge_withdrawals_refused CHECK ((tx_bytes IS NULL) = (state = 'failed' AND failure_code IN ('insufficient_balance', 'dry_run_failed')));
ALTER TABLE social_bridge_withdrawals DROP CONSTRAINT social_bridge_withdrawals_failure_code_check;
ALTER TABLE social_bridge_withdrawals ADD CONSTRAINT social_bridge_withdrawals_failure_code_check CHECK (failure_code IN ('insufficient_balance', 'dry_run_failed', 'execution_failed', 'mismatch', 'expired'));
ALTER TABLE presale_sponsor_budget_attempts DROP CONSTRAINT presale_sponsor_budget_attempts_refusal_check;
ALTER TABLE presale_sponsor_budget_attempts DROP CONSTRAINT presale_sponsor_budget_attempts_state_check;
ALTER TABLE presale_sponsor_budget_attempts DROP CONSTRAINT presale_sponsor_budget_attempts_check;
ALTER TABLE presale_sponsor_budget_attempts ADD CONSTRAINT presale_sponsor_budget_attempts_state_check CHECK (state IN ('started', 'completed'));
ALTER TABLE presale_sponsor_budget_attempts ADD CONSTRAINT presale_sponsor_budget_attempts_check CHECK ((state = 'completed') = (completed_at IS NOT NULL));
ALTER TABLE presale_sponsor_budget_attempts DROP COLUMN refusal_reason;
CREATE OR REPLACE FUNCTION presale_sponsor_budget_attempts_check_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['state', 'completed_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'completed_at'])
    OR OLD.state <> 'started' OR NEW.state <> 'completed' THEN
    RAISE EXCEPTION 'a sponsor budget attempt only completes once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
