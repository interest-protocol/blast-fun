-- Social feed T-021: whys are written by their authors (POST
-- /api/social/items/{entry_id}/why). Grants are unchanged: 0054 already lets
-- the web runtime insert and update a why and never delete one.
--
-- The per-item limits (one active why, none after a removal, at most three
-- records in any state) read every record of one item: by this index, not the
-- partial active-only one.
CREATE INDEX social_whys_entry_idx ON social_whys (entry_id);

-- A why is never edited, and it moves only along its life: active to
-- deleted (its author) or removed (the Blast team), and removed back to
-- active (a restore). A deleted why stays deleted. This holds for every role,
-- the CLI's owner login included.
CREATE FUNCTION social_whys_check_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.why_id IS DISTINCT FROM OLD.why_id
    OR NEW.entry_id IS DISTINCT FROM OLD.entry_id
    OR NEW.author_account_id IS DISTINCT FROM OLD.author_account_id
    OR NEW.text IS DISTINCT FROM OLD.text
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a why is never edited'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'social_whys_never_edited';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'active' AND NEW.state IN ('deleted', 'removed'))
    OR (OLD.state = 'removed' AND NEW.state = 'active')
  ) THEN
    RAISE EXCEPTION 'a why does not move from % to %', OLD.state, NEW.state
      USING ERRCODE = 'check_violation', CONSTRAINT = 'social_whys_transition';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER social_whys_transition
BEFORE UPDATE ON social_whys
FOR EACH ROW EXECUTE FUNCTION social_whys_check_transition();
