-- Runtime roles for the Neon database shared with blast-infra. blast-infra's
-- 2026-09-30-000000_database_roles creates the same six roles: `blast_indexer`
-- owns the chain tables (and needs CREATE on `public` for each month's
-- partitions), and `blast_web`, `blast_watcher`, `blast_social` and
-- `blast_replica` only read them. This migration gives the web runtime role
-- the web tables. It never touches a chain table or `blast_indexer`'s CREATE.
--
-- Roles are cluster-wide, so either app's migration may create them first,
-- and parallel test databases race to create them.
DO $$
DECLARE
  name TEXT;
BEGIN
  FOREACH name IN ARRAY ARRAY[
    'blast_migration', 'blast_indexer', 'blast_web', 'blast_watcher', 'blast_social',
    'blast_replica'
  ] LOOP
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = name) THEN
      BEGIN
        EXECUTE format('CREATE ROLE %I NOLOGIN', name);
      EXCEPTION WHEN duplicate_object OR unique_violation THEN
        NULL;
      END;
    END IF;
  END LOOP;
END
$$;

GRANT USAGE ON SCHEMA public TO blast_web, blast_watcher, blast_social, blast_replica;

-- The web runtime (`blast_web`) reads and writes every web table; nobody else
-- but the owning migration login may. Schema changes, TRUNCATE and the
-- migration ledger stay with the migration login. A later migration that adds
-- a web table grants it the same way (runtime-roles.integration.test.ts
-- checks every table).
DO $$
DECLARE
  target REGCLASS;
BEGIN
  FOR target IN
    SELECT c.oid::regclass
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relname LIKE 'mission\_control\_%'
      AND c.relname <> 'mission_control_schema_migrations'
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE %s FROM PUBLIC', target);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE %s TO blast_web', target);
  END LOOP;

  FOR target IN
    SELECT c.oid::regclass
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'S'
      AND c.relname LIKE 'mission\_control\_%'
  LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO blast_web', target);
  END LOOP;
END
$$;

REVOKE ALL ON TABLE mission_control_schema_migrations FROM PUBLIC;

-- A season inserted by the runtime creates its crew sequence (0022). Creating
-- and restarting a sequence needs CREATE on `public` and ownership, which the
-- runtime role does not have, so the trigger runs as its owner, the migration
-- login, and grants the runtime the new sequence.
CREATE OR REPLACE FUNCTION mission_control_create_crew_sequence()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  sequence_name TEXT := mission_control_crew_sequence_name(NEW.season_id);
BEGIN
  EXECUTE format(
    'CREATE SEQUENCE IF NOT EXISTS %I AS BIGINT MINVALUE 1 START WITH %s',
    sequence_name,
    NEW.next_crew_number
  );
  EXECUTE format(
    'ALTER SEQUENCE %I RESTART WITH %s',
    sequence_name,
    NEW.next_crew_number
  );
  EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %I TO blast_web', sequence_name);
  RETURN NEW;
END;
$$;
