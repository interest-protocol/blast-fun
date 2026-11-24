-- Projection pending scans read only events above a low watermark instead of
-- anti-joining every campaign event against its deliveries
-- (read-model/runner.ts, docs/mission-control/capacity.md#projections).
--
-- low_watermark: the pending scan skips events at or below it.
-- watermark_candidate, watermark_candidate_at: a checkpoint and when it was
--   recorded. A batch that listed every visible pending event promotes the
--   candidate to low_watermark once it is at least the watermark window old,
--   then records the current checkpoint as the next candidate.
-- swept_at: when the backstop sweep last finished checking every event at or
--   below low_watermark.
--
-- The index lets the scan read a projection's deliveries in sequence order
-- from the watermark up, beside the events' primary key, as a merge anti-join
-- (EXPLAIN on 60,000 events: 6 ms for the last 1,000, 30 ms for the last
-- 20,000, where the hash anti-join over every delivery took 50 ms and grew with
-- the history).
--
-- Lock impact: the runner wraps each migration in a transaction, so this is a
-- plain CREATE INDEX. It holds a SHARE lock on the deliveries table while it
-- builds, so projection batches wait (about 0.1 s per 60,000 deliveries);
-- completions and telemetry reads never touch that table. ADD COLUMN with
-- constant or NOW() defaults stores the default instead of rewriting the
-- table, under a brief ACCESS EXCLUSIVE lock on the checkpoints (one row per
-- projection), so a telemetry read or projection batch in flight delays it by
-- at most its own length. Additive: code before it ignores the columns and the
-- index.
ALTER TABLE mission_control_projection_checkpoints
  ADD COLUMN low_watermark BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN watermark_candidate BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN watermark_candidate_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN swept_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD CONSTRAINT mission_control_projection_checkpoints_watermark_order
    CHECK (
      low_watermark >= 0
      AND low_watermark <= watermark_candidate
      AND watermark_candidate <= last_sequence
    );

CREATE INDEX mission_control_projection_deliveries_sequence_idx
  ON mission_control_projection_deliveries (projection_name, sequence);
