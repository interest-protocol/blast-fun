-- Back to 0146: `record_key` returns as each row's first key, kept in step
-- with `record_keys` by the trigger.
ALTER TABLE mission_control_worker_submissions
  DROP CONSTRAINT mission_control_worker_submissions_record_keys_check,
  ADD COLUMN record_key TEXT;
UPDATE mission_control_worker_submissions SET record_key = record_keys[1];
ALTER TABLE mission_control_worker_submissions
  ALTER COLUMN record_key SET NOT NULL,
  ADD CONSTRAINT mission_control_worker_submissions_record_keys_check CHECK (
    mission_control_worker_record_keys_valid(record_keys) AND record_keys[1] = record_key
  );

CREATE FUNCTION mission_control_worker_submissions_record_keys() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.record_keys IS NULL THEN
    NEW.record_keys := ARRAY[NEW.record_key];
  END IF;
  IF NEW.record_key IS NULL THEN
    NEW.record_key := NEW.record_keys[1];
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER mission_control_worker_submissions_record_keys
  BEFORE INSERT OR UPDATE OF record_key, record_keys ON mission_control_worker_submissions
  FOR EACH ROW EXECUTE FUNCTION mission_control_worker_submissions_record_keys();
