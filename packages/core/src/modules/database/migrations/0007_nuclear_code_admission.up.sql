CREATE TABLE mission_control_invitation_codes (
  code_id UUID PRIMARY KEY,
  season_id TEXT NOT NULL REFERENCES mission_control_seasons(season_id),
  lookup_key_version TEXT NOT NULL CHECK (lookup_key_version ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
  lookup_hmac TEXT NOT NULL UNIQUE CHECK (lookup_hmac ~ '^[0-9a-f]{64}$'),
  encrypted_display TEXT NOT NULL,
  encryption_iv TEXT NOT NULL,
  encryption_tag TEXT NOT NULL,
  encryption_key_version TEXT NOT NULL CHECK (encryption_key_version ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  consumed_at TIMESTAMPTZ,
  sticky_position SMALLINT UNIQUE CHECK (sticky_position BETWEEN 1 AND 3),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX mission_control_invitation_codes_season_idx
  ON mission_control_invitation_codes (season_id);

CREATE TABLE mission_control_admission_attempts (
  attempt_id UUID PRIMARY KEY,
  admission_token_hmac TEXT NOT NULL UNIQUE CHECK (admission_token_hmac ~ '^[0-9a-f]{64}$'),
  candidate_code_id UUID NOT NULL REFERENCES mission_control_invitation_codes(code_id),
  created_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  CHECK (expires_at = created_at + INTERVAL '24 hours')
);

CREATE INDEX mission_control_admission_attempts_expiry_idx
  ON mission_control_admission_attempts (expires_at);

CREATE TABLE mission_control_admission_failures (
  failure_id UUID PRIMARY KEY,
  subject_hmac TEXT NOT NULL CHECK (subject_hmac ~ '^[0-9a-f]{64}$'),
  occurred_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX mission_control_admission_failures_subject_time_idx
  ON mission_control_admission_failures (subject_hmac, occurred_at DESC);

CREATE FUNCTION mission_control_guard_sticky_invitation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.sticky_position IS NOT NULL THEN
      RAISE EXCEPTION 'configured sticky invitation cannot be deleted'
        USING ERRCODE = 'check_violation',
              CONSTRAINT = 'mission_control_sticky_invitation_immutable';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.sticky_position IS NOT NULL AND (
    OLD.code_id,
    OLD.lookup_key_version,
    OLD.lookup_hmac,
    OLD.encrypted_display,
    OLD.encryption_iv,
    OLD.encryption_tag,
    OLD.encryption_key_version,
    OLD.sticky_position
  ) IS DISTINCT FROM (
    NEW.code_id,
    NEW.lookup_key_version,
    NEW.lookup_hmac,
    NEW.encrypted_display,
    NEW.encryption_iv,
    NEW.encryption_tag,
    NEW.encryption_key_version,
    NEW.sticky_position
  ) THEN
    RAISE EXCEPTION 'configured sticky invitation value is immutable'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mission_control_sticky_invitation_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mission_control_sticky_invitation_immutable
BEFORE UPDATE OR DELETE ON mission_control_invitation_codes
FOR EACH ROW EXECUTE FUNCTION mission_control_guard_sticky_invitation();
