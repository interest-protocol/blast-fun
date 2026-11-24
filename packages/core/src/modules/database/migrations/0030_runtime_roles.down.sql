-- The roles and their USAGE on `public` stay: they are cluster-wide and
-- blast-infra's migrations use them too.
CREATE OR REPLACE FUNCTION mission_control_create_crew_sequence()
RETURNS TRIGGER
LANGUAGE plpgsql
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
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  target REGCLASS;
BEGIN
  FOR target IN
    SELECT c.oid::regclass
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p', 'S')
      AND c.relname LIKE 'mission\_control\_%'
  LOOP
    EXECUTE format('REVOKE ALL ON %s FROM blast_web', target);
  END LOOP;
END
$$;
