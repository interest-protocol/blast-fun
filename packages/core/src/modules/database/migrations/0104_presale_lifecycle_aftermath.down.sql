-- Aftermath lifecycle records are what the relayer did for those sales
-- (its digests, attempts and blocks). Rolling back would have to delete
-- them, so it refuses while any exists instead.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM presale_lifecycle_records WHERE venue = 'aftermath') THEN
    RAISE EXCEPTION '0103 down: Aftermath lifecycle records exist; they are kept, not deleted';
  END IF;
END
$$;

ALTER TABLE presale_lifecycle_records DROP CONSTRAINT presale_lifecycle_records_pool_creation_venue;
ALTER TABLE presale_lifecycle_records DROP COLUMN aftermath_pool_creation_id;
ALTER TABLE presale_lifecycle_records DROP CONSTRAINT presale_lifecycle_records_venue_check;
ALTER TABLE presale_lifecycle_records ADD CONSTRAINT presale_lifecycle_records_venue_check
  CHECK (venue IN ('cetus', 'bluefin'));
