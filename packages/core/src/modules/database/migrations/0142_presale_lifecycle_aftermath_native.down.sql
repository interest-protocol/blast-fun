ALTER TABLE presale_lifecycle_records DROP CONSTRAINT presale_lifecycle_records_venue_check;
ALTER TABLE presale_lifecycle_records ADD CONSTRAINT presale_lifecycle_records_venue_check
  CHECK (venue IN ('cetus', 'bluefin', 'aftermath'));
