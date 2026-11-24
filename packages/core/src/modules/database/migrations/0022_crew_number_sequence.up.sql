-- Crew numbers come from one PostgreSQL sequence per season instead of an
-- UPDATE of the season row. nextval never waits for another transaction, so
-- concurrent claims no longer queue behind mission_control_seasons. It is also
-- never rolled back: a claim that aborts after drawing leaves a gap.
--
-- Rollout: deployments from before this migration still run
-- `UPDATE ... SET next_crew_number = next_crew_number + 1 RETURNING
-- next_crew_number - 1`. The legacy trigger below makes that statement draw
-- from the same sequence, so old and new code can run side by side without
-- handing out the same number. next_crew_number is no longer the allocator.

-- Wait for in-flight legacy claims (their counter UPDATE holds ROW EXCLUSIVE)
-- and block new ones until the triggers exist, so the start values below see
-- every number already issued.
LOCK TABLE mission_control_seasons IN SHARE ROW EXCLUSIVE MODE;

CREATE FUNCTION mission_control_crew_sequence_name(p_season_id TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
AS $$ SELECT 'mission_control_crew_seq_' || md5(p_season_id) $$;

CREATE FUNCTION mission_control_draw_crew_number(p_season_id TEXT)
RETURNS BIGINT
LANGUAGE sql
VOLATILE
STRICT
AS $$ SELECT nextval(mission_control_crew_sequence_name(p_season_id)::regclass) $$;

-- Existing seasons continue after the higher of their counter and the largest
-- number already assigned.
DO $$
DECLARE
  season RECORD;
BEGIN
  FOR season IN
    SELECT s.season_id,
           GREATEST(
             s.next_crew_number,
             COALESCE(MAX(m.crew_number) + 1, 1)
           ) AS next_number
    FROM mission_control_seasons AS s
    LEFT JOIN mission_control_season_memberships AS m
      ON m.season_id = s.season_id
    GROUP BY s.season_id, s.next_crew_number
  LOOP
    EXECUTE format(
      'CREATE SEQUENCE %I AS BIGINT MINVALUE 1 START WITH %s',
      mission_control_crew_sequence_name(season.season_id),
      season.next_number
    );
  END LOOP;
END;
$$;

-- A new season, or one re-inserted by `npm run db:reset` after TRUNCATE, starts
-- its sequence at the row's next_crew_number.
CREATE FUNCTION mission_control_create_crew_sequence()
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

CREATE TRIGGER mission_control_seasons_crew_sequence
AFTER INSERT ON mission_control_seasons
FOR EACH ROW EXECUTE FUNCTION mission_control_create_crew_sequence();

-- BEFORE UPDATE triggers fire in name order, so this runs before
-- mission_control_seasons_permanent_allocator, which still rejects any move
-- backward.
CREATE FUNCTION mission_control_legacy_crew_draw()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.next_crew_number = OLD.next_crew_number + 1 THEN
    NEW.next_crew_number := mission_control_draw_crew_number(NEW.season_id) + 1;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mission_control_seasons_legacy_crew_draw
BEFORE UPDATE OF next_crew_number ON mission_control_seasons
FOR EACH ROW EXECUTE FUNCTION mission_control_legacy_crew_draw();
