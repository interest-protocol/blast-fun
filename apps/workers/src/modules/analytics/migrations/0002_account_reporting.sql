-- Forward only: do not replace the applied bootstrap or account ingress migration.
BEGIN;
DO $$ BEGIN
  IF to_regnamespace('blast_infra') IS NOT NULL OR to_regnamespace('chain_read_v1') IS NOT NULL
    OR to_regclass('blast_analytics.account_collection') IS NULL
    OR to_regclass('blast_analytics.accounts') IS NULL
    OR to_regclass('blast_analytics.account_days') IS NULL
    OR to_regclass('blast_analytics.snapshots') IS NULL
    OR to_regclass('blast_analytics.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'account reporting requires isolated warehouse migration 1';
  END IF;
  IF (SELECT jsonb_agg(jsonb_build_array(version,name) ORDER BY version)
      FROM blast_analytics.schema_migrations)
    IS DISTINCT FROM '[[0,"warehouse-v1"],[1,"account-activity-v1"]]'::jsonb THEN
    RAISE EXCEPTION 'unexpected analytics warehouse migration version';
  END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname IN ('blast_analytics_writer','blast_analytics_reader')
    AND (rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'analytics reporting capabilities must be restricted NOLOGIN roles';
  END IF;
END $$;
CREATE TABLE blast_analytics.snapshots_v3 (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton),
  generated_at TIMESTAMPTZ NOT NULL,
  payload JSONB NOT NULL CHECK(payload->'version'='3'::jsonb)
);
REVOKE ALL ON blast_analytics.snapshots_v3 FROM PUBLIC;
GRANT SELECT ON blast_analytics.account_collection,blast_analytics.accounts,blast_analytics.account_days
  TO blast_analytics_writer;
GRANT SELECT,INSERT,UPDATE ON blast_analytics.snapshots_v3 TO blast_analytics_writer;
GRANT SELECT ON blast_analytics.snapshots_v3 TO blast_analytics_reader;
INSERT INTO blast_analytics.schema_migrations VALUES(2,'account-reporting-v3');
COMMIT;
