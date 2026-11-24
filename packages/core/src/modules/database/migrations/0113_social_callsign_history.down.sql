CREATE OR REPLACE VIEW social_account_callsigns AS
SELECT a.account_id, p.callsign
FROM social_accounts a
JOIN mission_control_profiles p ON p.profile_id = a.profile_id
UNION ALL
SELECT a.account_id, a.callsign
FROM social_accounts a
WHERE a.profile_id IS NULL;

DROP TRIGGER social_accounts_callsign_history ON social_accounts;
DROP FUNCTION social_remember_callsign();
CREATE OR REPLACE FUNCTION social_reject_taken_callsign()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.callsign IS NULL THEN
    RETURN NEW;
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a callsign is written under READ COMMITTED only'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('callsign:' || NEW.callsign));
  IF EXISTS (SELECT 1 FROM mission_control_reserved_callsigns WHERE callsign = NEW.callsign) THEN
    RAISE EXCEPTION 'callsign is reserved'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_callsign_not_reserved';
  END IF;
  IF TG_TABLE_NAME = 'social_accounts' THEN
    PERFORM 1 FROM mission_control_profiles WHERE callsign = NEW.callsign;
  ELSE
    PERFORM 1 FROM social_accounts WHERE callsign = NEW.callsign;
  END IF;
  IF FOUND THEN
    RAISE EXCEPTION 'callsign is taken'
      USING ERRCODE = 'unique_violation', CONSTRAINT = TG_TABLE_NAME || '_callsign_taken';
  END IF;
  RETURN NEW;
END;
$$;

DROP TABLE social_callsign_aliases;
