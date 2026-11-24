-- Reservations are identities, not fabricated user accounts. Only verified X subjects claim them.
CREATE TABLE social_referral_reservations (
  code TEXT PRIMARY KEY CHECK (code ~ '^[a-z0-9_]{3,20}$'),
  x_subject TEXT NOT NULL UNIQUE CHECK (x_subject ~ '^[0-9]{1,20}$'),
  x_handle TEXT NOT NULL,
  display_name TEXT NOT NULL,
  owner_account_id UUID UNIQUE REFERENCES social_accounts(account_id),
  claimed_at TIMESTAMPTZ,
  CHECK ((owner_account_id IS NULL) = (claimed_at IS NULL))
);
INSERT INTO social_referral_reservations(code, x_subject, x_handle, display_name) VALUES
  ('cryptokaleo', '906234475604037637', 'CryptoKaleo', 'Kaleo'),
  ('minhxdynasty', '1310378599984148480', 'MINHxDYNASTY', 'Minh'),
  ('martypartymusic', '22506165', 'martypartymusic', 'Marty Party'),
  ('kylechasse', '1187664208160124930', 'Kylechasse', 'Kyle Chassé'),
  ('irenezhao_', '1366964220768776192', 'Irenezhao_', 'Irene Zhao'),
  ('tradermayne', '2446024556', 'Tradermayne', 'Mayne');

-- Refuse collisions rather than silently redirecting an existing referral link.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM social_account_callsigns c JOIN social_referral_reservations r ON r.code = c.callsign
    JOIN social_accounts a ON a.account_id = c.account_id
    LEFT JOIN mission_control_profiles p ON p.profile_id = a.profile_id
    WHERE COALESCE(a.x_subject,p.x_subject,'') <> r.x_subject)
    OR EXISTS (SELECT 1 FROM mission_control_profiles p JOIN social_referral_reservations r ON r.code=p.callsign
      WHERE p.x_subject IS DISTINCT FROM r.x_subject) THEN
    RAISE EXCEPTION 'reserved referral code already belongs to another account';
  END IF;
END $$;

ALTER TABLE social_accounts ADD COLUMN referrer_reservation_code TEXT REFERENCES social_referral_reservations(code),
  ADD CONSTRAINT social_accounts_one_referral CHECK (referrer_account_id IS NULL OR referrer_reservation_code IS NULL);
CREATE INDEX social_accounts_referrer_reservation_idx ON social_accounts(referrer_reservation_code)
  WHERE referrer_reservation_code IS NOT NULL;

CREATE OR REPLACE FUNCTION social_accounts_check_referrer() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.referrer_account_id IS DISTINCT FROM OLD.referrer_account_id
    OR NEW.referrer_reservation_code IS DISTINCT FROM OLD.referrer_reservation_code THEN
    RAISE EXCEPTION 'an account referral is assigned only at creation'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'social_accounts_referrer_immutable';
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER social_accounts_referrer_immutable ON social_accounts;
CREATE TRIGGER social_accounts_referrer_immutable BEFORE UPDATE OF referrer_account_id, referrer_reservation_code
  ON social_accounts FOR EACH ROW EXECUTE FUNCTION social_accounts_check_referrer();

CREATE FUNCTION social_claim_referral_reservation() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE subject TEXT;
BEGIN
  SELECT COALESCE(NEW.x_subject,p.x_subject) INTO subject FROM (SELECT 1) one
    LEFT JOIN mission_control_profiles p ON p.profile_id = NEW.profile_id;
  PERFORM pg_advisory_xact_lock(hashtext('referral-x:' || subject));
  UPDATE social_referral_reservations SET owner_account_id = NEW.account_id, claimed_at = now()
    WHERE x_subject = subject AND owner_account_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM social_accounts a LEFT JOIN mission_control_profiles p ON p.profile_id=a.profile_id
        WHERE COALESCE(a.x_subject,p.x_subject)=subject AND a.account_id<>NEW.account_id);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION social_claim_referral_reservation() FROM PUBLIC;
CREATE TRIGGER social_accounts_claim_referral AFTER INSERT OR UPDATE OF x_subject, profile_id ON social_accounts
  FOR EACH ROW EXECUTE FUNCTION social_claim_referral_reservation();
-- Claim existing verified identities without changing their account or attribution.
UPDATE social_referral_reservations r SET owner_account_id = a.account_id, claimed_at = now()
FROM social_accounts a LEFT JOIN mission_control_profiles p ON p.profile_id = a.profile_id
WHERE COALESCE(a.x_subject,p.x_subject) = r.x_subject
  AND NOT EXISTS (SELECT 1 FROM social_accounts other LEFT JOIN mission_control_profiles op ON op.profile_id=other.profile_id
    WHERE COALESCE(other.x_subject,op.x_subject)=r.x_subject AND other.account_id<>a.account_id);

CREATE TABLE social_referral_entities (
  entity_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('ticket','launch')),
  ticket_id TEXT,
  meme_type TEXT,
  quote_type TEXT,
  partnered BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE TABLE social_referral_events (
  digest TEXT NOT NULL,
  event_index INTEGER NOT NULL CHECK (event_index >= 0),
  checkpoint BIGINT NOT NULL CHECK (checkpoint >= 0),
  timestamp_ms BIGINT NOT NULL CHECK (timestamp_ms > 0),
  sender TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('curve','graduation','curve_claim','commit','funded','cancelled','presale_fee')),
  entity_id TEXT NOT NULL,
  quote_type TEXT,
  volume_atoms NUMERIC NOT NULL DEFAULT 0 CHECK (volume_atoms >= 0 AND scale(volume_atoms)=0),
  quote_atoms NUMERIC NOT NULL DEFAULT 0 CHECK (quote_atoms >= 0 AND scale(quote_atoms)=0),
  meme_atoms NUMERIC NOT NULL DEFAULT 0 CHECK (meme_atoms >= 0 AND scale(meme_atoms)=0),
  total_atoms NUMERIC NOT NULL DEFAULT 0 CHECK (total_atoms >= 0 AND scale(total_atoms)=0),
  accepted_atoms NUMERIC NOT NULL DEFAULT 0 CHECK (accepted_atoms >= 0 AND scale(accepted_atoms)=0),
  PRIMARY KEY (digest,event_index)
);
CREATE INDEX social_referral_events_sender ON social_referral_events(sender,timestamp_ms) WHERE kind IN ('curve','commit');
CREATE INDEX social_referral_events_entity ON social_referral_events(entity_id,checkpoint,digest,event_index);
REVOKE ALL ON social_referral_reservations, social_referral_entities, social_referral_events FROM PUBLIC;
GRANT SELECT ON social_referral_reservations, social_referral_entities, social_referral_events TO blast_web,blast_watcher,blast_social;
GRANT INSERT ON social_referral_entities,social_referral_events TO blast_watcher;

CREATE FUNCTION social_guard_reserved_referral_code() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.callsign IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext('callsign:' || NEW.callsign));
    IF EXISTS (SELECT 1 FROM social_referral_reservations WHERE code=NEW.callsign AND x_subject IS DISTINCT FROM NEW.x_subject) THEN
      RAISE EXCEPTION 'callsign is reserved'
        USING ERRCODE='check_violation', CONSTRAINT=TG_TABLE_NAME || '_callsign_not_reserved';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER social_accounts_referral_code_guard BEFORE INSERT OR UPDATE OF callsign ON social_accounts
 FOR EACH ROW EXECUTE FUNCTION social_guard_reserved_referral_code();
CREATE TRIGGER mission_control_profiles_referral_code_guard BEFORE INSERT OR UPDATE OF callsign ON mission_control_profiles
 FOR EACH ROW EXECUTE FUNCTION social_guard_reserved_referral_code();
