DROP TRIGGER partner_api_key_policy_audit ON partner_api_keys;
DROP TRIGGER partner_api_key_policy_metadata ON partner_api_keys;
DROP FUNCTION partner_audit_key_policy();
DROP TABLE partner_api_key_policy_events;
ALTER TABLE partner_api_keys DROP COLUMN tier, DROP COLUMN requests_per_minute,
  DROP COLUMN requests_per_day, DROP COLUMN policy_updated_at, DROP COLUMN policy_updated_by;
