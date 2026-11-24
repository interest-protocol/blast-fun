-- Presale (T-013): allowlist manifests and agent API keys.
--
-- `presale_api_keys`: an agent's API key, `blast_ak_<43 base64url>`, kept only
-- as the SHA-256 of the full key; the raw key is printed once by
-- `scripts/presale-api-keys.ts` and never stored. `issued_by` and
-- `revoked_by` name the authenticated operator (`operator:<operator ID>`, as
-- launchpad moderation records its moderator). A key is active until
-- revoked; revocation only sets `revoked_at` and `revoked_by`, so a key's row,
-- label and issuer stay.
--
-- `presale_allowlists`: one uploaded allowlist, owned by a Privy account (its
-- DID) or an API key (its id). `root` (64 lowercase hex, no 0x) and
-- `leaf_count` are what a creator passes at sale creation; the bind and proof
-- routes find a manifest by them. `total_cap` is the sum of the caps in Quote
-- atoms (up to 65,536 u64 values, so numeric). `warnings` is the create
-- response's warning list.
--
-- `presale_allowlist_entries`: every entry in row order (index = data row - 1)
-- with its stored Merkle proof, leaf to root, as built by the SDK's
-- `buildAllowlist`. A manifest and its entries are inserted in one
-- transaction and never changed.
--
-- The web runtime reads and inserts; it may only revoke a key (its
-- `revoked_at` and `revoked_by`). No role updates or deletes anything else.
CREATE TABLE presale_api_keys (
  id UUID PRIMARY KEY,
  label TEXT NOT NULL CHECK (label ~ '^[A-Za-z0-9][A-Za-z0-9 ._:@-]{0,99}$'),
  key_hash BYTEA NOT NULL UNIQUE CHECK (octet_length(key_hash) = 32),
  issued_by TEXT NOT NULL CHECK (issued_by ~ '^operator:[A-Za-z0-9][A-Za-z0-9._@-]{2,99}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  revoked_by TEXT CHECK (revoked_by ~ '^operator:[A-Za-z0-9][A-Za-z0-9._@-]{2,99}$'),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

CREATE TABLE presale_allowlists (
  id UUID PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('account', 'api_key')),
  owner_id TEXT NOT NULL,
  quote TEXT NOT NULL CHECK (quote ~ '^0x[0-9a-f]{64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*(<.+>)?$'),
  root TEXT NOT NULL CHECK (root ~ '^[0-9a-f]{64}$'),
  leaf_count INTEGER NOT NULL CHECK (leaf_count BETWEEN 1 AND 65536),
  entry_count INTEGER NOT NULL CHECK (entry_count = leaf_count),
  total_cap NUMERIC(40, 0) NOT NULL CHECK (total_cap >= leaf_count),
  warnings JSONB NOT NULL CHECK (jsonb_typeof(warnings) = 'array'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (owner_kind = 'account' AND owner_id ~ '^did:privy:[A-Za-z0-9_-]{1,128}$')
    OR (owner_kind = 'api_key' AND owner_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  )
);

CREATE INDEX presale_allowlists_root_leaf_count ON presale_allowlists (root, leaf_count);

CREATE TABLE presale_allowlist_entries (
  allowlist_id UUID NOT NULL REFERENCES presale_allowlists (id),
  index INTEGER NOT NULL CHECK (index BETWEEN 0 AND 65535),
  wallet TEXT NOT NULL CHECK (wallet ~ '^0x[0-9a-f]{64}$'),
  wallet_cap NUMERIC(20, 0) NOT NULL CHECK (wallet_cap BETWEEN 1 AND 18446744073709551615),
  proof BYTEA[] NOT NULL CHECK (cardinality(proof) <= 16),
  PRIMARY KEY (allowlist_id, index),
  UNIQUE (allowlist_id, wallet)
);

-- Revocation is final at the database level, not only in the repository's
-- coalesce: once `revoked_at` is set, neither it nor `revoked_by` may change
-- (no un-revoke, no rewritten revoker). A repeat revoke that writes the same
-- values back still passes (as migration 0008 guards membership restoration).
CREATE FUNCTION presale_guard_api_key_revocation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL
     AND (NEW.revoked_at, NEW.revoked_by) IS DISTINCT FROM (OLD.revoked_at, OLD.revoked_by) THEN
    RAISE EXCEPTION 'a revoked API key stays revoked'
      USING ERRCODE = 'check_violation',
            CONSTRAINT = 'presale_api_keys_revocation_final';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER presale_api_keys_revocation_final
BEFORE UPDATE ON presale_api_keys
FOR EACH ROW EXECUTE FUNCTION presale_guard_api_key_revocation();

REVOKE ALL ON TABLE presale_api_keys, presale_allowlists, presale_allowlist_entries FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE presale_api_keys, presale_allowlists, presale_allowlist_entries TO blast_web;
GRANT UPDATE (revoked_at, revoked_by) ON TABLE presale_api_keys TO blast_web;
