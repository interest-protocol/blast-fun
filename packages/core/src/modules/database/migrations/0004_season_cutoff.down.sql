ALTER TABLE mission_control_seasons
  DROP CONSTRAINT mission_control_seasons_cutoff_schedule_check,
  DROP COLUMN updated_at,
  DROP COLUMN cutoff_at,
  DROP COLUMN announcement_at,
  DROP COLUMN revision;
