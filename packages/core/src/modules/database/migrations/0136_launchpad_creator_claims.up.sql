-- Launchpad creator fee claims (LP-12): a launch's curve fees (`claim_launch_fees`) and, once it
-- migrated, its vault's LP fees (`claim_launch_lp_fees`), both with the launch's `CurveFeeCap`.
-- Logged like the presale's creator actions, before anything is signed.
ALTER TABLE social_transactions DROP CONSTRAINT social_transactions_kind_check;
ALTER TABLE social_transactions ADD CONSTRAINT social_transactions_kind_check CHECK (kind IN (
  'commit','claim_refund','claim_tokens','claim_vesting','deposit','withdraw','trade_buy','trade_sell','vesting_create','vesting_claim','vesting_cancel','vesting_close','collect_fees','claim_residuals','claim_launch_fees','claim_launch_lp_fees'
));
-- The social worker settles sent claims and expires unsent ones through this, sized by the
-- claims in flight.
CREATE INDEX social_transactions_open_launch_claims_idx ON social_transactions(created_at_ms,tx_id)
  WHERE state='submitted' AND kind IN ('claim_launch_fees','claim_launch_lp_fees');

-- Only the authenticated launch claim route may reserve this server-built intent: it builds the
-- claim from the SDK after the chain shows the sender holds the launch's cap.
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_intent_check;
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_intent_check
  CHECK (intent IN ('commit','claim','settle','cancel','reward_claim','withdraw','trade','bridge_withdraw','create','vesting','creator_caps','launch_claim'));
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_presale_by_intent;
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_presale_by_intent
  CHECK ((presale_id IS NULL) = (intent IN ('withdraw','trade','bridge_withdraw','create','vesting','creator_caps','launch_claim')));
