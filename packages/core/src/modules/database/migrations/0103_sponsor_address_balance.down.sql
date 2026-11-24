-- Fails if an address-balance reservation (bytes without a pool reservation id) exists.
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_pool_id_has_bytes;
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_bytes_digest;
ALTER TABLE presale_sponsor_reservations DROP CONSTRAINT presale_sponsor_reservations_bytes_by_state;
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_check1 CHECK (
  (state IN ('reserving', 'reservation_failed'))
  = (pool_reservation_id IS NULL AND tx_bytes IS NULL AND digest IS NULL)
);
ALTER TABLE presale_sponsor_reservations ADD CONSTRAINT presale_sponsor_reservations_check2 CHECK (
  (pool_reservation_id IS NULL) = (tx_bytes IS NULL) AND (tx_bytes IS NULL) = (digest IS NULL)
);
