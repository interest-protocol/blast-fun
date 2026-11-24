-- Forward upgrade for warehouse.sql v1 only. Apply once with its migration owner.
BEGIN;
DO $$ BEGIN
  IF to_regnamespace('blast_infra') IS NOT NULL OR to_regnamespace('chain_read_v1') IS NOT NULL
    OR to_regclass('blast_analytics.state') IS NULL OR to_regclass('blast_analytics.facts') IS NULL
    OR to_regclass('blast_analytics.snapshots') IS NULL OR to_regclass('blast_analytics.access_codes') IS NULL
    OR to_regprocedure('blast_analytics.redeem_access_code(text)') IS NULL
    OR EXISTS (SELECT FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname !~ '^pg_' AND n.nspname NOT IN ('information_schema','blast_analytics')
        AND c.relkind IN ('r','p','v','m','f')) THEN
    RAISE EXCEPTION 'account activity requires the isolated analytics warehouse v1';
  END IF;
  IF to_regclass('blast_analytics.schema_migrations') IS NOT NULL THEN
    RAISE EXCEPTION 'unexpected analytics warehouse migration version';
  END IF;
END $$;
CREATE TABLE blast_analytics.schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL);
INSERT INTO blast_analytics.schema_migrations VALUES(0,'warehouse-v1');
CREATE TABLE blast_analytics.account_collection (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  scope TEXT CHECK(scope ~ '^[a-f0-9]{64}$'),
  started_at TIMESTAMPTZ,
  CHECK((scope IS NULL)=(started_at IS NULL))
);
INSERT INTO blast_analytics.account_collection(singleton) VALUES(TRUE);
CREATE TABLE blast_analytics.accounts (
  account_hash TEXT PRIMARY KEY CHECK(account_hash ~ '^[a-f0-9]{64}$'),
  first_seen TIMESTAMPTZ NOT NULL,
  last_seen TIMESTAMPTZ NOT NULL CHECK(last_seen>=first_seen)
);
CREATE INDEX accounts_last_seen ON blast_analytics.accounts(last_seen);
CREATE TABLE blast_analytics.account_days (
  account_hash TEXT NOT NULL REFERENCES blast_analytics.accounts(account_hash),
  day DATE NOT NULL,
  PRIMARY KEY(account_hash,day)
);
CREATE INDEX account_days_day ON blast_analytics.account_days(day,account_hash);
DO $$
DECLARE role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['blast_analytics_ingress','blast_analytics_activity_owner'] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('CREATE ROLE %I NOLOGIN',role_name);
    END IF;
    IF EXISTS (SELECT FROM pg_roles WHERE rolname=role_name AND
      (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls))
      OR EXISTS (SELECT FROM pg_auth_members WHERE member=role_name::regrole) THEN
      RAISE EXCEPTION 'account activity roles must be restricted NOLOGIN capabilities';
    END IF;
  END LOOP;
END $$;
REVOKE ALL ON blast_analytics.schema_migrations,blast_analytics.account_collection,
  blast_analytics.accounts,blast_analytics.account_days FROM PUBLIC;
GRANT USAGE ON SCHEMA blast_analytics TO blast_analytics_ingress,blast_analytics_activity_owner;
GRANT SELECT,UPDATE ON blast_analytics.account_collection TO blast_analytics_activity_owner;
GRANT SELECT,INSERT,UPDATE ON blast_analytics.accounts TO blast_analytics_activity_owner;
GRANT INSERT ON blast_analytics.account_days TO blast_analytics_activity_owner;
CREATE FUNCTION blast_analytics.record_activity(hash TEXT,expected_scope TEXT)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pg_temp AS $$
DECLARE observed TIMESTAMPTZ := clock_timestamp();
BEGIN
  IF hash IS NULL OR hash !~ '^[a-f0-9]{64}$' OR expected_scope IS NULL OR expected_scope !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid account activity coordinates' USING ERRCODE='22023';
  END IF;
  UPDATE blast_analytics.account_collection SET scope=coalesce(scope,expected_scope),started_at=coalesce(started_at,observed)
    WHERE singleton AND (scope IS NULL OR scope=expected_scope);
  IF NOT FOUND THEN RAISE EXCEPTION 'account activity scope changed; reconciliation required'; END IF;
  INSERT INTO blast_analytics.accounts VALUES(hash,observed,observed)
    ON CONFLICT(account_hash) DO UPDATE SET last_seen=greatest(blast_analytics.accounts.last_seen,excluded.last_seen);
  INSERT INTO blast_analytics.account_days VALUES(hash,(observed AT TIME ZONE 'UTC')::date) ON CONFLICT DO NOTHING;
  RETURN observed;
END $$;
REVOKE ALL ON FUNCTION blast_analytics.record_activity(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION blast_analytics.record_activity(TEXT,TEXT) TO blast_analytics_ingress;
-- The migration operator may maintain the definer but never inherits its rights.
GRANT blast_analytics_activity_owner TO CURRENT_USER WITH INHERIT FALSE, SET TRUE;
GRANT CREATE ON SCHEMA blast_analytics TO blast_analytics_activity_owner;
ALTER FUNCTION blast_analytics.record_activity(TEXT,TEXT) OWNER TO blast_analytics_activity_owner;
REVOKE CREATE ON SCHEMA blast_analytics FROM blast_analytics_activity_owner;
INSERT INTO blast_analytics.schema_migrations VALUES(1,'account-activity-v1');
COMMIT;
