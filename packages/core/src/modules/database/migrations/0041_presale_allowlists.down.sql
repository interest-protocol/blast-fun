DROP TABLE IF EXISTS presale_allowlist_entries;
DROP TABLE IF EXISTS presale_allowlists;
DROP TRIGGER IF EXISTS presale_api_keys_revocation_final ON presale_api_keys;
DROP TABLE IF EXISTS presale_api_keys;
DROP FUNCTION IF EXISTS presale_guard_api_key_revocation();
