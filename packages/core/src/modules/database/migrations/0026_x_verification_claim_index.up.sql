-- The X verification claim takes the oldest due job:
--   ORDER BY next_attempt_at, created_at, job_id LIMIT 1 FOR UPDATE SKIP LOCKED
-- over pending jobs that are due and running jobs whose lease expired. The
-- 0024 partial indexes cover each branch on a different column, so every claim
-- combined them with a BitmapOr and sorted every due row to return one.
--
-- This index has the claim's order and both branches' rows (every running job
-- was claimed when due, so its next_attempt_at is in the past too): the claim
-- walks it from the oldest due job and stops at the first it can take.
--
-- Lock impact: plain CREATE INDEX, since the runner wraps each migration in a
-- transaction. It holds a SHARE lock on the jobs table while it builds, so job
-- writes wait; the table holds one row per check, so that takes well under a
-- second at launch scale. Additive: code before and after it runs unchanged.
CREATE INDEX mission_control_x_verification_jobs_claim_order
  ON mission_control_x_verification_jobs (next_attempt_at, created_at, job_id)
  WHERE status IN ('pending', 'running');
