-- Reverts 0050 to 0048's table. A `delivered` or `unpayable` record has no
-- 0048 state, so the revert refuses, loudly, while any exists rather than
-- rewriting history.
DO $$
DECLARE
  closed_by_delivery BIGINT;
BEGIN
  SELECT count(*) INTO closed_by_delivery FROM presale_lifecycle_records WHERE state IN ('delivered', 'unpayable');
  IF closed_by_delivery > 0 THEN
    RAISE EXCEPTION '0050_presale_delivery down: % presale_lifecycle_records rows are delivered or unpayable; 0048 has no such state', closed_by_delivery
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

DROP INDEX IF EXISTS presale_lifecycle_records_delivery_idx;

ALTER TABLE presale_lifecycle_records
  DROP CONSTRAINT presale_lifecycle_records_unpaid_check,
  DROP CONSTRAINT presale_lifecycle_records_delivered_outcome_check,
  DROP CONSTRAINT presale_lifecycle_records_delivered_check,
  DROP COLUMN delivered_at,
  DROP COLUMN unpaid_wallets,
  DROP COLUMN claim_blocked_reason,
  DROP COLUMN claim_batch_size,
  DROP COLUMN claim_failures,
  DROP COLUMN claim_batches,
  DROP COLUMN claim_digest,
  DROP CONSTRAINT presale_lifecycle_records_check,
  ADD CONSTRAINT presale_lifecycle_records_check
    CHECK ((state IN ('migrated', 'cancelled', 'rejected')) = (closed_at IS NOT NULL)),
  DROP CONSTRAINT presale_lifecycle_records_state_check,
  ADD CONSTRAINT presale_lifecycle_records_state_check
    CHECK (state IN ('open', 'funded', 'migrate_blocked', 'migrated', 'cancelled', 'rejected'));
