ALTER TABLE social_vesting_attempts DROP COLUMN sponsor_reservation_id;
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_intent_check;
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_intent_check
  CHECK (intent IN ('commit','claim','settle','cancel','reward_claim','withdraw','trade','bridge_withdraw','create')) NOT VALID;
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_presale_by_intent;
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_presale_by_intent
  CHECK ((presale_id IS NULL) = (intent IN ('withdraw','trade','bridge_withdraw','create'))) NOT VALID;
