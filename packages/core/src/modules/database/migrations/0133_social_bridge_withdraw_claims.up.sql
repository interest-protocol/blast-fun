-- Claim one immutable request before any external build/sponsor work. A bounded
-- owner lease can be recovered; final ledger writes are fenced by the owner.
-- The stable withdrawal UUID also identifies the sponsor's atomic reservation.
CREATE TABLE social_bridge_withdraw_claims (
  account_id UUID NOT NULL REFERENCES social_accounts(account_id),
  idempotency_key TEXT NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  withdrawal_id UUID NOT NULL UNIQUE,
  owner_token UUID NOT NULL,
  lease_until_ms BIGINT NOT NULL,
  PRIMARY KEY (account_id, idempotency_key)
);
CREATE FUNCTION social_bridge_withdraw_claims_check_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['owner_token', 'lease_until_ms'])
    IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['owner_token', 'lease_until_ms']) THEN
    RAISE EXCEPTION 'withdrawal claim facts are immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER social_bridge_withdraw_claims_immutable BEFORE UPDATE ON social_bridge_withdraw_claims
FOR EACH ROW EXECUTE FUNCTION social_bridge_withdraw_claims_check_update();
REVOKE ALL ON social_bridge_withdraw_claims FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON social_bridge_withdraw_claims TO blast_web;

-- Budget counters may live outside Postgres. Persist permission before trying
-- them; ambiguous consumption is never automatically repeated or refunded.
CREATE TABLE presale_sponsor_budget_attempts (
  reservation_id UUID PRIMARY KEY REFERENCES social_bridge_withdraw_claims(withdrawal_id),
  attempted_at TIMESTAMPTZ NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('started', 'completed')),
  completed_at TIMESTAMPTZ,
  CHECK ((state = 'completed') = (completed_at IS NOT NULL))
);
CREATE FUNCTION presale_sponsor_budget_attempts_check_update()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['state', 'completed_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['state', 'completed_at'])
    OR OLD.state <> 'started' OR NEW.state <> 'completed' THEN
    RAISE EXCEPTION 'a sponsor budget attempt only completes once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER presale_sponsor_budget_attempts_immutable BEFORE UPDATE ON presale_sponsor_budget_attempts
FOR EACH ROW EXECUTE FUNCTION presale_sponsor_budget_attempts_check_update();
REVOKE ALL ON presale_sponsor_budget_attempts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON presale_sponsor_budget_attempts TO blast_web;
