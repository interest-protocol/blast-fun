-- Presale (T-014): which allowlist manifest serves a presale's proofs.
--
-- One row per presale (`presale_id`, the sale's object ID), naming the
-- manifest (migration 0041) whose `root` and `leaf_count` equal the sale's
-- on-chain allowlisted eligibility. The bind route inserts it for the
-- manifest's owner (`bound_by` = `account:<Privy DID>` or
-- `api_key:<key id>`); the proof route inserts it for an unbound allowlisted
-- sale from a stored manifest with the same root and leaf count
-- (`proof_route`). A sale's eligibility never changes after creation, so the
-- first binding is final: inserts never replace one, and no role updates or
-- deletes a row.
CREATE TABLE presale_allowlist_bindings (
  presale_id TEXT PRIMARY KEY CHECK (presale_id ~ '^0x[0-9a-f]{64}$'),
  allowlist_id UUID NOT NULL REFERENCES presale_allowlists (id),
  bound_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  bound_by TEXT NOT NULL CHECK (
    bound_by ~ '^account:did:privy:[A-Za-z0-9_-]{1,128}$'
    OR bound_by ~ '^api_key:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR bound_by = 'proof_route'
  )
);

CREATE INDEX presale_allowlist_bindings_allowlist ON presale_allowlist_bindings (allowlist_id);

REVOKE ALL ON TABLE presale_allowlist_bindings FROM PUBLIC;
GRANT SELECT, INSERT ON TABLE presale_allowlist_bindings TO blast_web;
