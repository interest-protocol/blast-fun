CREATE TABLE mission_control_seasons (
  season_id TEXT PRIMARY KEY,
  next_crew_number BIGINT NOT NULL DEFAULT 1 CHECK (next_crew_number > 0),
  zero_fleet_ceiling INTEGER NOT NULL DEFAULT 100 CHECK (zero_fleet_ceiling = 100),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE mission_control_reserved_callsigns (
  callsign TEXT PRIMARY KEY CHECK (
    callsign = lower(callsign) AND
    callsign ~ '^[a-z0-9][a-z0-9_]{1,18}[a-z0-9]$'
  ),
  category TEXT NOT NULL CHECK (
    category IN ('app', 'legal', 'callback', 'system', 'staff', 'custom')
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO mission_control_reserved_callsigns (callsign, category) VALUES
  ('admin', 'staff'),
  ('administrator', 'staff'),
  ('api', 'system'),
  ('auth', 'callback'),
  ('blast', 'app'),
  ('blastfun', 'app'),
  ('callback', 'callback'),
  ('crew', 'app'),
  ('legal', 'legal'),
  ('login', 'callback'),
  ('logout', 'callback'),
  ('moderator', 'staff'),
  ('official', 'staff'),
  ('privacy', 'legal'),
  ('root', 'system'),
  ('staff', 'staff'),
  ('support', 'staff'),
  ('system', 'system'),
  ('terms', 'legal'),
  ('verify', 'callback'),
  ('wallet', 'system'),
  ('zero_fleet', 'app');

CREATE TABLE mission_control_callsign_attempt_limits (
  scope_key TEXT PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL,
  attempt_count INTEGER NOT NULL CHECK (attempt_count BETWEEN 1 AND 30),
  updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE mission_control_profiles (
  profile_id UUID PRIMARY KEY,
  privy_did TEXT NOT NULL CONSTRAINT mission_control_profiles_privy_did_unique UNIQUE
    CHECK (privy_did LIKE 'did:privy:%'),
  x_subject TEXT NOT NULL CONSTRAINT mission_control_profiles_x_subject_unique UNIQUE,
  x_handle TEXT,
  x_display_name TEXT,
  x_avatar_reference TEXT,
  sui_address TEXT NOT NULL CONSTRAINT mission_control_profiles_sui_address_unique UNIQUE
    CHECK (sui_address ~ '^0x[0-9a-f]{64}$' AND sui_address <> ('0x' || repeat('0', 64))),
  provider_wallet_reference TEXT NOT NULL,
  callsign TEXT NOT NULL CONSTRAINT mission_control_profiles_callsign_unique UNIQUE
    CHECK (
      callsign = lower(callsign) AND
      callsign ~ '^[a-z0-9][a-z0-9_]{1,18}[a-z0-9]$'
    ),
  callsign_path TEXT GENERATED ALWAYS AS ('/crew/' || callsign) STORED
    CONSTRAINT mission_control_profiles_callsign_path_unique UNIQUE,
  display_name TEXT,
  avatar_reference TEXT,
  disclosure_version TEXT NOT NULL CHECK (length(disclosure_version) BETWEEN 1 AND 100),
  disclosure_accepted_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE mission_control_season_memberships (
  membership_id UUID PRIMARY KEY,
  allocation_id UUID NOT NULL UNIQUE,
  card_id UUID NOT NULL UNIQUE,
  season_id TEXT NOT NULL REFERENCES mission_control_seasons(season_id),
  profile_id UUID NOT NULL REFERENCES mission_control_profiles(profile_id),
  crew_number BIGINT NOT NULL CHECK (crew_number > 0),
  fleet TEXT NOT NULL CHECK (fleet IN ('Recon', 'Foundry', 'Signal')),
  foundry_launch_method TEXT CHECK (
    (fleet = 'Foundry' AND foundry_launch_method IN ('presale', 'bonding_curve', 'other', 'undecided')) OR
    (fleet <> 'Foundry' AND foundry_launch_method IS NULL)
  ),
  owner_title TEXT NOT NULL,
  zero_fleet BOOLEAN NOT NULL,
  gold BOOLEAN NOT NULL,
  suppressed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT mission_control_season_memberships_profile_season_unique
    UNIQUE (profile_id, season_id),
  CONSTRAINT mission_control_season_memberships_crew_unique
    UNIQUE (season_id, crew_number),
  CONSTRAINT mission_control_season_memberships_zero_rules CHECK (
    (
      crew_number <= 100 AND
      zero_fleet AND
      gold AND
      owner_title = 'Zero Fleet Commando'
    ) OR
    (
      crew_number > 100 AND
      NOT zero_fleet AND
      NOT gold AND
      owner_title = fleet || ' Fleet'
    )
  )
);

CREATE FUNCTION mission_control_guard_profile_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    OLD.privy_did,
    OLD.x_subject,
    OLD.sui_address,
    OLD.provider_wallet_reference,
    OLD.callsign,
    OLD.callsign_path,
    OLD.disclosure_version,
    OLD.disclosure_accepted_at
  ) IS DISTINCT FROM (
    NEW.privy_did,
    NEW.x_subject,
    NEW.sui_address,
    NEW.provider_wallet_reference,
    NEW.callsign,
    NEW.callsign_path,
    NEW.disclosure_version,
    NEW.disclosure_accepted_at
  ) THEN
    RAISE EXCEPTION 'profile identity, callsign, and disclosure evidence are immutable'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mission_control_profiles_immutable_identity';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION mission_control_reject_reserved_callsign()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM mission_control_reserved_callsigns
    WHERE callsign = NEW.callsign
  ) THEN
    RAISE EXCEPTION 'callsign is reserved'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mission_control_profiles_callsign_not_reserved';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION mission_control_guard_season_allocator()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.next_crew_number < OLD.next_crew_number OR NEW.zero_fleet_ceiling <> 100 THEN
    RAISE EXCEPTION 'season crew allocation cannot move backward or resize Zero Fleet'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mission_control_seasons_permanent_allocator';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION mission_control_guard_membership()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'season membership cannot be deleted or reassigned'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mission_control_season_memberships_permanent';
  END IF;
  IF (
    OLD.membership_id,
    OLD.allocation_id,
    OLD.card_id,
    OLD.season_id,
    OLD.profile_id,
    OLD.crew_number,
    OLD.fleet,
    OLD.foundry_launch_method,
    OLD.owner_title,
    OLD.zero_fleet,
    OLD.gold,
    OLD.created_at
  ) IS DISTINCT FROM (
    NEW.membership_id,
    NEW.allocation_id,
    NEW.card_id,
    NEW.season_id,
    NEW.profile_id,
    NEW.crew_number,
    NEW.fleet,
    NEW.foundry_launch_method,
    NEW.owner_title,
    NEW.zero_fleet,
    NEW.gold,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'season membership and crew allocation are immutable'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mission_control_season_memberships_immutable';
  END IF;
  IF OLD.suppressed_at IS NOT NULL AND NEW.suppressed_at IS DISTINCT FROM OLD.suppressed_at THEN
    RAISE EXCEPTION 'suppression cannot be cleared or replaced'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mission_control_season_memberships_permanent_suppression';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mission_control_profiles_reserved_callsign
BEFORE INSERT OR UPDATE OF callsign ON mission_control_profiles
FOR EACH ROW EXECUTE FUNCTION mission_control_reject_reserved_callsign();

CREATE TRIGGER mission_control_profiles_immutable_identity
BEFORE UPDATE ON mission_control_profiles
FOR EACH ROW EXECUTE FUNCTION mission_control_guard_profile_identity();

CREATE TRIGGER mission_control_seasons_permanent_allocator
BEFORE UPDATE ON mission_control_seasons
FOR EACH ROW EXECUTE FUNCTION mission_control_guard_season_allocator();

CREATE TRIGGER mission_control_season_memberships_permanent
BEFORE UPDATE OR DELETE ON mission_control_season_memberships
FOR EACH ROW EXECUTE FUNCTION mission_control_guard_membership();
