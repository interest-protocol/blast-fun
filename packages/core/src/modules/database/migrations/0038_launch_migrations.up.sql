-- The operational worker's automatic migration job (modules/launch-migration).
-- One record per (network, launch) that blast-infra's committed
-- `chain_read_v1.pools` listed as a MigrationReady Blast curve. The worker
-- revisits `pending`, `submitted` and `blocked` records from
-- `next_eligible_at`, always from fresh chain reads; `migrated`, `rejected`
-- and `stalled` are final for it. Chain reconciliation, not this table,
-- decides an outcome: another wallet's migration closes a record as success.
-- `blast_watcher` alone may use it. Object IDs, types and digests are public
-- chain identifiers; nothing here holds a key, a signature, a provider URL or
-- a provider answer.
CREATE TABLE mission_control_launch_migrations (
  network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet', 'devnet', 'localnet')),
  launch_id TEXT NOT NULL CHECK (launch_id ~ '^0x[0-9a-f]{64}$'),
  meme_type TEXT NOT NULL CHECK (char_length(meme_type) BETWEEN 5 AND 1024),
  quote_type TEXT NOT NULL CHECK (char_length(quote_type) BETWEEN 5 AND 1024),
  -- The committed watermark checkpoint at which the job first saw the launch
  -- ready; not the lifecycle change's own checkpoint (the view lacks it).
  ready_checkpoint BIGINT NOT NULL CHECK (ready_checkpoint >= 0),
  -- The launch's recorded venue, once read from the chain.
  venue TEXT CHECK (venue IN ('cetus', 'bluefin')),
  state TEXT NOT NULL CHECK (state IN ('pending', 'submitted', 'blocked', 'migrated', 'rejected', 'stalled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  latest_digest TEXT CHECK (latest_digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- Every digest the worker recorded before sending, oldest first (the last is
  -- latest_digest): attribution and the check before another attempt read
  -- each one's effects on chain.
  digests TEXT[] NOT NULL DEFAULT '{}',
  next_eligible_at TIMESTAMPTZ NOT NULL,
  error_class TEXT CHECK (error_class ~ '^[a-z][a-z0-9-]{0,63}$'),
  outcome TEXT CHECK (outcome IN ('migrated-by-worker', 'already-migrated')),
  detected_at TIMESTAMPTZ NOT NULL,
  migrated_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (network, launch_id),
  CHECK ((state = 'migrated') = (migrated_at IS NOT NULL)),
  CHECK ((state = 'migrated') = (outcome IS NOT NULL)),
  CHECK (state <> 'submitted' OR latest_digest IS NOT NULL),
  CHECK (latest_digest IS NOT DISTINCT FROM digests[cardinality(digests)]),
  CHECK (state NOT IN ('blocked', 'rejected', 'stalled') OR error_class IS NOT NULL)
);

-- The worker's due scan (launch-migration/repository.ts) and backlog metric.
CREATE INDEX mission_control_launch_migrations_due_idx
  ON mission_control_launch_migrations (network, next_eligible_at)
  WHERE state IN ('pending', 'submitted', 'blocked');

REVOKE ALL ON TABLE mission_control_launch_migrations FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE mission_control_launch_migrations TO blast_watcher;
