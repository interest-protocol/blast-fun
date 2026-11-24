DO $$ BEGIN
  IF EXISTS (SELECT FROM presale_daily_allocations WHERE weight = 0) THEN
    RAISE EXCEPTION '0150 rollback would invalidate committed treasury reward leaves';
  END IF;
END $$;
ALTER TABLE presale_daily_allocations DROP CONSTRAINT presale_daily_allocations_weight_check;
ALTER TABLE presale_daily_allocations ADD CONSTRAINT presale_daily_allocations_weight_check CHECK (weight > 0);
