-- The launchpad buyback operator (LP-22, apps/workers/src/modules/launchpad-buyback).
--
-- One row per graduated launch the operator found through blast-infra's
-- `/v1/pools?view=graduated`, with its migration vault once blast-infra serves
-- it. Each UTC day the worker draws a secret random run time for the vault
-- (`run_at`, from a CSPRNG); once it has passed, it buys back and burns one
-- randomly sized piece of the vault's waiting burn Quote under its own key and
-- BuybackAdmin cap (or skips it for a reason), and while Quote is left draws
-- the next piece's random time later that day. Chain state, not this table, decides how much is waiting
-- and whether a buyback landed. `blast_watcher` alone uses it: the schedule
-- must not be readable by any other role. Nothing here holds a key, a
-- signature, a provider URL or a provider answer.
CREATE TABLE mission_control_launchpad_buybacks (
  network TEXT NOT NULL CHECK (network = 'mainnet'),
  launch_id TEXT NOT NULL CHECK (launch_id ~ '^0x[0-9a-f]{64}$'),
  meme_type TEXT NOT NULL CHECK (char_length(meme_type) BETWEEN 5 AND 1024),
  quote_type TEXT NOT NULL CHECK (char_length(quote_type) BETWEEN 5 AND 1024),
  migration_witness TEXT NOT NULL CHECK (char_length(migration_witness) BETWEEN 5 AND 1024),
  pool_tick_spacing INTEGER NOT NULL CHECK (pool_tick_spacing > 0),
  pool_fee_rate BIGINT NOT NULL CHECK (pool_fee_rate >= 0),
  venue TEXT NOT NULL CHECK (venue IN ('cetus', 'bluefin')),
  pool_id TEXT NOT NULL CHECK (pool_id ~ '^0x[0-9a-f]{64}$'),
  -- The launch's `LpVault`, from `GET /v1/launches/{launch_id}/rewards`; null until served.
  vault_id TEXT CHECK (vault_id ~ '^0x[0-9a-f]{64}$'),
  vault_checked_at TIMESTAMPTZ,
  -- Today's plan: the UTC day, the next piece's drawn run time, and a retry's earliest time.
  plan_day DATE,
  run_at TIMESTAMPTZ,
  next_eligible_at TIMESTAMPTZ,
  state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle', 'waiting', 'submitted', 'done')),
  -- The last visit's outcome or skip reason.
  outcome TEXT CHECK (outcome ~ '^[a-z][a-z0-9-]{0,63}$'),
  latest_digest TEXT CHECK (latest_digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  -- Pieces bought on `plan_day`.
  pieces_today INTEGER NOT NULL DEFAULT 0 CHECK (pieces_today >= 0),
  -- Consecutive `min_meme_out` aborts (simulated or on chain); the alert fires at the configured count.
  min_out_aborts INTEGER NOT NULL DEFAULT 0 CHECK (min_out_aborts >= 0),
  -- What this operator's own buybacks spent and burned (from `BuybackBurned`).
  quote_spent_total NUMERIC(40, 0) NOT NULL DEFAULT 0 CHECK (quote_spent_total >= 0),
  meme_burned_total NUMERIC(40, 0) NOT NULL DEFAULT 0 CHECK (meme_burned_total >= 0),
  last_executed_at TIMESTAMPTZ,
  detected_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (network, launch_id),
  UNIQUE (network, vault_id),
  CHECK (state = 'idle' OR (plan_day IS NOT NULL AND run_at IS NOT NULL AND vault_id IS NOT NULL)),
  CHECK (state <> 'submitted' OR latest_digest IS NOT NULL)
);

-- The planning and due scans (launchpad-buyback/repository.ts).
CREATE INDEX mission_control_launchpad_buybacks_plan_idx
  ON mission_control_launchpad_buybacks (network, plan_day)
  WHERE vault_id IS NOT NULL;
CREATE INDEX mission_control_launchpad_buybacks_vault_lookup_idx
  ON mission_control_launchpad_buybacks (network, vault_checked_at NULLS FIRST)
  WHERE vault_id IS NULL;

REVOKE ALL ON TABLE mission_control_launchpad_buybacks FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE mission_control_launchpad_buybacks TO blast_watcher;

-- The launchpad's keyed-worker release gate (first user: the buyback key). An
-- operator appends each owner-provisioned check for one identity: its digest
-- binds the network, the deployment fingerprint, the signer address and its
-- AdminCap, so a new key or cap starts with an open gate. Append-only; a
-- revocation is a later record with `passed = false`. Only the owner (the
-- migration login) writes; the workers read the latest record of each check.
CREATE TABLE mission_control_launchpad_release_gate_checks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  network TEXT NOT NULL CHECK (network = 'mainnet'),
  identity_digest TEXT NOT NULL CHECK (identity_digest ~ '^[0-9a-f]{64}$'),
  check_name TEXT NOT NULL CHECK (check_name ~ '^[a-z][a-z0-9-]{0,63}$'),
  passed BOOLEAN NOT NULL,
  evidence TEXT NOT NULL CHECK (char_length(evidence) BETWEEN 1 AND 1000),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE FUNCTION launchpad_guard_release_gate_checks()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'launchpad release gate records are append-only'
    USING ERRCODE = 'check_violation',
          CONSTRAINT = 'mission_control_launchpad_release_gate_checks_append_only';
END;
$$;

CREATE TRIGGER mission_control_launchpad_release_gate_checks_append_only
BEFORE UPDATE OR DELETE ON mission_control_launchpad_release_gate_checks
FOR EACH ROW EXECUTE FUNCTION launchpad_guard_release_gate_checks();

CREATE TRIGGER mission_control_launchpad_release_gate_checks_no_truncate
BEFORE TRUNCATE ON mission_control_launchpad_release_gate_checks
FOR EACH STATEMENT EXECUTE FUNCTION launchpad_guard_release_gate_checks();

CREATE INDEX mission_control_launchpad_release_gate_checks_latest_idx
  ON mission_control_launchpad_release_gate_checks (network, identity_digest, check_name, id DESC);

REVOKE ALL ON TABLE mission_control_launchpad_release_gate_checks FROM PUBLIC;
GRANT SELECT ON TABLE mission_control_launchpad_release_gate_checks TO blast_watcher;
