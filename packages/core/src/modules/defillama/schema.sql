-- Dedicated REPORTING database, not the chain primary or the web application database.
-- Run as its migration owner, then grant these NOLOGIN roles to separate service logins.
CREATE SCHEMA defillama;
REVOKE ALL ON SCHEMA defillama FROM PUBLIC;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='blast_defillama_reader') THEN
    CREATE ROLE blast_defillama_reader NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='blast_defillama_publisher') THEN
    CREATE ROLE blast_defillama_publisher NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA defillama TO blast_defillama_reader, blast_defillama_publisher;

CREATE TABLE defillama.snapshots (
  id TEXT PRIMARY KEY CHECK (id ~ '^[0-9a-f]{64}$'),
  fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  feed_key TEXT NOT NULL CHECK (feed_key ~ '^[0-9a-f]{64}$'),
  date DATE NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  summary JSONB NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (feed_key, date, revision)
);
CREATE INDEX snapshots_latest_idx ON defillama.snapshots(feed_key, date DESC, revision DESC);
CREATE TABLE defillama.items (
  snapshot_id TEXT NOT NULL REFERENCES defillama.snapshots(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  payload JSONB NOT NULL,
  PRIMARY KEY (snapshot_id, ordinal)
);
CREATE TABLE defillama.contracts (
  snapshot_id TEXT NOT NULL REFERENCES defillama.snapshots(id),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  created_ms BIGINT NOT NULL CHECK (created_ms >= 0),
  payload JSONB NOT NULL,
  PRIMARY KEY (snapshot_id, ordinal)
);
CREATE INDEX contracts_time_page_idx ON defillama.contracts(snapshot_id, created_ms, ordinal);
REVOKE ALL ON ALL TABLES IN SCHEMA defillama FROM PUBLIC;
GRANT SELECT ON ALL TABLES IN SCHEMA defillama TO blast_defillama_reader;
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA defillama TO blast_defillama_publisher;
-- No UPDATE or DELETE: corrections publish a new complete revision.
-- The next publisher resumes from an immutable prior-day cut. Reader credentials
-- have no access to this state. It commits in the same transaction as the snapshot.
CREATE TABLE defillama.native_replay (
  snapshot_id TEXT PRIMARY KEY REFERENCES defillama.snapshots(id),
  payload JSONB NOT NULL
);
REVOKE ALL ON defillama.native_replay FROM PUBLIC;
GRANT SELECT, INSERT ON defillama.native_replay TO blast_defillama_publisher;
