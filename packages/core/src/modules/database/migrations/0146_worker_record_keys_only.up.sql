-- The first step of contracting `record_key` (0145 added `record_keys` beside
-- it): workers stop writing `record_key`, and the row gets it from
-- `record_keys[1]`, as code that writes only `record_key` gets `record_keys`
-- from it. Both kinds of worker keep working while they are redeployed; a
-- later migration drops `record_key` once none writes it.
CREATE OR REPLACE FUNCTION mission_control_worker_submissions_record_keys() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.record_keys IS NULL THEN
    NEW.record_keys := ARRAY[NEW.record_key];
  END IF;
  IF NEW.record_key IS NULL THEN
    NEW.record_key := NEW.record_keys[1];
  END IF;
  RETURN NEW;
END $$;
