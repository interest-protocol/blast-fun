ALTER TABLE presale_outbox_input_reservations
  ADD COLUMN is_gas BOOLEAN NOT NULL DEFAULT false,
  ADD CONSTRAINT presale_outbox_input_reservations_check CHECK (NOT is_gas OR access_mode = 'exclusive');
ALTER TABLE presale_outbox_input_reservations ALTER COLUMN is_gas DROP DEFAULT;

CREATE OR REPLACE FUNCTION presale_outbox_reserved_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
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

ALTER TABLE presale_outbox_prepared_inputs
  DROP CONSTRAINT presale_outbox_prepared_inputs_resolution_check,
  ADD CONSTRAINT presale_outbox_prepared_inputs_resolution_check
    CHECK (resolution IN ('executed', 'failed', 'gas-superseded', 'expired'));

ALTER TABLE presale_outbox_attempts
  DROP CONSTRAINT presale_outbox_attempts_resolution_check,
  ADD CONSTRAINT presale_outbox_attempts_resolution_check
    CHECK (resolution IN ('executed', 'failed', 'gas-superseded', 'expired'));

-- Open address-balance submissions name no gas coin.
ALTER TABLE mission_control_worker_submissions
  ADD COLUMN gas_payment JSONB NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(gas_payment) = 'array'),
  DROP CONSTRAINT mission_control_worker_submissions_resolution_check,
  ADD CONSTRAINT mission_control_worker_submissions_resolution_check
    CHECK (resolution IN ('executed', 'failed', 'gas-superseded', 'expired'));
ALTER TABLE mission_control_worker_submissions ALTER COLUMN gas_payment DROP DEFAULT;
