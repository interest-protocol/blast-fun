DROP INDEX IF EXISTS mission_control_projection_deliveries_sequence_idx;
ALTER TABLE mission_control_projection_checkpoints
  DROP CONSTRAINT IF EXISTS mission_control_projection_checkpoints_watermark_order,
  DROP COLUMN IF EXISTS swept_at,
  DROP COLUMN IF EXISTS watermark_candidate_at,
  DROP COLUMN IF EXISTS watermark_candidate,
  DROP COLUMN IF EXISTS low_watermark;
