DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM presale_outbox_prepared_inputs WHERE resolved_at IS NULL) THEN
    RAISE EXCEPTION 'unresolved prepared signing commitments exist';
  END IF;
END $$;
DROP TABLE presale_outbox_input_reservations;
DROP TABLE presale_outbox_input_objects;
DROP TABLE presale_outbox_prepared_inputs;
DROP FUNCTION presale_outbox_prepared_immutable();
DROP FUNCTION presale_outbox_reserved_immutable();

CREATE UNIQUE INDEX presale_outbox_signer_open ON presale_outbox_attempts(signer_address) WHERE resolved_at IS NULL;
