-- One worker transaction may carry several records (a PTB of migrations or of
-- fee claims): `record_keys` names every record of a submission, in command
-- order, beside `record_key`, its first.
--
-- Expand only, so the code still serving keeps working: it writes `record_key`
-- alone, and the row gets `record_keys` from it. Batching code writes both. A
-- later migration drops `record_key` once every worker writes `record_keys`.

-- Each key 1-1,024 characters, none twice, at most 32 (the signer's limit). A
-- CHECK cannot hold a subquery; it can call an immutable function.
CREATE FUNCTION mission_control_worker_record_keys_valid(keys TEXT[])
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(array_ndims(keys) = 1, false)
    AND cardinality(keys) BETWEEN 1 AND 32
    AND NOT EXISTS (SELECT 1 FROM unnest(keys) AS key WHERE key IS NULL OR char_length(key) NOT BETWEEN 1 AND 1024)
    AND (SELECT count(DISTINCT key) FROM unnest(keys) AS key) = cardinality(keys)
$$;

-- A row written by code that names only `record_key` carries that one record.
CREATE FUNCTION mission_control_worker_submissions_record_keys() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.record_keys IS NULL THEN
    NEW.record_keys := ARRAY[NEW.record_key];
  END IF;
  RETURN NEW;
END $$;

ALTER TABLE mission_control_worker_submissions ADD COLUMN record_keys TEXT[];
UPDATE mission_control_worker_submissions SET record_keys = ARRAY[record_key];

CREATE TRIGGER mission_control_worker_submissions_record_keys
  BEFORE INSERT OR UPDATE OF record_key, record_keys ON mission_control_worker_submissions
  FOR EACH ROW EXECUTE FUNCTION mission_control_worker_submissions_record_keys();

ALTER TABLE mission_control_worker_submissions
  ALTER COLUMN record_keys SET NOT NULL,
  ADD CONSTRAINT mission_control_worker_submissions_record_keys_check CHECK (
    mission_control_worker_record_keys_valid(record_keys) AND record_keys[1] = record_key
  );
