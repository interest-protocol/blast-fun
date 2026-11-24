-- Fresh deployment scopes replace the retired workers. Account-backed tables and
-- existing signed custody are deliberately not reset by an application migration.
CREATE TABLE blast_keeper_actions (
 network TEXT NOT NULL CHECK (network='mainnet'),
 fingerprint TEXT NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
 kind TEXT NOT NULL CHECK (kind IN ('presale','vault-fees','vault-partner','presale-partner')),
 object_id TEXT NOT NULL CHECK (object_id ~ '^0x[0-9a-f]{64}$'),
 next_check_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts>=0),
 latest_digest TEXT,
 error_class TEXT,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(network,fingerprint,kind,object_id)
);
CREATE INDEX blast_keeper_actions_due ON blast_keeper_actions(network,fingerprint,kind,next_check_at,object_id);
REVOKE ALL ON blast_keeper_actions FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON blast_keeper_actions TO blast_watcher;

CREATE TABLE vault_reward_periods (
 period_id UUID PRIMARY KEY,
 network TEXT NOT NULL CHECK (network='mainnet'),
 deployment_fingerprint TEXT NOT NULL CHECK (deployment_fingerprint ~ '^[0-9a-f]{64}$'),
 vault_id TEXT NOT NULL CHECK (vault_id ~ '^0x[0-9a-f]{64}$'),
 start_ms NUMERIC(20,0) NOT NULL CHECK (start_ms>=0),
 end_ms NUMERIC(20,0) NOT NULL CHECK (end_ms>start_ms),
 status TEXT NOT NULL DEFAULT 'planning',
 inputs JSONB,
 UNIQUE(network,deployment_fingerprint,vault_id,start_ms)
);
CREATE TABLE vault_reward_plans (
 plan_id UUID PRIMARY KEY,
 period_id UUID NOT NULL UNIQUE REFERENCES vault_reward_periods,
 number NUMERIC(20,0) NOT NULL CHECK(number>=0 AND number<18446744073709551616),
 stage TEXT NOT NULL,
 inputs JSONB NOT NULL,
 manifest JSONB,
 storage_url TEXT,
 storage_hash TEXT CHECK(storage_hash ~ '^[0-9a-f]{64}$'),
 storage_verified_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE vault_reward_holders (
 plan_id UUID NOT NULL REFERENCES vault_reward_plans,
 beneficiary TEXT NOT NULL CHECK(beneficiary ~ '^0x[0-9a-f]{64}$'),
 weight NUMERIC NOT NULL CHECK(weight>0),
 PRIMARY KEY(plan_id,beneficiary)
);
CREATE TABLE vault_reward_allocations (
 plan_id UUID NOT NULL REFERENCES vault_reward_plans,
 leaf_index INTEGER NOT NULL CHECK(leaf_index>=0),
 beneficiary TEXT NOT NULL CHECK(beneficiary ~ '^0x[0-9a-f]{64}$'),
 meme_amount NUMERIC(20,0) NOT NULL CHECK(meme_amount>=0 AND meme_amount<18446744073709551616),
 quote_amount NUMERIC(20,0) NOT NULL CHECK(quote_amount>=0 AND quote_amount<18446744073709551616),
 proof JSONB,
 PRIMARY KEY(plan_id,leaf_index),
 UNIQUE(plan_id,beneficiary)
);
CREATE TABLE vault_reward_hashes (
 plan_id UUID NOT NULL REFERENCES vault_reward_plans,
 level INTEGER NOT NULL CHECK(level>=0),
 position INTEGER NOT NULL CHECK(position>=0),
 hash TEXT NOT NULL CHECK(hash ~ '^[0-9a-f]{64}$'),
 PRIMARY KEY(plan_id,level,position)
);
CREATE TABLE vault_reward_actions (
 action_id UUID PRIMARY KEY,
 plan_id UUID NOT NULL REFERENCES vault_reward_plans,
 semantic_key TEXT NOT NULL UNIQUE,
 kind TEXT NOT NULL,
 state TEXT NOT NULL DEFAULT 'ready',
 payload JSONB NOT NULL,
 digest TEXT,
 transaction_bytes BYTEA,
 signature TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(signature IS NULL OR (digest IS NOT NULL AND transaction_bytes IS NOT NULL))
);
CREATE TABLE vault_reward_gas_effects (
 digest TEXT PRIMARY KEY,
 plan_id UUID NOT NULL REFERENCES vault_reward_plans,
 checkpoint NUMERIC(20,0) NOT NULL CHECK(checkpoint>=0),
 timestamp_ms NUMERIC(20,0) NOT NULL CHECK(timestamp_ms>=0),
 net_sui_atoms NUMERIC NOT NULL,
 sui_usd JSONB,
 quote_usd JSONB
);
CREATE FUNCTION vault_reward_action_custody() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
 IF OLD.transaction_bytes IS NOT NULL AND
   (NEW.transaction_bytes IS DISTINCT FROM OLD.transaction_bytes OR NEW.payload IS DISTINCT FROM OLD.payload
    OR NEW.digest IS DISTINCT FROM OLD.digest OR NEW.plan_id IS DISTINCT FROM OLD.plan_id
    OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.semantic_key IS DISTINCT FROM OLD.semantic_key) THEN
   RAISE EXCEPTION 'prepared reward custody is immutable';
 END IF;
 IF OLD.signature IS NOT NULL AND NEW.signature IS DISTINCT FROM OLD.signature THEN
   RAISE EXCEPTION 'reward signature is immutable';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER vault_reward_action_custody BEFORE UPDATE ON vault_reward_actions
 FOR EACH ROW EXECUTE FUNCTION vault_reward_action_custody();
REVOKE ALL ON vault_reward_periods,vault_reward_plans,vault_reward_holders,vault_reward_allocations,
 vault_reward_hashes,vault_reward_actions,vault_reward_gas_effects FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON vault_reward_periods,vault_reward_plans,vault_reward_holders,
 vault_reward_allocations,vault_reward_hashes TO blast_indexer,blast_watcher;
GRANT SELECT ON vault_reward_actions,vault_reward_gas_effects TO blast_indexer;
GRANT SELECT,INSERT,UPDATE ON vault_reward_actions,vault_reward_gas_effects TO blast_watcher;

-- Human gate evidence survives; identity digests from the retired stack cannot
-- satisfy the fresh SDK deployment/cap/key binding.
ALTER TABLE mission_control_launchpad_release_gate_checks RENAME TO mission_control_vault_release_gate_checks;

CREATE TABLE mission_control_vault_buybacks (
  network TEXT NOT NULL CHECK (network = 'mainnet'),
  origin_id TEXT NOT NULL CHECK (origin_id ~ '^0x[0-9a-f]{64}$'),
  package_witness TEXT NOT NULL,
  meme_type TEXT NOT NULL CHECK (char_length(meme_type) BETWEEN 5 AND 1024),
  quote_type TEXT NOT NULL CHECK (char_length(quote_type) BETWEEN 5 AND 1024),
  venue_type TEXT NOT NULL CHECK (char_length(venue_type) BETWEEN 5 AND 1024),
  pool_tick_spacing INTEGER NOT NULL CHECK (pool_tick_spacing > 0),
  pool_fee_rate BIGINT CHECK (pool_fee_rate >= 0),
  venue TEXT NOT NULL CHECK (venue IN ('cetus', 'bluefin')),
  pool_id TEXT NOT NULL CHECK (pool_id ~ '^0x[0-9a-f]{64}$'),
  vault_id TEXT NOT NULL CHECK (vault_id ~ '^0x[0-9a-f]{64}$'),
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
  PRIMARY KEY (network, vault_id),
  CHECK (state = 'idle' OR (plan_day IS NOT NULL AND run_at IS NOT NULL AND vault_id IS NOT NULL)),
  CHECK (state <> 'submitted' OR latest_digest IS NOT NULL)
);

-- The planning and due scans (vault-buyback/repository.ts).
CREATE INDEX mission_control_vault_buybacks_plan_idx
  ON mission_control_vault_buybacks (network, plan_day)
  WHERE vault_id IS NOT NULL;
REVOKE ALL ON TABLE mission_control_vault_buybacks FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE mission_control_vault_buybacks TO blast_watcher;


ALTER TABLE presale_worker_alerts RENAME TO blast_worker_alerts;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE blast_worker_alerts TO blast_indexer;
CREATE TABLE blast_worker_release_gate_checks (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 network TEXT NOT NULL CHECK(network='mainnet'),
 identity_digest TEXT NOT NULL CHECK(identity_digest ~ '^[0-9a-f]{64}$'),
 check_name TEXT NOT NULL CHECK(check_name ~ '^[a-z][a-z0-9-]{0,63}$'),
 passed BOOLEAN NOT NULL,
 evidence TEXT NOT NULL CHECK(char_length(evidence) BETWEEN 1 AND 1000),
 recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER blast_worker_release_gate_checks_append_only
 BEFORE UPDATE OR DELETE ON blast_worker_release_gate_checks
 FOR EACH ROW EXECUTE FUNCTION launchpad_guard_release_gate_checks();
CREATE TRIGGER blast_worker_release_gate_checks_no_truncate
 BEFORE TRUNCATE ON blast_worker_release_gate_checks
 FOR EACH STATEMENT EXECUTE FUNCTION launchpad_guard_release_gate_checks();
CREATE INDEX blast_worker_release_gate_latest ON blast_worker_release_gate_checks(network,identity_digest,check_name,id DESC);
REVOKE ALL ON blast_worker_release_gate_checks FROM PUBLIC;
GRANT SELECT ON blast_worker_release_gate_checks TO blast_watcher;
