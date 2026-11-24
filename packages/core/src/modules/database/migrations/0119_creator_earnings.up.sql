ALTER TABLE social_transactions DROP CONSTRAINT social_transactions_kind_check;
ALTER TABLE social_transactions ADD CONSTRAINT social_transactions_kind_check CHECK (kind IN (
  'commit','claim_refund','claim_tokens','claim_vesting','deposit','withdraw','trade_buy','trade_sell','vesting_create','vesting_claim','vesting_cancel','vesting_close','collect_fees','claim_residuals'
));
CREATE INDEX social_transactions_open_creator_idx ON social_transactions(created_at_ms,tx_id)
  WHERE state='submitted' AND kind IN ('collect_fees','claim_residuals');
