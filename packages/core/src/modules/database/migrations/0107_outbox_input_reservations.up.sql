-- Prepared bytes are a signing barrier even before a signature is returned.
-- Their inputs cannot be released merely because the worker lease elapsed.
CREATE TABLE presale_outbox_prepared_inputs (
  digest TEXT PRIMARY KEY CHECK (digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  action_id UUID NOT NULL REFERENCES presale_outbox_actions(action_id),
  owner UUID NOT NULL,
  generation BIGINT NOT NULL CHECK (generation>0),
  network TEXT NOT NULL CHECK(network IN ('mainnet','testnet','devnet','localnet')),
  deployment_fingerprint TEXT NOT NULL CHECK(deployment_fingerprint ~ '^[0-9a-f]{64}$'),
  signer_address TEXT NOT NULL CHECK(signer_address ~ '^0x[0-9a-f]{64}$'),
  transaction_bytes BYTEA NOT NULL CHECK(octet_length(transaction_bytes) BETWEEN 1 AND 131072),
  bytes_hash TEXT NOT NULL CHECK(bytes_hash ~ '^[0-9a-f]{64}$'),
  expires_epoch NUMERIC(20,0) NOT NULL CHECK(expires_epoch>=0 AND expires_epoch<18446744073709551616),
  state TEXT NOT NULL DEFAULT 'signing' CHECK(state IN ('signing','signed','resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolution TEXT CHECK(resolution IN ('executed','failed','gas-superseded','expired')),
  CHECK((state='resolved')=(resolved_at IS NOT NULL)),
  CHECK((resolved_at IS NULL)=(resolution IS NULL))
);
CREATE UNIQUE INDEX presale_outbox_prepared_active ON presale_outbox_prepared_inputs(action_id) WHERE resolved_at IS NULL;
CREATE INDEX presale_outbox_prepared_recovery ON presale_outbox_prepared_inputs(network,deployment_fingerprint,created_at) WHERE state='signing';

-- Short coordinator locks serialize conflicting reservation INSERTs. No locks
-- remain held during RPC, simulation, crypto signing or broadcast.
CREATE TABLE presale_outbox_input_objects (
  network TEXT NOT NULL CHECK(network IN ('mainnet','testnet','devnet','localnet')),
  object_id TEXT NOT NULL CHECK(object_id ~ '^0x[0-9a-f]{64}$'),
  PRIMARY KEY(network,object_id)
);
CREATE TABLE presale_outbox_input_reservations (
  prepared_digest TEXT NOT NULL REFERENCES presale_outbox_prepared_inputs(digest),
  network TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_version NUMERIC(20,0) NOT NULL CHECK(object_version>=0 AND object_version<18446744073709551616),
  object_digest TEXT NOT NULL CHECK(object_digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  access_mode TEXT NOT NULL CHECK(access_mode IN ('exclusive','immutable-borrow')),
  is_gas BOOLEAN NOT NULL,
  released_at TIMESTAMPTZ,
  PRIMARY KEY(prepared_digest,object_id),
  FOREIGN KEY(network,object_id) REFERENCES presale_outbox_input_objects(network,object_id),
  CHECK(NOT is_gas OR access_mode='exclusive')
);
CREATE INDEX presale_outbox_reserved_object ON presale_outbox_input_reservations(network,object_id,access_mode) WHERE released_at IS NULL;

CREATE FUNCTION presale_outbox_prepared_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.digest,NEW.action_id,NEW.owner,NEW.generation,NEW.network,NEW.deployment_fingerprint,
         NEW.signer_address,NEW.transaction_bytes,NEW.bytes_hash,NEW.expires_epoch,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.digest,OLD.action_id,OLD.owner,OLD.generation,OLD.network,OLD.deployment_fingerprint,
         OLD.signer_address,OLD.transaction_bytes,OLD.bytes_hash,OLD.expires_epoch,OLD.created_at)
    OR OLD.state='resolved' OR (OLD.state='signed' AND NEW.state='signing') THEN
    RAISE EXCEPTION 'prepared signing commitment is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER presale_outbox_prepared_immutable BEFORE UPDATE ON presale_outbox_prepared_inputs FOR EACH ROW EXECUTE FUNCTION presale_outbox_prepared_immutable();
REVOKE ALL ON presale_outbox_prepared_inputs,presale_outbox_input_objects,presale_outbox_input_reservations FROM PUBLIC,blast_web,blast_social,blast_replica;
REVOKE ALL ON FUNCTION presale_outbox_prepared_immutable() FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON presale_outbox_prepared_inputs,presale_outbox_input_objects,presale_outbox_input_reservations TO blast_watcher;

-- Per-input custody replaces the former wallet-wide signing barrier.
DROP INDEX presale_outbox_signer_open;

ALTER TABLE presale_outbox_prepared_inputs OWNER TO blast_watcher;
ALTER TABLE presale_outbox_input_objects OWNER TO blast_watcher;
ALTER TABLE presale_outbox_input_reservations OWNER TO blast_watcher;

CREATE FUNCTION presale_outbox_reserved_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.prepared_digest,NEW.network,NEW.object_id,NEW.object_version,NEW.object_digest,NEW.access_mode,NEW.is_gas)
    IS DISTINCT FROM ROW(OLD.prepared_digest,OLD.network,OLD.object_id,OLD.object_version,OLD.object_digest,OLD.access_mode,OLD.is_gas)
    OR OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'reserved input commitment is immutable';
  END IF;
  IF NEW.released_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM presale_outbox_prepared_inputs WHERE digest=NEW.prepared_digest AND state='resolved') THEN
    RAISE EXCEPTION 'prepared signing commitment must resolve before input release';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER presale_outbox_reserved_immutable BEFORE UPDATE ON presale_outbox_input_reservations FOR EACH ROW EXECUTE FUNCTION presale_outbox_reserved_immutable();
REVOKE ALL ON FUNCTION presale_outbox_reserved_immutable() FROM PUBLIC;
