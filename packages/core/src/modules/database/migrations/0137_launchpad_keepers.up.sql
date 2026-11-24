-- The operational worker's opening-round keeper (modules/opening-round, LP-18)
-- and its Blast and partner fee claims (modules/fee-claims, LP-20). Each table
-- holds one record per (network, launch) that blast-infra's committed
-- `chain_read_v1.pools` lists as a Blast curve, recorded behind the job's
-- durable cursor (`mission_control_worker_jobs.cursor`), so every launch is
-- visited at least once even when someone else settled it first. Chain
-- reconciliation, not these tables, decides every outcome. `blast_watcher`
-- alone may use them. Object IDs, types, page tokens and digests are public
-- chain or index identifiers; nothing here holds a key, a signature, a
-- provider URL or a provider answer.

-- One launch's opening round: `pending` until its first chain read, then
-- `settling` (the round runs or waits to be settled), then `delivering`
-- (settled; bids remain undelivered), then `delivered`. A launch with no
-- opening round closes as `no-round` on its first read.
CREATE TABLE mission_control_opening_rounds (
  network TEXT NOT NULL CHECK (network = 'mainnet'),
  launch_id TEXT NOT NULL CHECK (launch_id ~ '^0x[0-9a-f]{64}$'),
  meme_type TEXT NOT NULL CHECK (char_length(meme_type) BETWEEN 5 AND 1024),
  quote_type TEXT NOT NULL CHECK (char_length(quote_type) BETWEEN 5 AND 1024),
  created_checkpoint BIGINT NOT NULL CHECK (created_checkpoint >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'settling', 'delivering', 'delivered', 'no-round', 'rejected', 'stalled')),
  -- `public_start_ms + opening_round_ms` as the chain holds them, once read.
  round_end_ms BIGINT CHECK (round_end_ms >= 0),
  -- Who settled: `worker` when one of `settle_digests` did, `external` when
  -- none did, NULL while the node cannot say.
  settled_by TEXT CHECK (settled_by IN ('worker', 'external')),
  settled_at TIMESTAMPTZ,
  -- blast-infra's bidders page token the next delivery reads from; NULL is the first page.
  bidders_cursor TEXT CHECK (bidders_cursor ~ '^[A-Za-z0-9_-]+$' AND char_length(bidders_cursor) <= 512),
  -- Bidders this worker's own executed deliveries paid.
  delivered_bidders INTEGER NOT NULL DEFAULT 0 CHECK (delivered_bidders >= 0),
  -- Consecutive failed attempts (failed simulations, failed or unknown
  -- submissions, local failures); an executed transaction resets it.
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  latest_digest TEXT CHECK (latest_digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- Every settle digest recorded before sending, oldest first: who settled is read from their effects.
  settle_digests TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(settle_digests) <= 64),
  next_eligible_at TIMESTAMPTZ NOT NULL,
  error_class TEXT CHECK (error_class ~ '^[a-z][a-z0-9-]{0,63}$'),
  detected_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (network, launch_id),
  CHECK ((state IN ('delivered', 'no-round', 'rejected', 'stalled')) = (closed_at IS NOT NULL)),
  CHECK (state NOT IN ('delivering', 'delivered') OR settled_at IS NOT NULL),
  CHECK (state NOT IN ('rejected', 'stalled') OR error_class IS NOT NULL)
);

-- The job's due scans (settlement first, then delivery) and its backlog metric.
CREATE INDEX mission_control_opening_rounds_due_idx
  ON mission_control_opening_rounds (network, state, next_eligible_at)
  WHERE state IN ('pending', 'settling', 'delivering');

-- The unsettled-round alert sweep: rounds that ended and are not settled, oldest end first.
CREATE INDEX mission_control_opening_rounds_unsettled_idx
  ON mission_control_opening_rounds (network, round_end_ms)
  WHERE settled_at IS NULL AND state IN ('pending', 'settling', 'stalled');

-- One launch's fee claims: its curve's protocol fees and, for a partnered
-- launch after migration, its vault's held Blast LP share. `active` records
-- are revisited every claim interval; an unpartnered migrated launch whose
-- curve ledger is empty is `complete` (nothing accrues there again).
CREATE TABLE mission_control_fee_claims (
  network TEXT NOT NULL CHECK (network = 'mainnet'),
  launch_id TEXT NOT NULL CHECK (launch_id ~ '^0x[0-9a-f]{64}$'),
  meme_type TEXT NOT NULL CHECK (char_length(meme_type) BETWEEN 5 AND 1024),
  quote_type TEXT NOT NULL CHECK (char_length(quote_type) BETWEEN 5 AND 1024),
  created_checkpoint BIGINT NOT NULL CHECK (created_checkpoint >= 0),
  state TEXT NOT NULL CHECK (state IN ('active', 'complete', 'rejected', 'stalled')),
  -- The launch's recorded partner, as the chain holds it; NULL for none.
  partner_id TEXT CHECK (partner_id ~ '^0x[0-9a-f]{64}$'),
  -- The migration's vault, from blast-infra's rewards read, once migrated.
  vault_id TEXT CHECK (vault_id ~ '^0x[0-9a-f]{64}$'),
  -- Consecutive failed claims; an executed claim resets it. It only grows the backoff.
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  latest_digest TEXT CHECK (latest_digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  curve_claims INTEGER NOT NULL DEFAULT 0 CHECK (curve_claims >= 0),
  vault_claims INTEGER NOT NULL DEFAULT 0 CHECK (vault_claims >= 0),
  last_claimed_at TIMESTAMPTZ,
  next_eligible_at TIMESTAMPTZ NOT NULL,
  error_class TEXT CHECK (error_class ~ '^[a-z][a-z0-9-]{0,63}$'),
  detected_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (network, launch_id),
  CHECK ((state = 'active') = (closed_at IS NULL)),
  CHECK (state NOT IN ('rejected', 'stalled') OR error_class IS NOT NULL)
);

-- The job's due scan and its backlog metric.
CREATE INDEX mission_control_fee_claims_due_idx
  ON mission_control_fee_claims (network, next_eligible_at)
  WHERE state = 'active';

REVOKE ALL ON TABLE mission_control_opening_rounds, mission_control_fee_claims FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE mission_control_opening_rounds, mission_control_fee_claims TO blast_watcher;
