-- Only the authenticated vesting builder may reserve this server-built intent.
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_intent_check;
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_intent_check
  CHECK (intent IN ('commit','claim','settle','cancel','reward_claim','withdraw','trade','bridge_withdraw','create','vesting'));
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_presale_by_intent;
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_presale_by_intent
  CHECK ((presale_id IS NULL) = (intent IN ('withdraw','trade','bridge_withdraw','create','vesting')));

-- Immutable alongside the reviewed bytes and digest; existing wallet-paid attempts stay valid.
ALTER TABLE social_vesting_attempts ADD COLUMN sponsor_reservation_id UUID UNIQUE
  REFERENCES presale_sponsor_reservations(id);
