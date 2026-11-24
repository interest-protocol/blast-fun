-- Every worker key pays gas from its SUI address balance: no gas coin, and a
-- one-epoch `ValidDuring` expiration. No stored transaction names a gas coin,
-- so none can be superseded by a spend of one: an open transaction settles by
-- its digest or once its epoch ends (`expired`). The gas coins a submission
-- paid with, the presale outbox's gas-coin reservations and the
-- `gas-superseded` resolution go.
--
-- The tables are locked first, so no transaction paid with gas coins can open
-- between the check and the change. A transaction still open with gas coins
-- must settle under the code that sent it before this migration runs.
LOCK TABLE mission_control_worker_submissions, presale_outbox_attempts,
  presale_outbox_prepared_inputs, presale_outbox_input_reservations IN ACCESS EXCLUSIVE MODE;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM mission_control_worker_submissions WHERE resolved_at IS NULL AND gas_payment <> '[]'::jsonb)
    OR EXISTS (SELECT 1 FROM presale_outbox_attempts WHERE resolved_at IS NULL AND COALESCE(inputs->'gas', '[]'::jsonb) <> '[]'::jsonb)
    OR EXISTS (SELECT 1 FROM presale_outbox_input_reservations WHERE released_at IS NULL AND is_gas) THEN
    RAISE EXCEPTION 'open transactions paid with gas coins exist: let them settle before this migration';
  END IF;
END $$;

-- Rows resolved before this migration keep their recorded resolution
-- (`NOT VALID`); every new or changed row is checked.
ALTER TABLE mission_control_worker_submissions
  DROP COLUMN gas_payment,
  DROP CONSTRAINT mission_control_worker_submissions_resolution_check,
  ADD CONSTRAINT mission_control_worker_submissions_resolution_check
    CHECK (resolution IN ('executed', 'failed', 'expired')) NOT VALID;

ALTER TABLE presale_outbox_attempts
  DROP CONSTRAINT presale_outbox_attempts_resolution_check,
  ADD CONSTRAINT presale_outbox_attempts_resolution_check
    CHECK (resolution IN ('executed', 'failed', 'expired')) NOT VALID;

ALTER TABLE presale_outbox_prepared_inputs
  DROP CONSTRAINT presale_outbox_prepared_inputs_resolution_check,
  ADD CONSTRAINT presale_outbox_prepared_inputs_resolution_check
    CHECK (resolution IN ('executed', 'failed', 'expired')) NOT VALID;

-- Only owned object inputs are reserved now, never a gas coin.
CREATE OR REPLACE FUNCTION presale_outbox_reserved_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.prepared_digest,NEW.network,NEW.object_id,NEW.object_version,NEW.object_digest,NEW.access_mode)
    IS DISTINCT FROM ROW(OLD.prepared_digest,OLD.network,OLD.object_id,OLD.object_version,OLD.object_digest,OLD.access_mode)
    OR OLD.released_at IS NOT NULL THEN
    RAISE EXCEPTION 'reserved input commitment is immutable';
  END IF;
  IF NEW.released_at IS NOT NULL AND NOT EXISTS(SELECT 1 FROM presale_outbox_prepared_inputs WHERE digest=NEW.prepared_digest AND state='resolved') THEN
    RAISE EXCEPTION 'prepared signing commitment must resolve before input release';
  END IF;
  RETURN NEW;
END $$;
ALTER TABLE presale_outbox_input_reservations DROP COLUMN is_gas;
