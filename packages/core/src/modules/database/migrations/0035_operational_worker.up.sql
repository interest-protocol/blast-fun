-- The operational worker (modules/operational-worker) and its first job, Coin
-- Registry registration (modules/coin-registration). The worker is its own
-- process on the primary's pooled endpoint as the watcher login, so its rows
-- are leases, not advisory locks, and every table here is `blast_watcher`'s
-- alone: the web runtime (`blast_web`) can neither read nor write them.
-- Nothing here holds a key, a signature, a provider URL or a provider answer.

-- One row per job and key while a worker process holds it. A lease only keeps
-- two processes from working on the same record at once; the chain, read
-- afresh before every attempt, decides what happened.
CREATE TABLE mission_control_worker_leases (
  job TEXT NOT NULL CHECK (job ~ '^[a-z][a-z0-9-]{0,63}$'),
  lease_key TEXT NOT NULL CHECK (char_length(lease_key) BETWEEN 1 AND 1024),
  holder UUID NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (job, lease_key),
  CHECK (expires_at > acquired_at)
);

-- Per job and network: the job's durable discovery cursor and, while the
-- worker may not sign, the configuration block's reason codes. `unselected`
-- is the network of a worker started without a selected deployment.
CREATE TABLE mission_control_worker_jobs (
  job TEXT NOT NULL CHECK (job ~ '^[a-z][a-z0-9-]{0,63}$'),
  network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet', 'devnet', 'localnet', 'unselected')),
  cursor JSONB CHECK (cursor IS NULL OR jsonb_typeof(cursor) = 'object'),
  blocked_reasons TEXT[] CHECK (
    blocked_reasons IS NULL OR (
      cardinality(blocked_reasons) BETWEEN 1 AND 16
      AND array_to_string(blocked_reasons, ',') ~ '^[a-z][a-z0-9-]{0,63}(,[a-z][a-z0-9-]{0,63})*$'
    )
  ),
  blocked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (job, network),
  CHECK ((blocked_reasons IS NULL) = (blocked_at IS NULL))
);

-- Every transaction the worker's key sent, until the chain settles it. While
-- any row of a signer is open (`resolved_at IS NULL`) the worker signs no new
-- transaction for that key: it first reads the digest's effects, proves the
-- bytes can never run (their gas coin version was spent, or their epoch
-- ended), or resends the same bytes. Two different transactions over one gas
-- coin version would equivocate and lock it until the epoch ends. The bytes
-- are unsigned transaction data, public once submitted; no signature is kept.
CREATE TABLE mission_control_worker_submissions (
  digest TEXT PRIMARY KEY CHECK (digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  signer_address TEXT NOT NULL CHECK (signer_address ~ '^0x[0-9a-f]{64}$'),
  network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet', 'devnet', 'localnet')),
  job TEXT NOT NULL CHECK (job ~ '^[a-z][a-z0-9-]{0,63}$'),
  record_key TEXT NOT NULL CHECK (char_length(record_key) BETWEEN 1 AND 1024),
  intent JSONB NOT NULL CHECK (jsonb_typeof(intent) = 'object'),
  transaction_bytes BYTEA NOT NULL CHECK (octet_length(transaction_bytes) BETWEEN 1 AND 131072),
  gas_payment JSONB NOT NULL CHECK (jsonb_typeof(gas_payment) = 'array'),
  expires_epoch NUMERIC(20, 0) NOT NULL CHECK (expires_epoch >= 0),
  submitted_at TIMESTAMPTZ NOT NULL,
  resolved_at TIMESTAMPTZ,
  resolution TEXT CHECK (resolution IN ('executed', 'failed', 'gas-superseded', 'expired')),
  CHECK ((resolved_at IS NULL) = (resolution IS NULL))
);

-- The signer gate's scan of open submissions.
CREATE INDEX mission_control_worker_submissions_open_idx
  ON mission_control_worker_submissions (signer_address, network)
  WHERE resolved_at IS NULL;

-- One record per (network, Meme type) that blast-infra listed as a configured-
-- lineage coin without a pool. `pending` and `submitted` records are revisited
-- from `next_eligible_at`; `registered`, `rejected` and `stalled` are final for
-- the worker. Object IDs and digests are public chain identifiers.
CREATE TABLE mission_control_coin_registrations (
  network TEXT NOT NULL CHECK (network IN ('mainnet', 'testnet', 'devnet', 'localnet')),
  meme_type TEXT NOT NULL CHECK (char_length(meme_type) BETWEEN 5 AND 1024),
  created_checkpoint BIGINT NOT NULL CHECK (created_checkpoint >= 0),
  pending_currency_id TEXT CHECK (pending_currency_id ~ '^0x[0-9a-f]{64}$'),
  pending_currency_version TEXT CHECK (pending_currency_version ~ '^[0-9]{1,20}$'),
  pending_currency_digest TEXT CHECK (pending_currency_digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  publication_digest TEXT CHECK (publication_digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  ticket_id TEXT CHECK (ticket_id ~ '^0x[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('pending', 'submitted', 'registered', 'rejected', 'stalled')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  latest_digest TEXT CHECK (latest_digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  next_eligible_at TIMESTAMPTZ NOT NULL,
  error_class TEXT CHECK (error_class ~ '^[a-z][a-z0-9-]{0,63}$'),
  outcome TEXT CHECK (outcome IN ('registered-by-worker', 'already-registered')),
  shared_currency_id TEXT CHECK (shared_currency_id ~ '^0x[0-9a-f]{64}$'),
  detected_at TIMESTAMPTZ NOT NULL,
  registered_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (network, meme_type),
  CHECK ((state = 'registered') = (registered_at IS NOT NULL)),
  CHECK ((state = 'registered') = (outcome IS NOT NULL)),
  CHECK (state <> 'submitted' OR latest_digest IS NOT NULL),
  CHECK (state NOT IN ('rejected', 'stalled') OR error_class IS NOT NULL),
  CHECK (
    (pending_currency_id IS NULL AND pending_currency_version IS NULL AND pending_currency_digest IS NULL)
    OR (pending_currency_id IS NOT NULL AND pending_currency_version IS NOT NULL AND pending_currency_digest IS NOT NULL)
  )
);

-- The worker's due scan (coin-registration/repository.ts) and backlog metric.
CREATE INDEX mission_control_coin_registrations_due_idx
  ON mission_control_coin_registrations (network, next_eligible_at)
  WHERE state IN ('pending', 'submitted');

REVOKE ALL ON TABLE
  mission_control_worker_leases,
  mission_control_worker_jobs,
  mission_control_worker_submissions,
  mission_control_coin_registrations
FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mission_control_worker_leases TO blast_watcher;
GRANT SELECT, INSERT, UPDATE ON TABLE mission_control_worker_jobs TO blast_watcher;
GRANT SELECT, INSERT, UPDATE ON TABLE mission_control_worker_submissions TO blast_watcher;
GRANT SELECT, INSERT, UPDATE ON TABLE mission_control_coin_registrations TO blast_watcher;
