-- Renamed social accounts retain their old profile links and callsign ownership.
CREATE TABLE social_callsign_aliases (
  callsign TEXT PRIMARY KEY CHECK (callsign ~ '^[a-z0-9][a-z0-9_]{1,18}[a-z0-9]$'),
  account_id UUID NOT NULL REFERENCES social_accounts(account_id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
REVOKE ALL ON TABLE social_callsign_aliases FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE social_callsign_aliases TO blast_web;
GRANT SELECT ON TABLE social_callsign_aliases TO blast_replica;

CREATE OR REPLACE FUNCTION social_reject_taken_callsign()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  candidate TEXT;
BEGIN
  IF NEW.callsign IS NULL THEN
    RETURN NEW;
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE EXCEPTION 'a callsign is written under READ COMMITTED only'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  -- Lock old and new names in the same order so a rename cannot release its old name to a racer.
  IF TG_TABLE_NAME = 'social_accounts' AND TG_OP = 'UPDATE' THEN
    FOR candidate IN SELECT DISTINCT name FROM unnest(ARRAY[OLD.callsign, NEW.callsign]) name ORDER BY name LOOP
      PERFORM pg_advisory_xact_lock(hashtext('callsign:' || candidate));
    END LOOP;
  ELSE
    PERFORM pg_advisory_xact_lock(hashtext('callsign:' || NEW.callsign));
  END IF;
  IF EXISTS (SELECT 1 FROM mission_control_reserved_callsigns WHERE callsign = NEW.callsign) THEN
    RAISE EXCEPTION 'callsign is reserved'
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_TABLE_NAME || '_callsign_not_reserved';
  END IF;
  IF TG_TABLE_NAME = 'social_accounts' THEN
    PERFORM 1 FROM mission_control_profiles WHERE callsign = NEW.callsign
    UNION ALL
    SELECT 1 FROM social_callsign_aliases WHERE callsign = NEW.callsign AND account_id <> NEW.account_id;
  ELSE
    PERFORM 1 FROM social_accounts WHERE callsign = NEW.callsign
    UNION ALL
    SELECT 1 FROM social_callsign_aliases WHERE callsign = NEW.callsign;
  END IF;
  IF FOUND THEN
    RAISE EXCEPTION 'callsign is taken'
      USING ERRCODE = 'unique_violation', CONSTRAINT = TG_TABLE_NAME || '_callsign_taken';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION social_remember_callsign()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.callsign IS DISTINCT FROM NEW.callsign AND OLD.callsign IS NOT NULL THEN
    INSERT INTO social_callsign_aliases (callsign, account_id) VALUES (OLD.callsign, NEW.account_id)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER social_accounts_callsign_history
AFTER UPDATE OF callsign ON social_accounts
FOR EACH ROW EXECUTE FUNCTION social_remember_callsign();

CREATE OR REPLACE VIEW social_account_callsigns AS
SELECT a.account_id, p.callsign
FROM social_accounts a JOIN mission_control_profiles p ON p.profile_id = a.profile_id
UNION ALL
SELECT account_id, callsign FROM social_accounts WHERE profile_id IS NULL
UNION ALL
SELECT h.account_id, h.callsign FROM social_callsign_aliases h
JOIN social_accounts a ON a.account_id = h.account_id WHERE h.callsign <> a.callsign;
