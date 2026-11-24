CREATE TABLE mission_control_campaign_events (
  sequence BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_id UUID NOT NULL UNIQUE,
  event_schema TEXT NOT NULL,
  event_version INTEGER NOT NULL CHECK (event_version > 0),
  event_type TEXT NOT NULL,
  season_id TEXT,
  profile_id TEXT,
  code_id TEXT,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_revision BIGINT NOT NULL CHECK (aggregate_revision > 0),
  occurred_at TIMESTAMPTZ NOT NULL,
  effective_at TIMESTAMPTZ NOT NULL,
  dedupe_key TEXT NOT NULL UNIQUE,
  public_payload JSONB NOT NULL CHECK (jsonb_typeof(public_payload) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (aggregate_type, aggregate_id, aggregate_revision)
);

CREATE INDEX mission_control_campaign_events_season_sequence_idx
  ON mission_control_campaign_events (season_id, sequence);

CREATE INDEX mission_control_campaign_events_profile_sequence_idx
  ON mission_control_campaign_events (profile_id, sequence);

CREATE TABLE mission_control_projection_checkpoints (
  projection_name TEXT PRIMARY KEY,
  last_sequence BIGINT NOT NULL DEFAULT 0 CHECK (last_sequence >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE mission_control_projection_deliveries (
  projection_name TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  event_id UUID NOT NULL REFERENCES mission_control_campaign_events(event_id),
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (projection_name, dedupe_key)
);

CREATE TABLE mission_control_owner_projection (
  profile_id TEXT PRIMARY KEY,
  season_id TEXT NOT NULL,
  callsign TEXT NOT NULL,
  display_name TEXT,
  wallet_address TEXT NOT NULL,
  crew TEXT NOT NULL,
  title TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  last_event_id UUID NOT NULL REFERENCES mission_control_campaign_events(event_id)
);

CREATE TABLE mission_control_telemetry_projection (
  season_id TEXT PRIMARY KEY,
  joined_total BIGINT NOT NULL DEFAULT 0 CHECK (joined_total >= 0),
  last_sequence BIGINT NOT NULL CHECK (last_sequence > 0),
  last_event_id UUID NOT NULL REFERENCES mission_control_campaign_events(event_id)
);
