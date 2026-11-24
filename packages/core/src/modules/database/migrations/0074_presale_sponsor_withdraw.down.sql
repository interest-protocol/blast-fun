-- Withdraw reservations are records of sponsored transfers (gas the pool
-- paid). Rolling back would have to delete them, so it refuses while any
-- exists instead.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM presale_sponsor_reservations WHERE intent = 'withdraw') THEN
    RAISE EXCEPTION '0074 down: sponsored withdraw reservations exist; they are kept, not deleted';
  END IF;
END
$$;

ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_presale_by_intent;
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_intent_check;
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_intent_check
  CHECK (intent IN ('commit', 'claim', 'settle', 'cancel', 'reward_claim'));
ALTER TABLE presale_sponsor_reservations ALTER COLUMN presale_id SET NOT NULL;
