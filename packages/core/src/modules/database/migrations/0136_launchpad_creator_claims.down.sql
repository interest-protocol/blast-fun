ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_intent_check;
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_intent_check
  CHECK (intent IN ('commit','claim','settle','cancel','reward_claim','withdraw','trade','bridge_withdraw','create','vesting','creator_caps')) NOT VALID;
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_presale_by_intent;
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_presale_by_intent
  CHECK ((presale_id IS NULL) = (intent IN ('withdraw','trade','bridge_withdraw','create','vesting','creator_caps'))) NOT VALID;

DROP INDEX social_transactions_open_launch_claims_idx;
-- Preserve history: rollback is allowed only before any launchpad creator claim has been logged.
ALTER TABLE social_transactions DROP CONSTRAINT social_transactions_kind_check;
ALTER TABLE social_transactions ADD CONSTRAINT social_transactions_kind_check CHECK (kind IN (
  'commit','claim_refund','claim_tokens','claim_vesting','deposit','withdraw','trade_buy','trade_sell','vesting_create','vesting_claim','vesting_cancel','vesting_close','collect_fees','claim_residuals'
));
