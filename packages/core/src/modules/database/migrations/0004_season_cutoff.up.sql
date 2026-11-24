ALTER TABLE mission_control_seasons
  ADD COLUMN revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN announcement_at TIMESTAMPTZ,
  ADD COLUMN cutoff_at TIMESTAMPTZ,
  ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD CONSTRAINT mission_control_seasons_cutoff_schedule_check CHECK (
    (announcement_at IS NULL AND cutoff_at IS NULL)
    OR (
      announcement_at IS NOT NULL
      AND cutoff_at IS NOT NULL
      AND announcement_at < cutoff_at
    )
  );

INSERT INTO mission_control_seasons (season_id)
VALUES ('season-zero')
ON CONFLICT (season_id) DO NOTHING;
