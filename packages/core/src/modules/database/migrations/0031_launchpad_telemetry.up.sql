-- Launchpad outcome telemetry (modules/launchpad-telemetry). Visitors are an
-- opaque first-party random ID; no wallet, Privy subject, profile, thesis,
-- URL, signature or provider ID has a column. Raw volume is not stored.

-- The denominator: a visitor's first view of a tradable coin, once per
-- reporting period (one row per period, visitor and coin).
CREATE TABLE mission_control_launchpad_coin_views (
  period_start DATE NOT NULL,
  visitor_id UUID NOT NULL,
  launch_id TEXT NOT NULL CHECK (launch_id ~ '^0x[0-9a-f]{64}$'),
  surface TEXT NOT NULL CHECK (surface IN ('coin-page')),
  viewed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (period_start, visitor_id, launch_id)
);

CREATE INDEX mission_control_launchpad_coin_views_visitor_idx
  ON mission_control_launchpad_coin_views (visitor_id, viewed_at);

-- Verified outcomes: one row per completed chain event (transaction digest
-- and event position, in a checkpoint). Flows record them after completion;
-- an intent, simulation, signature or submitted digest has no row.
CREATE TABLE mission_control_launchpad_outcomes (
  tx_digest TEXT NOT NULL CHECK (tx_digest ~ '^[1-9A-HJ-NP-Za-km-z]{43,44}$'),
  event_seq INTEGER NOT NULL CHECK (event_seq >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('buy', 'launch', 'migration')),
  checkpoint BIGINT NOT NULL CHECK (checkpoint >= 0),
  launch_id TEXT NOT NULL CHECK (launch_id ~ '^0x[0-9a-f]{64}$'),
  visitor_id UUID,
  completed_at TIMESTAMPTZ NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tx_digest, event_seq)
);

CREATE INDEX mission_control_launchpad_outcomes_completed_idx
  ON mission_control_launchpad_outcomes (completed_at);

CREATE INDEX mission_control_launchpad_outcomes_visitor_idx
  ON mission_control_launchpad_outcomes (visitor_id, kind, completed_at)
  WHERE visitor_id IS NOT NULL;

-- Web tables are the web runtime's to read and write, and no one else's (0030).
REVOKE ALL ON TABLE mission_control_launchpad_coin_views FROM PUBLIC;
REVOKE ALL ON TABLE mission_control_launchpad_outcomes FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mission_control_launchpad_coin_views TO blast_web;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mission_control_launchpad_outcomes TO blast_web;
