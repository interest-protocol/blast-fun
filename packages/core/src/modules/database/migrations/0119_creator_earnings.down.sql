DROP INDEX social_transactions_open_creator_idx;
-- Preserve history: rollback is allowed only before any creator action has been logged.
ALTER TABLE social_transactions DROP CONSTRAINT social_transactions_kind_check;
ALTER TABLE social_transactions ADD CONSTRAINT social_transactions_kind_check CHECK (kind IN (
  'commit','claim_refund','claim_tokens','claim_vesting','deposit','withdraw','trade_buy','trade_sell','vesting_create','vesting_claim','vesting_cancel','vesting_close'
));
