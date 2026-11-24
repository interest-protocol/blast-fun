-- Back to 0145: only `record_keys` is filled from `record_key`.
CREATE OR REPLACE FUNCTION mission_control_worker_submissions_record_keys() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.record_keys IS NULL THEN
    NEW.record_keys := ARRAY[NEW.record_key];
  END IF;
  RETURN NEW;
END $$;
