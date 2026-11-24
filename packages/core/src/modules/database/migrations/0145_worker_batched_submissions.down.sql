-- Back to `record_key` alone: a row that carried several records keeps only
-- its first record's key there.
DROP TRIGGER mission_control_worker_submissions_record_keys ON mission_control_worker_submissions;
DROP FUNCTION mission_control_worker_submissions_record_keys();
ALTER TABLE mission_control_worker_submissions DROP COLUMN record_keys;
DROP FUNCTION mission_control_worker_record_keys_valid(TEXT[]);
