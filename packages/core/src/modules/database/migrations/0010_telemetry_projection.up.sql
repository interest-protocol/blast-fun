CREATE TABLE mission_control_campaign_telemetry_projection (
  season_id TEXT PRIMARY KEY,
  total_crew BIGINT NOT NULL DEFAULT 0 CHECK (total_crew >= 0),
  recruits BIGINT NOT NULL DEFAULT 0 CHECK (recruits >= 0),
  zero_fleet BIGINT NOT NULL DEFAULT 0 CHECK (zero_fleet >= 0),
  last_sequence BIGINT NOT NULL CHECK (last_sequence > 0),
  last_event_id UUID NOT NULL REFERENCES mission_control_campaign_events(event_id),
  projected_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE mission_control_campaign_telemetry_blastoff_facts (
  fact_event_id UUID PRIMARY KEY REFERENCES mission_control_campaign_events(event_id),
  season_id TEXT NOT NULL,
  blastoff_at TIMESTAMPTZ NOT NULL,
  delta SMALLINT NOT NULL CHECK (delta IN (-1, 1)),
  sequence BIGINT NOT NULL CHECK (sequence > 0)
);

CREATE INDEX mission_control_campaign_telemetry_blastoff_window_idx
  ON mission_control_campaign_telemetry_blastoff_facts (season_id, blastoff_at);
