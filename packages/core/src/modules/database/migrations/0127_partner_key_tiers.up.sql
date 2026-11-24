-- Existing keys retain the standard allowance. Internal access is an explicit
-- operator choice; no existing key is silently promoted.
ALTER TABLE partner_api_keys
  ADD COLUMN tier TEXT NOT NULL DEFAULT 'standard',
  ADD COLUMN requests_per_minute INTEGER DEFAULT 300,
  ADD COLUMN requests_per_day INTEGER DEFAULT 50000,
  ADD COLUMN policy_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN policy_updated_by TEXT;
UPDATE partner_api_keys SET policy_updated_by = issued_by;
ALTER TABLE partner_api_keys
  ALTER COLUMN policy_updated_by SET NOT NULL,
  ADD CONSTRAINT partner_api_key_policy_actor CHECK (
    policy_updated_by ~ '^operator:[A-Za-z0-9][A-Za-z0-9._@-]{2,99}$'
  ),
  ADD CONSTRAINT partner_api_key_policy CHECK (
    CASE tier
      WHEN 'internal' THEN requests_per_minute IS NULL AND requests_per_day IS NULL
      WHEN 'standard' THEN requests_per_minute IS NOT NULL AND requests_per_day IS NOT NULL
        AND requests_per_minute = 300 AND requests_per_day = 50000
      WHEN 'custom' THEN requests_per_minute IS NOT NULL AND requests_per_day IS NOT NULL
        AND requests_per_minute > 0 AND requests_per_day >= requests_per_minute
      ELSE false
    END
  );

CREATE TABLE partner_api_key_policy_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key_id UUID NOT NULL REFERENCES partner_api_keys(id),
  tier TEXT NOT NULL,
  requests_per_minute INTEGER,
  requests_per_day INTEGER,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  changed_by TEXT NOT NULL
);
CREATE INDEX partner_api_key_policy_events_key ON partner_api_key_policy_events (key_id, id);
INSERT INTO partner_api_key_policy_events
  (key_id, tier, requests_per_minute, requests_per_day, changed_by)
SELECT id, tier, requests_per_minute, requests_per_day, policy_updated_by FROM partner_api_keys;

-- The runtime may append through this trigger, but cannot alter audit history.
CREATE FUNCTION partner_audit_key_policy()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.policy_updated_by := NEW.issued_by;
  ELSIF (NEW.tier, NEW.requests_per_minute, NEW.requests_per_day)
      IS NOT DISTINCT FROM (OLD.tier, OLD.requests_per_minute, OLD.requests_per_day) THEN
    NEW.policy_updated_by := OLD.policy_updated_by;
    NEW.policy_updated_at := OLD.policy_updated_at;
    RETURN NEW;
  END IF;
  IF TG_WHEN = 'BEFORE' THEN
    NEW.policy_updated_at := now();
    RETURN NEW;
  END IF;
  INSERT INTO public.partner_api_key_policy_events
    (key_id, tier, requests_per_minute, requests_per_day, changed_by)
  VALUES (NEW.id, NEW.tier, NEW.requests_per_minute, NEW.requests_per_day, NEW.policy_updated_by);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION partner_audit_key_policy() FROM PUBLIC;
CREATE TRIGGER partner_api_key_policy_metadata BEFORE INSERT OR UPDATE OF
  tier, requests_per_minute, requests_per_day, policy_updated_by ON partner_api_keys
FOR EACH ROW EXECUTE FUNCTION partner_audit_key_policy();
-- An AFTER trigger sees the inserted key for the audit FK.
CREATE TRIGGER partner_api_key_policy_audit AFTER INSERT OR UPDATE OF
  tier, requests_per_minute, requests_per_day, policy_updated_by ON partner_api_keys
FOR EACH ROW EXECUTE FUNCTION partner_audit_key_policy();

REVOKE ALL ON TABLE partner_api_key_policy_events FROM PUBLIC;
GRANT SELECT ON TABLE partner_api_key_policy_events TO blast_web;
GRANT UPDATE (tier, requests_per_minute, requests_per_day, policy_updated_by)
  ON partner_api_keys TO blast_web;
