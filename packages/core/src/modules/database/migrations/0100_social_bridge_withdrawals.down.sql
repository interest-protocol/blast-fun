-- Withdrawals to another chain and their sponsored reservations are records
-- of what Blast built, paid for and burned. Rolling back would have to delete
-- them, so it refuses while any exists instead.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM social_bridge_withdrawals) THEN
    RAISE EXCEPTION '0100 down: withdrawals to another chain exist; they are kept, not deleted';
  END IF;
  IF EXISTS (SELECT 1 FROM presale_sponsor_reservations WHERE intent = 'bridge_withdraw') THEN
    RAISE EXCEPTION '0100 down: sponsored withdrawal reservations exist; they are kept, not deleted';
  END IF;
END
$$;

ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_presale_by_intent;
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_intent_check;
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_intent_check
  CHECK (intent IN ('commit', 'claim', 'settle', 'cancel', 'reward_claim', 'withdraw', 'trade'));
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_presale_by_intent
  CHECK ((presale_id IS NULL) = (intent IN ('withdraw', 'trade')));

DROP TRIGGER social_bridge_withdrawals_immutable ON social_bridge_withdrawals;
DROP FUNCTION social_bridge_withdrawals_check_update();
DROP TABLE social_bridge_withdrawals;
