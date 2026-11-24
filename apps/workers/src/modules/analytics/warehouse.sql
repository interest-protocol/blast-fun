-- Apply once with a migration login, to a dedicated analytics database only.
BEGIN;
DO $$ BEGIN
  IF to_regnamespace('blast_infra') IS NOT NULL OR to_regnamespace('chain_read_v1') IS NOT NULL OR
    EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND c.relkind IN ('r','p','v','m','f')) THEN
    RAISE EXCEPTION 'analytics requires a separate empty database';
  END IF;
END $$;
CREATE SCHEMA blast_analytics;
REVOKE ALL ON SCHEMA blast_analytics FROM PUBLIC;

CREATE TABLE blast_analytics.state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  scope TEXT NOT NULL CHECK (scope ~ '^[a-f0-9]{64}$'),
  first_checkpoint BIGINT NOT NULL CHECK (first_checkpoint >= 0),
  first_timestamp_ms BIGINT CHECK (first_timestamp_ms >= 0),
  checkpoint BIGINT CHECK (checkpoint >= 0),
  digest TEXT,
  timestamp_ms BIGINT CHECK (timestamp_ms >= 0),
  pending_checkpoint BIGINT CHECK (pending_checkpoint >= 0),
  pending_digest TEXT,
  pending_timestamp_ms BIGINT CHECK (pending_timestamp_ms >= 0),
  pending_fact_id TEXT,
  CHECK ((pending_checkpoint IS NULL) = (pending_fact_id IS NULL)),
  CHECK ((pending_checkpoint IS NULL) = (pending_timestamp_ms IS NULL)),
  CHECK ((pending_checkpoint IS NULL) = (pending_digest IS NULL)),
  CHECK ((checkpoint IS NULL) = (digest IS NULL)),
  CHECK ((checkpoint IS NULL) = (timestamp_ms IS NULL))
);
CREATE TABLE blast_analytics.facts (
  fact_id TEXT PRIMARY KEY,
  checkpoint BIGINT NOT NULL CHECK (checkpoint >= 0),
  timestamp_ms BIGINT NOT NULL CHECK (timestamp_ms >= 0),
  digest TEXT,
  actor_hash TEXT CHECK (actor_hash ~ '^[a-f0-9]{64}$'),
  kind TEXT NOT NULL,
  coin_type TEXT,
  usd_value NUMERIC CHECK (usd_value >= 0 AND usd_value < 'Infinity'),
  quote_type TEXT,
  quote_amount NUMERIC CHECK (quote_amount >= 0 AND quote_amount < 'Infinity' AND quote_amount = trunc(quote_amount))
);
CREATE INDEX facts_time ON blast_analytics.facts(timestamp_ms);
CREATE TABLE blast_analytics.wallets (actor_hash TEXT PRIMARY KEY);
CREATE TABLE blast_analytics.transactions (digest TEXT PRIMARY KEY);
CREATE TABLE blast_analytics.coins (coin_type TEXT PRIMARY KEY);
CREATE TABLE blast_analytics.trade_receipts (
  fact_id TEXT PRIMARY KEY,
  timestamp_ms BIGINT NOT NULL CHECK (timestamp_ms >= 0),
  usd_value NUMERIC
);
CREATE INDEX trade_receipts_time ON blast_analytics.trade_receipts(timestamp_ms);
CREATE TABLE blast_analytics.quote_totals (quote_type TEXT PRIMARY KEY, atoms NUMERIC NOT NULL);
CREATE TABLE blast_analytics.totals (
  kind TEXT PRIMARY KEY,
  count BIGINT NOT NULL,
  priced BIGINT NOT NULL,
  usd_value NUMERIC NOT NULL
);
CREATE TABLE blast_analytics.snapshots (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  generated_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL
);

DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'blast_analytics_writer') THEN
    CREATE ROLE blast_analytics_writer NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'blast_analytics_reader') THEN
    CREATE ROLE blast_analytics_reader NOLOGIN;
  END IF;
END $$;
GRANT USAGE ON SCHEMA blast_analytics TO blast_analytics_writer, blast_analytics_reader;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA blast_analytics TO blast_analytics_writer;
GRANT SELECT ON blast_analytics.snapshots TO blast_analytics_reader;

CREATE TABLE blast_analytics.access_codes (
  code_hash TEXT PRIMARY KEY CHECK (code_hash ~ '^[a-f0-9]{64}$'),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ
);
CREATE FUNCTION blast_analytics.redeem_access_code(hash TEXT) RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE blast_analytics.access_codes SET used_at=statement_timestamp()
  WHERE code_hash=hash AND used_at IS NULL AND expires_at>statement_timestamp();
  RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION blast_analytics.redeem_access_code(TEXT) FROM PUBLIC;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='blast_analytics_access') THEN CREATE ROLE blast_analytics_access NOLOGIN; END IF;
END $$;
GRANT USAGE ON SCHEMA blast_analytics TO blast_analytics_access;
GRANT EXECUTE ON FUNCTION blast_analytics.redeem_access_code(TEXT) TO blast_analytics_access;

COMMIT;
