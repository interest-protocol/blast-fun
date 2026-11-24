-- Configurations are insert-only: published scoring rules cannot change mid-event.
-- Receipts remain independent facts; overlapping competitions can reuse them.
CREATE TABLE social_competitions (
  slug TEXT PRIMARY KEY CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  coin_type TEXT NOT NULL CHECK (char_length(coin_type) BETWEEN 8 AND 512),
  coin_symbol TEXT NOT NULL CHECK (char_length(coin_symbol) BETWEEN 1 AND 20),
  feature_on_swap BOOLEAN NOT NULL DEFAULT FALSE,
  coin_icon_url TEXT CHECK (char_length(coin_icon_url) BETWEEN 1 AND 2048),
  prize_description TEXT CHECK (char_length(prize_description) BETWEEN 1 AND 240),
  rules_url TEXT CHECK (char_length(rules_url) BETWEEN 1 AND 2048),
  CHECK (prize_description IS NULL OR rules_url IS NOT NULL),
  starts_at_ms BIGINT NOT NULL,
  ends_at_ms BIGINT NOT NULL CHECK (ends_at_ms > starts_at_ms),
  rules_version SMALLINT NOT NULL DEFAULT 1 CHECK (rules_version = 1),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  created_by TEXT NOT NULL CHECK (created_by ~ '^operator:[A-Za-z0-9][A-Za-z0-9._@-]{2,99}$'),
  CHECK (starts_at_ms > extract(epoch FROM created_at) * 1000)
);
CREATE INDEX social_competitions_window ON social_competitions (starts_at_ms DESC, slug);
CREATE INDEX social_competitions_swap_window ON social_competitions (ends_at_ms, starts_at_ms) WHERE feature_on_swap;
REVOKE ALL ON TABLE social_competitions FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE social_competitions TO blast_web;
