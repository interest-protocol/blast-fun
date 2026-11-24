-- The last step of contracting `record_key` (0145 added `record_keys`, 0146
-- made workers write it alone): every ledger-writing worker runs code that
-- names only `record_keys`, so `record_key` and the trigger that kept the two
-- in step go. `record_keys` keeps its own check.
ALTER TABLE mission_control_worker_submissions
  DROP CONSTRAINT mission_control_worker_submissions_record_keys_check;
DROP TRIGGER mission_control_worker_submissions_record_keys ON mission_control_worker_submissions;
DROP FUNCTION mission_control_worker_submissions_record_keys();
ALTER TABLE mission_control_worker_submissions
  DROP COLUMN record_key,
  ADD CONSTRAINT mission_control_worker_submissions_record_keys_check
    CHECK (mission_control_worker_record_keys_valid(record_keys));
