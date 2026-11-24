-- Definite keyed refusals are retained without retrying or refunding shared budgets.
ALTER TABLE presale_sponsor_budget_attempts ADD COLUMN refusal_reason TEXT
  CHECK (refusal_reason IN ('presale_sponsor_ip', 'presale_sponsor_account_daily', 'presale_sponsor_global', 'open_reservations', 'claim_busy'));
ALTER TABLE presale_sponsor_budget_attempts DROP CONSTRAINT presale_sponsor_budget_attempts_state_check;
ALTER TABLE presale_sponsor_budget_attempts DROP CONSTRAINT presale_sponsor_budget_attempts_check;
ALTER TABLE presale_sponsor_budget_attempts ADD CONSTRAINT presale_sponsor_budget_attempts_state_check CHECK (state IN ('started', 'completed', 'refused'));
ALTER TABLE presale_sponsor_budget_attempts ADD CONSTRAINT presale_sponsor_budget_attempts_check CHECK ((state IN ('completed', 'refused')) = (completed_at IS NOT NULL));
ALTER TABLE presale_sponsor_budget_attempts ADD CONSTRAINT presale_sponsor_budget_attempts_refusal_check CHECK ((state = 'refused') = (refusal_reason IS NOT NULL));
CREATE OR REPLACE FUNCTION presale_sponsor_budget_attempts_check_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['state', 'completed_at', 'refusal_reason']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'completed_at', 'refusal_reason'])
    OR OLD.state <> 'started' OR NEW.state NOT IN ('completed', 'refused') THEN
    RAISE EXCEPTION 'a sponsor budget attempt only resolves once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
ALTER TABLE social_bridge_withdrawals DROP CONSTRAINT social_bridge_withdrawals_failure_code_check;
ALTER TABLE social_bridge_withdrawals ADD CONSTRAINT social_bridge_withdrawals_failure_code_check CHECK (failure_code IN ('insufficient_balance', 'dry_run_failed', 'sponsor_refused', 'execution_failed', 'mismatch', 'expired'));
ALTER TABLE social_bridge_withdrawals DROP CONSTRAINT social_bridge_withdrawals_refused;
ALTER TABLE social_bridge_withdrawals ADD CONSTRAINT social_bridge_withdrawals_refused CHECK ((tx_bytes IS NULL) = (state = 'failed' AND failure_code IN ('insufficient_balance', 'dry_run_failed', 'sponsor_refused')));
