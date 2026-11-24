CREATE TABLE mission_control_invitation_allocations (
  allocation_id UUID PRIMARY KEY,
  profile_id UUID NOT NULL UNIQUE REFERENCES mission_control_profiles(profile_id),
  membership_id UUID NOT NULL UNIQUE REFERENCES mission_control_season_memberships(membership_id),
  policy_version TEXT NOT NULL CHECK (policy_version = 'season-zero-v1'),
  secure_draw SMALLINT NOT NULL CHECK (secure_draw BETWEEN 0 AND 999),
  code_count SMALLINT NOT NULL CHECK (code_count BETWEEN 0 AND 5),
  created_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT mission_control_invitation_allocation_weight_check CHECK (
    (secure_draw BETWEEN 0 AND 399 AND code_count = 0) OR
    (secure_draw BETWEEN 400 AND 799 AND code_count = 1) OR
    (secure_draw BETWEEN 800 AND 949 AND code_count = 2) OR
    (secure_draw BETWEEN 950 AND 989 AND code_count = 3) OR
    (secure_draw BETWEEN 990 AND 998 AND code_count = 4) OR
    (secure_draw = 999 AND code_count = 5)
  )
);

CREATE TABLE mission_control_referrals (
  recruited_profile_id UUID PRIMARY KEY REFERENCES mission_control_profiles(profile_id),
  referrer_profile_id UUID NOT NULL REFERENCES mission_control_profiles(profile_id),
  source_code_id UUID NOT NULL UNIQUE REFERENCES mission_control_invitation_codes(code_id),
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (recruited_profile_id <> referrer_profile_id)
);

CREATE TABLE mission_control_cards (
  card_id UUID PRIMARY KEY,
  profile_id UUID NOT NULL UNIQUE REFERENCES mission_control_profiles(profile_id),
  membership_id UUID NOT NULL UNIQUE REFERENCES mission_control_season_memberships(membership_id),
  record_schema TEXT NOT NULL CHECK (record_schema = 'blast.season-zero-card'),
  record_version INTEGER NOT NULL CHECK (record_version = 1),
  card_record JSONB NOT NULL CHECK (jsonb_typeof(card_record) = 'object'),
  render_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (render_status IN ('pending', 'rendered', 'failed')),
  rendered_at TIMESTAMPTZ,
  render_error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  CHECK (
    (render_status = 'pending' AND rendered_at IS NULL AND render_error IS NULL) OR
    (render_status = 'rendered' AND rendered_at IS NOT NULL AND render_error IS NULL) OR
    (render_status = 'failed' AND rendered_at IS NULL AND render_error IS NOT NULL)
  )
);

CREATE TABLE mission_control_completion_idempotency (
  idempotency_key_hash TEXT PRIMARY KEY CHECK (idempotency_key_hash ~ '^[0-9a-f]{64}$'),
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  attempt_id UUID NOT NULL UNIQUE REFERENCES mission_control_admission_attempts(attempt_id),
  profile_id UUID NOT NULL UNIQUE REFERENCES mission_control_profiles(profile_id),
  completed_at TIMESTAMPTZ NOT NULL
);

ALTER TABLE mission_control_invitation_codes
  ADD COLUMN source_allocation_id UUID REFERENCES mission_control_invitation_allocations(allocation_id),
  ADD COLUMN allocation_ordinal SMALLINT,
  ADD COLUMN consumed_by_profile_id UUID REFERENCES mission_control_profiles(profile_id),
  ADD CONSTRAINT mission_control_invitation_code_allocation_order_check CHECK (
    (source_allocation_id IS NULL AND allocation_ordinal IS NULL) OR
    (source_allocation_id IS NOT NULL AND allocation_ordinal BETWEEN 1 AND 5)
  ),
  ADD CONSTRAINT mission_control_invitation_code_consumption_check CHECK (
    (consumed_at IS NULL AND consumed_by_profile_id IS NULL) OR
    consumed_at IS NOT NULL
  );

CREATE INDEX mission_control_invitation_codes_owner_idx
  ON mission_control_invitation_codes (owner_profile_id);

CREATE UNIQUE INDEX mission_control_invitation_codes_allocation_order_unique
  ON mission_control_invitation_codes (source_allocation_id, allocation_ordinal)
  WHERE source_allocation_id IS NOT NULL;

CREATE FUNCTION mission_control_guard_completion_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' OR OLD IS DISTINCT FROM NEW THEN
    RAISE EXCEPTION 'completion record is immutable'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mission_control_completion_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION mission_control_guard_card_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    OLD.card_id,
    OLD.profile_id,
    OLD.membership_id,
    OLD.record_schema,
    OLD.record_version,
    OLD.card_record,
    OLD.created_at
  ) IS DISTINCT FROM (
    NEW.card_id,
    NEW.profile_id,
    NEW.membership_id,
    NEW.record_schema,
    NEW.record_version,
    NEW.card_record,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'card identity record is immutable'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mission_control_card_identity_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE FUNCTION mission_control_guard_invitation_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    OLD.owner_profile_id,
    OLD.source_allocation_id,
    OLD.allocation_ordinal
  ) IS DISTINCT FROM (
    NEW.owner_profile_id,
    NEW.source_allocation_id,
    NEW.allocation_ordinal
  ) OR OLD.consumed_at IS NOT NULL AND (
    OLD.consumed_at,
    OLD.consumed_by_profile_id
  ) IS DISTINCT FROM (
    NEW.consumed_at,
    NEW.consumed_by_profile_id
  ) THEN
    RAISE EXCEPTION 'invitation ownership and consumption are permanent'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'mission_control_invitation_lifecycle_immutable';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER mission_control_invitation_allocations_immutable
BEFORE UPDATE OR DELETE ON mission_control_invitation_allocations
FOR EACH ROW EXECUTE FUNCTION mission_control_guard_completion_immutable();

CREATE TRIGGER mission_control_referrals_immutable
BEFORE UPDATE OR DELETE ON mission_control_referrals
FOR EACH ROW EXECUTE FUNCTION mission_control_guard_completion_immutable();

CREATE TRIGGER mission_control_completion_idempotency_immutable
BEFORE UPDATE OR DELETE ON mission_control_completion_idempotency
FOR EACH ROW EXECUTE FUNCTION mission_control_guard_completion_immutable();

CREATE TRIGGER mission_control_cards_immutable_identity
BEFORE UPDATE ON mission_control_cards
FOR EACH ROW EXECUTE FUNCTION mission_control_guard_card_identity();

CREATE TRIGGER mission_control_invitation_lifecycle_immutable
BEFORE UPDATE ON mission_control_invitation_codes
FOR EACH ROW EXECUTE FUNCTION mission_control_guard_invitation_lifecycle();
