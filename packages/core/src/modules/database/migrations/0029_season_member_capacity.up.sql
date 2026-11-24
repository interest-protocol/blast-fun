-- Season Zero has 9,999 seats. The counter is stored beside the season so
-- admission can stop before looking up a code, while the deferred membership
-- trigger remains the authoritative race-safe guard. Deferred execution keeps
-- concurrent claims parallel until commit; a failed transaction never takes a
-- seat.

ALTER TABLE mission_control_seasons
  ADD COLUMN member_capacity INTEGER NOT NULL DEFAULT 9999
    CHECK (member_capacity = 9999),
  ADD COLUMN member_count INTEGER NOT NULL DEFAULT 0
    CHECK (member_count >= 0);

UPDATE mission_control_seasons AS season
SET member_count = (
  SELECT COUNT(*)::integer
  FROM mission_control_season_memberships AS membership
  WHERE membership.season_id = season.season_id
);

CREATE FUNCTION mission_control_claim_member_capacity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE mission_control_seasons
  SET member_count = member_count + 1
  WHERE season_id = NEW.season_id
    AND member_count < member_capacity;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'season member capacity reached'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mission_control_season_member_capacity_limit';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER mission_control_season_member_capacity
AFTER INSERT ON mission_control_season_memberships
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION mission_control_claim_member_capacity();
