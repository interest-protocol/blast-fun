CREATE TABLE mission_control_member_sessions (
  session_id UUID PRIMARY KEY,
  token_hash TEXT NOT NULL CONSTRAINT mission_control_member_sessions_token_hash_unique UNIQUE
    CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  profile_id UUID NOT NULL REFERENCES mission_control_profiles(profile_id),
  scope TEXT NOT NULL CHECK (scope = 'member'),
  created_at TIMESTAMPTZ NOT NULL,
  last_seen_at TIMESTAMPTZ NOT NULL,
  idle_expires_at TIMESTAMPTZ NOT NULL,
  absolute_expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  CHECK (last_seen_at >= created_at),
  CHECK (idle_expires_at > created_at),
  CHECK (idle_expires_at <= absolute_expires_at),
  CHECK (absolute_expires_at > created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

CREATE INDEX mission_control_member_sessions_profile_id_idx
  ON mission_control_member_sessions (profile_id);

CREATE FUNCTION mission_control_guard_member_session()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    OLD.session_id,
    OLD.token_hash,
    OLD.profile_id,
    OLD.scope,
    OLD.created_at,
    OLD.absolute_expires_at
  ) IS DISTINCT FROM (
    NEW.session_id,
    NEW.token_hash,
    NEW.profile_id,
    NEW.scope,
    NEW.created_at,
    NEW.absolute_expires_at
  ) THEN
    RAISE EXCEPTION 'member session identity and absolute expiry are immutable'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mission_control_member_sessions_immutable';
  END IF;
  IF NEW.last_seen_at < OLD.last_seen_at OR NEW.idle_expires_at < OLD.idle_expires_at THEN
    RAISE EXCEPTION 'member session activity cannot move backward'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mission_control_member_sessions_monotonic_activity';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'member session revocation is permanent'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mission_control_member_sessions_permanent_revocation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mission_control_member_sessions_permanent
BEFORE UPDATE ON mission_control_member_sessions
FOR EACH ROW EXECUTE FUNCTION mission_control_guard_member_session();
