-- Each account's opaque creator-recipient commitment (contracts ADR 0080): 32 random bytes, minted
-- once and never changed, so a launch that names it stays claimable by this account alone.
CREATE TABLE social_creator_commitments (
  account_id UUID PRIMARY KEY REFERENCES social_accounts (account_id),
  commitment BYTEA NOT NULL UNIQUE CHECK (octet_length(commitment) = 32),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON social_creator_commitments FROM PUBLIC;
GRANT SELECT, INSERT ON social_creator_commitments TO blast_web;

-- Only the authenticated creator-caps route may reserve this server-built intent.
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_intent_check;
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_intent_check
  CHECK (intent IN ('commit','claim','settle','cancel','reward_claim','withdraw','trade','bridge_withdraw','create','vesting','creator_caps'));
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_presale_by_intent;
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_presale_by_intent
  CHECK ((presale_id IS NULL) = (intent IN ('withdraw','trade','bridge_withdraw','create','vesting','creator_caps')));
