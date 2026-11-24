-- Partner identity is stable across key rotation, and owns the aggregate quota.
-- Only hashes are stored. Authorization always reads the primary, uncached.
CREATE TABLE partner_api_partners (
  id TEXT PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  origins TEXT[] NOT NULL DEFAULT '{}' CHECK (
    cardinality(origins) <= 20 AND array_position(origins, NULL) IS NULL
  ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by TEXT NOT NULL CHECK (created_by ~ '^operator:[A-Za-z0-9][A-Za-z0-9._@-]{2,99}$'),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT NOT NULL CHECK (updated_by ~ '^operator:[A-Za-z0-9][A-Za-z0-9._@-]{2,99}$')
);

CREATE TABLE partner_api_keys (
  id UUID PRIMARY KEY,
  partner_id TEXT NOT NULL REFERENCES partner_api_partners(id),
  label TEXT NOT NULL CHECK (label ~ '^[A-Za-z0-9][A-Za-z0-9 ._:@-]{0,99}$'),
  key_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(key_hash) = 32),
  issued_by TEXT NOT NULL CHECK (issued_by ~ '^operator:[A-Za-z0-9][A-Za-z0-9._@-]{2,99}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  revoked_by TEXT CHECK (revoked_by ~ '^operator:[A-Za-z0-9][A-Za-z0-9._@-]{2,99}$'),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);
CREATE INDEX partner_api_keys_active_partner ON partner_api_keys (partner_id) WHERE revoked_at IS NULL;
CREATE INDEX partner_api_partners_origins ON partner_api_partners USING gin (origins);

CREATE FUNCTION partner_guard_api_key_revocation()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at, NEW.revoked_by) IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by) THEN
    RAISE EXCEPTION 'a revoked partner key stays revoked'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'partner_api_keys_revocation_final';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER partner_api_keys_revocation_final BEFORE UPDATE ON partner_api_keys
FOR EACH ROW EXECUTE FUNCTION partner_guard_api_key_revocation();

REVOKE ALL ON TABLE partner_api_partners, partner_api_keys FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE partner_api_partners, partner_api_keys TO blast_web;
GRANT UPDATE (origins, updated_at, updated_by) ON partner_api_partners TO blast_web;
GRANT UPDATE (revoked_at, revoked_by) ON partner_api_keys TO blast_web;
