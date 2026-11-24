-- Applied by hand, so it frames its own transaction: every step must hold the
-- lock below until COMMIT. Run statement by statement, the triggers would be
-- gone while claims still draw, and a claim could draw after the sequence is
-- read below, leaving the restored counter to re-issue its number.
BEGIN;

-- DROP TRIGGER takes ACCESS EXCLUSIVE on mission_control_seasons. Every claim,
-- pre-0022 or current, reads its season before it draws a crew number, so this
-- waits for claims in flight (their draws are in the sequence read below) and
-- holds back new ones until COMMIT. No weaker lock first: a claim holding its
-- season read and waiting to UPDATE the legacy counter would deadlock with
-- the upgrade.
DROP TRIGGER mission_control_seasons_legacy_crew_draw ON mission_control_seasons;
DROP TRIGGER mission_control_seasons_crew_sequence ON mission_control_seasons;

-- Hand allocation back to the season row, continuing after the highest number
-- the sequence issued, so the pre-0022 code never reuses a crew number.
DO $$
DECLARE
  season RECORD;
  last_number BIGINT;
  was_called BOOLEAN;
BEGIN
  FOR season IN SELECT season_id FROM mission_control_seasons LOOP
    EXECUTE format(
      'SELECT last_value, is_called FROM %I',
      mission_control_crew_sequence_name(season.season_id)
    ) INTO last_number, was_called;
    UPDATE mission_control_seasons
    SET next_crew_number = GREATEST(
      next_crew_number,
      CASE WHEN was_called THEN last_number + 1 ELSE last_number END
    )
    WHERE season_id = season.season_id;
    EXECUTE format(
      'DROP SEQUENCE %I',
      mission_control_crew_sequence_name(season.season_id)
    );
  END LOOP;
END;
$$;

DROP FUNCTION mission_control_legacy_crew_draw();
DROP FUNCTION mission_control_create_crew_sequence();
DROP FUNCTION mission_control_draw_crew_number(TEXT);
DROP FUNCTION mission_control_crew_sequence_name(TEXT);

COMMIT;
