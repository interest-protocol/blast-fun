-- Trades and sponsored trade reservations are records of what Blast built and
-- paid for. Rolling back would have to delete them, so it refuses while any
-- exists instead.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM social_swap_intents) THEN
    RAISE EXCEPTION '0089 down: trades exist; they are kept, not deleted';
  END IF;
  IF EXISTS (SELECT 1 FROM presale_sponsor_reservations WHERE intent = 'trade') THEN
    RAISE EXCEPTION '0089 down: sponsored trade reservations exist; they are kept, not deleted';
  END IF;
END
$$;

ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_presale_by_intent;
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_intent_check;
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_intent_check
  CHECK (intent IN ('commit', 'claim', 'settle', 'cancel', 'reward_claim', 'withdraw'));
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_presale_by_intent
  CHECK ((presale_id IS NULL) = (intent = 'withdraw'));

DROP TRIGGER social_swap_intents_immutable ON social_swap_intents;
DROP FUNCTION social_swap_intents_check_update();
DROP TABLE social_swap_intents;
