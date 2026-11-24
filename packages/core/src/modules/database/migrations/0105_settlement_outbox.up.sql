-- A lease fences database writes. An unresolved signed attempt keeps its entity
-- reserved after that lease expires because its bytes may still execute.
CREATE TABLE presale_outbox_actions (
  action_id UUID PRIMARY KEY,
  semantic_key TEXT NOT NULL UNIQUE CHECK (length(semantic_key) BETWEEN 1 AND 1024),
  network TEXT NOT NULL CHECK (network IN ('mainnet','testnet','devnet','localnet')),
  deployment_fingerprint TEXT NOT NULL CHECK (deployment_fingerprint ~ '^[0-9a-f]{64}$'),
  role TEXT NOT NULL CHECK (role IN ('presale-lifecycle','presale-rewards')),
  kind TEXT NOT NULL CHECK (kind IN ('settle','settle_migrate','migrate','partner_payout','collect_fees','publish_reward','claim_reward','settle_reward_gas','close_reward')),
  entity TEXT NOT NULL CHECK (length(entity) BETWEEN 1 AND 1024),
  payload JSONB NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 131072),
  payload_hash TEXT NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
  state TEXT NOT NULL DEFAULT 'ready' CHECK (state IN ('waiting','ready','claimed','signed','submitted_unknown','confirmed','retry_wait','superseded','blocked')),
  due_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  owner UUID,
  generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
  lease_until TIMESTAMPTZ,
  reason TEXT,
  result JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((role = 'presale-lifecycle') = (kind IN ('settle','settle_migrate','migrate','partner_payout'))),
  CHECK ((owner IS NULL) = (lease_until IS NULL)),
  CHECK (state NOT IN ('claimed','signed','submitted_unknown') OR owner IS NOT NULL)
);
CREATE INDEX presale_outbox_due ON presale_outbox_actions(role, due_at, created_at)
  WHERE state IN ('ready','retry_wait');
CREATE UNIQUE INDEX presale_outbox_entity_active ON presale_outbox_actions(network, deployment_fingerprint, entity)
  WHERE state IN ('claimed','signed','submitted_unknown');

CREATE TABLE presale_outbox_attempts (
  digest TEXT PRIMARY KEY CHECK (digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  action_id UUID NOT NULL REFERENCES presale_outbox_actions(action_id),
  generation BIGINT NOT NULL CHECK (generation > 0),
  signer_address TEXT NOT NULL CHECK (signer_address ~ '^0x[0-9a-f]{64}$'),
  transaction_bytes BYTEA NOT NULL CHECK (octet_length(transaction_bytes) BETWEEN 1 AND 131072),
  signature TEXT NOT NULL CHECK (length(signature) BETWEEN 1 AND 4096),
  expires_epoch NUMERIC(20,0) NOT NULL CHECK (expires_epoch >= 0 AND expires_epoch < 18446744073709551616),
  inputs JSONB NOT NULL CHECK (jsonb_typeof(inputs) = 'object' AND octet_length(inputs::text) <= 131072),
  execution_intent JSONB NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(execution_intent)='object' AND octet_length(execution_intent::text)<=131072),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolution TEXT CHECK (resolution IN ('executed','failed','gas-superseded','expired')),
  effects JSONB,
  CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);
CREATE UNIQUE INDEX presale_outbox_attempt_open ON presale_outbox_attempts(action_id) WHERE resolved_at IS NULL;
-- Retain the conservative signer gate until independent owned-input reservations are proven.
CREATE UNIQUE INDEX presale_outbox_signer_open ON presale_outbox_attempts(signer_address) WHERE resolved_at IS NULL;

CREATE FUNCTION presale_outbox_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'presale_outbox_actions' THEN
    IF ROW(NEW.action_id, NEW.semantic_key, NEW.network, NEW.deployment_fingerprint, NEW.role, NEW.kind,
           NEW.entity, NEW.payload, NEW.payload_hash, NEW.created_at)
       IS DISTINCT FROM ROW(OLD.action_id, OLD.semantic_key, OLD.network, OLD.deployment_fingerprint, OLD.role, OLD.kind,
           OLD.entity, OLD.payload, OLD.payload_hash, OLD.created_at) THEN
      RAISE EXCEPTION 'outbox intent is immutable';
    END IF;
  ELSIF ROW(NEW.digest, NEW.action_id, NEW.generation, NEW.signer_address, NEW.transaction_bytes,
            NEW.signature, NEW.expires_epoch, NEW.inputs, NEW.execution_intent, NEW.created_at)
        IS DISTINCT FROM ROW(OLD.digest, OLD.action_id, OLD.generation, OLD.signer_address, OLD.transaction_bytes,
            OLD.signature, OLD.expires_epoch, OLD.inputs, OLD.execution_intent, OLD.created_at)
        OR OLD.resolved_at IS NOT NULL THEN
    RAISE EXCEPTION 'signed attempt is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER presale_outbox_action_immutable BEFORE UPDATE ON presale_outbox_actions
  FOR EACH ROW EXECUTE FUNCTION presale_outbox_immutable();
CREATE TRIGGER presale_outbox_attempt_immutable BEFORE UPDATE ON presale_outbox_attempts
  FOR EACH ROW EXECUTE FUNCTION presale_outbox_immutable();
REVOKE ALL ON presale_outbox_actions, presale_outbox_attempts FROM PUBLIC, blast_web, blast_social, blast_replica;
REVOKE ALL ON FUNCTION presale_outbox_immutable() FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON presale_outbox_actions, presale_outbox_attempts TO blast_watcher;
