-- Fails while a wallet session's reservation (`sui:<address>`) remains: those
-- rows are sponsored history and are not deleted here.
SET LOCAL lock_timeout = '3s';
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_privy_did_check;
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_privy_did_check
  CHECK (privy_did ~ '^did:privy:[A-Za-z0-9_-]{1,128}$');
