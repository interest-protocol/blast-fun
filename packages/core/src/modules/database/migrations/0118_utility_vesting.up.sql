ALTER TABLE social_transactions DROP CONSTRAINT social_transactions_kind_check;
ALTER TABLE social_transactions ADD CONSTRAINT social_transactions_kind_check CHECK (kind IN ('commit','claim_refund','claim_tokens','claim_vesting','deposit','withdraw','trade_buy','trade_sell','vesting_create','vesting_claim','vesting_cancel','vesting_close'));
-- Fully built bytes bind a logged intent to exactly one digest before signing/execution.
CREATE TABLE social_vesting_attempts (
  request_id UUID PRIMARY KEY REFERENCES social_transactions(tx_id),
  account_id UUID NOT NULL REFERENCES social_accounts(account_id),
  sender TEXT NOT NULL CHECK(sender ~ '^0x[0-9a-f]{64}$'),
  intent JSONB NOT NULL,
  transaction_bytes TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  gas_budget TEXT NOT NULL,
  expires_at_ms BIGINT NOT NULL,
  schedule_id TEXT CHECK(schedule_id ~ '^0x[0-9a-f]{64}$')
);
CREATE INDEX social_vesting_attempts_account ON social_vesting_attempts(account_id,request_id);
CREATE FUNCTION social_vesting_attempts_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF (to_jsonb(NEW) - 'schedule_id') IS DISTINCT FROM (to_jsonb(OLD) - 'schedule_id')
    OR OLD.schedule_id IS NOT NULL AND NEW.schedule_id IS DISTINCT FROM OLD.schedule_id THEN
    RAISE EXCEPTION 'vesting attempt facts are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER social_vesting_attempts_immutable BEFORE UPDATE ON social_vesting_attempts FOR EACH ROW EXECUTE FUNCTION social_vesting_attempts_immutable();
REVOKE ALL ON social_vesting_attempts FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON social_vesting_attempts TO blast_web;
