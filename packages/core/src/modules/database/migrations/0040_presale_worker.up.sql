-- Presale (T-009): the presale worker processes' own tables, beside the
-- operational worker runtime's (0035), which they share for leases, job state
-- and the submission ledger. Nothing here holds a key, a signature, a webhook
-- URL or a provider answer.

-- The mainnet release gate. An operator records each owner-provisioned check
-- (`npm run presale:release-gate`) as the migration login, the table owner;
-- the workers (`blast_watcher`) only read it. Rows are appended, never
-- changed (a trigger refuses UPDATE, DELETE and TRUNCATE, even for the
-- owner, as 0008 does for operator evidence): the latest row of a check, for
-- the identity in force, decides it, and a revocation is a row with
-- `passed = false`. A check recorded for
-- another identity never counts. On mainnet no worker signs until every check
-- is passed.
CREATE TABLE presale_release_gate_checks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  network TEXT NOT NULL CHECK (network IN ('mainnet', 'localnet')),
  -- sha256 of the canonical presale identity (`PRESALE_DEPLOYMENT_MANIFEST`).
  identity_digest TEXT NOT NULL CHECK (identity_digest ~ '^[0-9a-f]{64}$'),
  check_name TEXT NOT NULL CHECK (check_name ~ '^[a-z][a-z0-9-]{0,63}$'),
  passed BOOLEAN NOT NULL,
  -- What the operator saw: a digest, an address, a ticket link. Redacted before it is written.
  evidence TEXT NOT NULL CHECK (char_length(evidence) BETWEEN 1 AND 1000),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION presale_guard_release_gate_checks()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'presale release gate records are append-only'
    USING ERRCODE = 'check_violation',
          CONSTRAINT = 'presale_release_gate_checks_append_only';
END;
$$;

CREATE TRIGGER presale_release_gate_checks_append_only
BEFORE UPDATE OR DELETE ON presale_release_gate_checks
FOR EACH ROW EXECUTE FUNCTION presale_guard_release_gate_checks();

CREATE TRIGGER presale_release_gate_checks_no_truncate
BEFORE TRUNCATE ON presale_release_gate_checks
FOR EACH STATEMENT EXECUTE FUNCTION presale_guard_release_gate_checks();

-- The workers' per-pass read: the latest row of each check for one identity.
CREATE INDEX presale_release_gate_checks_latest_idx
  ON presale_release_gate_checks (network, identity_digest, check_name, id DESC);

-- One row per alert condition that holds now (`job_stalled:<job>`,
-- `relayer_low:<role>`, and the keys later jobs add). `condition_since` is
-- when the condition was first seen holding, `last_sent_at` when the alert
-- channel last carried it; a key repeats at most once an hour while it holds.
-- A condition that clears deletes its row, so the next one starts afresh.
CREATE TABLE presale_worker_alerts (
  alert_key TEXT PRIMARY KEY CHECK (alert_key ~ '^[a-z][a-z0-9_]{0,63}(:[A-Za-z0-9._-]{1,128})?$'),
  condition_since TIMESTAMPTZ NOT NULL,
  last_sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL
);

REVOKE ALL ON TABLE presale_release_gate_checks, presale_worker_alerts FROM PUBLIC;
GRANT SELECT ON TABLE presale_release_gate_checks TO blast_watcher;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE presale_worker_alerts TO blast_watcher;
