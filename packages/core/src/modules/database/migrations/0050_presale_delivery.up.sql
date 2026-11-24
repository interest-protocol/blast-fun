-- Presale (T-024): delivery after a sale closes. The lifecycle key's claim
-- delivery job (modules/presale/delivery) claims, for every wallet that still
-- holds a `CommitmentKey` field on a `Migrated` or `Cancelled` sale, in
-- ascending address order, and marks the record `delivered` once a listing of
-- the sale's dynamic fields returns no commitment and the sale's
-- `remaining_commitments` is zero. The chain, not this table, says who is
-- still owed. 0048's table gains two states and the delivery columns; its
-- grants are unchanged (`blast_watcher` SELECT, INSERT, UPDATE).
--
-- - `delivered`: final; every commitment was claimed (by the relayer or
--   anyone). `migrated_by` or `cancel_reason` still says how the sale closed.
-- - `unpayable`: every wallet that can be paid was claimed; the wallets in
--   `unpaid_wallets` cannot be (each one's own claim fails, for example a
--   deny-listed Quote recipient). They keep their commitment; delivery tries
--   them again hourly and moves the record to `delivered` once they are paid.
-- - `claim_digest`: the relayer's latest claim batch, recorded before its
--   bytes were sent; `claim_batches` counts them.
-- - `claim_failures`: claim batches that executed and failed on chain since
--   the last one that landed (someone else's claim racing a batch is not
--   counted); the next batch backs off on it.
-- - `claim_batch_size`: the batch size in force for this sale, halved after a
--   full batch's size, object or gas-limit failure; null until one is needed.
-- - `claim_blocked_reason`: why delivery is blocked (`error_class` is
--   `claim-blocked`): an SDK abort name, `external_abort` (contract CL-24) or a
--   gas class.
-- - `unpaid_wallets`: the wallets set aside as unpayable, ascending.
-- - `delivered_at`: when delivery was confirmed complete.
-- `next_check_at` and `error_class` serve delivery while the record is
-- `migrated`, `cancelled` or `unpayable`.

ALTER TABLE presale_lifecycle_records
  DROP CONSTRAINT presale_lifecycle_records_state_check,
  ADD CONSTRAINT presale_lifecycle_records_state_check
    CHECK (state IN ('open', 'funded', 'migrate_blocked', 'migrated', 'cancelled', 'rejected', 'delivered', 'unpayable')),
  DROP CONSTRAINT presale_lifecycle_records_check,
  ADD CONSTRAINT presale_lifecycle_records_check
    CHECK ((state IN ('migrated', 'cancelled', 'rejected', 'delivered', 'unpayable')) = (closed_at IS NOT NULL)),
  ADD COLUMN claim_digest TEXT CHECK (claim_digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  ADD COLUMN claim_batches INTEGER NOT NULL DEFAULT 0 CHECK (claim_batches >= 0),
  ADD COLUMN claim_failures INTEGER NOT NULL DEFAULT 0 CHECK (claim_failures >= 0),
  ADD COLUMN claim_batch_size INTEGER CHECK (claim_batch_size BETWEEN 1 AND 500),
  ADD COLUMN claim_blocked_reason TEXT CHECK (claim_blocked_reason ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  ADD COLUMN unpaid_wallets TEXT[] NOT NULL DEFAULT '{}'
    CHECK (array_position(unpaid_wallets, NULL) IS NULL AND array_to_string(unpaid_wallets, ',') ~ '^(0x[0-9a-f]{64}(,0x[0-9a-f]{64})*)?$'),
  ADD COLUMN delivered_at TIMESTAMPTZ,
  ADD CONSTRAINT presale_lifecycle_records_delivered_check
    CHECK ((state = 'delivered') = (delivered_at IS NOT NULL)),
  ADD CONSTRAINT presale_lifecycle_records_delivered_outcome_check
    CHECK (state NOT IN ('delivered', 'unpayable') OR migrated_by IS NOT NULL OR cancel_reason IS NOT NULL),
  ADD CONSTRAINT presale_lifecycle_records_unpaid_check
    CHECK ((state <> 'unpayable' OR cardinality(unpaid_wallets) > 0) AND (state <> 'delivered' OR cardinality(unpaid_wallets) = 0));

-- The delivery job's due scan: closed sales still awaiting delivery.
CREATE INDEX presale_lifecycle_records_delivery_idx
  ON presale_lifecycle_records (network, next_check_at)
  WHERE state IN ('migrated', 'cancelled', 'unpayable');
