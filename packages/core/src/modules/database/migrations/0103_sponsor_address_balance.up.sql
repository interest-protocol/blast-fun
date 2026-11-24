-- Presale sponsorship pays gas from the sponsor's address balance (blast-gas-pool's server.ts),
-- not from sui-gas-pool's reserved coins. A completed reservation therefore has bytes and a
-- digest but no pool reservation: pool_reservation_id stays null from now on (rows from the
-- retired pool keep theirs). Only the two CHECKs that tied it to the bytes change.
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_check1;
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_check2;
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_bytes_by_state
  CHECK ((state IN ('reserving', 'reservation_failed')) = (tx_bytes IS NULL AND digest IS NULL));
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_bytes_digest
  CHECK ((tx_bytes IS NULL) = (digest IS NULL));
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_pool_id_has_bytes
  CHECK (pool_reservation_id IS NULL OR tx_bytes IS NOT NULL);
