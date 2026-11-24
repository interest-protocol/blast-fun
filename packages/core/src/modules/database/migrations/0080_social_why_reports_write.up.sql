-- Social feed T-022: a why's author retracts it (DELETE
-- /api/social/whys/{why_id}) and any other account reports it (POST
-- /api/social/whys/{why_id}/reports).
--
-- Deleting needs no new object: 0054 grants the web runtime UPDATE on
-- social_whys and never DELETE, 0079's trigger already allows active to
-- deleted and nothing back, and the route reads and writes the one row by its
-- primary key.
--
-- A report, though, is evidence: it is written once, by one account, about
-- one why, and never changed. The web runtime keeps INSERT and loses the
-- UPDATE grant it has never used, so the route that stores a report cannot
-- rewrite one.
REVOKE UPDATE ON TABLE social_why_reports FROM blast_web;

-- And no role rewrites what a report says, the CLI's owner login included.
-- Moderation (T-023) may add its own columns to the table and set them; the
-- four columns below are the report itself.
CREATE FUNCTION social_why_reports_check_update()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.why_id IS DISTINCT FROM OLD.why_id
    OR NEW.reporter_account_id IS DISTINCT FROM OLD.reporter_account_id
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'a report is never edited'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'social_why_reports_never_edited';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER social_why_reports_immutable
BEFORE UPDATE ON social_why_reports
FOR EACH ROW EXECUTE FUNCTION social_why_reports_check_update();
