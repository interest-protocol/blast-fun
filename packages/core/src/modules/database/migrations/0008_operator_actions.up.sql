CREATE TABLE mission_control_operator_actions (
  action_id UUID PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE
    CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  operator_id TEXT NOT NULL CHECK (operator_id ~ '^[A-Za-z0-9][A-Za-z0-9._@-]{2,99}$'),
  action_type TEXT NOT NULL CHECK (action_type IN (
    'seed-sticky',
    'issue-team-wave',
    'issue-member-drop',
    'configure-cutoff',
    'suppress-member',
    'restore-member',
    'correct-profile'
  )),
  action_version INTEGER NOT NULL CHECK (action_version = 1),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  external_reference TEXT NOT NULL CHECK (length(external_reference) BETWEEN 1 AND 200),
  target JSONB NOT NULL CHECK (jsonb_typeof(target) = 'object'),
  before_state JSONB NOT NULL CHECK (jsonb_typeof(before_state) = 'object'),
  after_state JSONB NOT NULL CHECK (jsonb_typeof(after_state) = 'object'),
  applied_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Generated columns are NULL in a BEFORE trigger. Comparing callsign_path made
-- every otherwise permitted profile correction look like an identity change;
-- callsign itself is the immutable source for that generated path.
CREATE OR REPLACE FUNCTION mission_control_guard_profile_identity()
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
    OLD.disclosure_version,
    OLD.disclosure_accepted_at
  ) IS DISTINCT FROM (
    NEW.privy_did,
    NEW.x_subject,
    NEW.sui_address,
    NEW.provider_wallet_reference,
    NEW.callsign,
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

CREATE TABLE mission_control_operator_action_events (
  action_id UUID NOT NULL REFERENCES mission_control_operator_actions(action_id),
  event_id UUID NOT NULL REFERENCES mission_control_campaign_events(event_id),
  PRIMARY KEY (action_id, event_id),
  UNIQUE (event_id)
);

ALTER TABLE mission_control_invitation_codes
  ADD COLUMN code_kind TEXT DEFAULT 'team',
  ADD COLUMN owner_profile_id UUID REFERENCES mission_control_profiles(profile_id),
  ADD COLUMN batch_id UUID,
  ADD COLUMN operator_action_id UUID REFERENCES mission_control_operator_actions(action_id)
    DEFERRABLE INITIALLY DEFERRED;

UPDATE mission_control_invitation_codes
SET code_kind = CASE WHEN sticky_position IS NULL THEN 'team' ELSE 'sticky' END;

ALTER TABLE mission_control_invitation_codes
  ALTER COLUMN code_kind SET NOT NULL,
  ADD CONSTRAINT mission_control_invitation_codes_kind_check CHECK (
    code_kind IN ('sticky', 'team', 'member')
  ),
  ADD CONSTRAINT mission_control_invitation_codes_owner_check CHECK (
    (code_kind = 'member' AND owner_profile_id IS NOT NULL AND sticky_position IS NULL)
    OR
    (code_kind IN ('sticky', 'team') AND owner_profile_id IS NULL)
  ),
  ADD CONSTRAINT mission_control_invitation_codes_sticky_kind_check CHECK (
    (code_kind = 'sticky') = (sticky_position IS NOT NULL)
  );

CREATE INDEX mission_control_invitation_codes_batch_idx
  ON mission_control_invitation_codes (batch_id)
  WHERE batch_id IS NOT NULL;

ALTER TABLE mission_control_season_memberships
  ADD COLUMN restored_at TIMESTAMPTZ,
  ADD CONSTRAINT mission_control_season_memberships_restoration_check CHECK (
    restored_at IS NULL OR (
      suppressed_at IS NOT NULL AND restored_at >= suppressed_at
    )
  );

CREATE FUNCTION mission_control_guard_membership_restoration()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.restored_at IS NOT NULL AND NEW.restored_at IS DISTINCT FROM OLD.restored_at THEN
    RAISE EXCEPTION 'membership restoration evidence is permanent'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mission_control_season_memberships_permanent_restoration';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mission_control_season_memberships_restoration
BEFORE UPDATE ON mission_control_season_memberships
FOR EACH ROW EXECUTE FUNCTION mission_control_guard_membership_restoration();

CREATE FUNCTION mission_control_guard_operator_evidence()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'operator evidence is immutable'
    USING ERRCODE = 'check_violation',
          CONSTRAINT = 'mission_control_operator_evidence_immutable';
END;
$$;

CREATE TRIGGER mission_control_operator_actions_immutable
BEFORE UPDATE OR DELETE ON mission_control_operator_actions
FOR EACH ROW EXECUTE FUNCTION mission_control_guard_operator_evidence();

CREATE TRIGGER mission_control_operator_action_events_immutable
BEFORE UPDATE OR DELETE ON mission_control_operator_action_events
FOR EACH ROW EXECUTE FUNCTION mission_control_guard_operator_evidence();
