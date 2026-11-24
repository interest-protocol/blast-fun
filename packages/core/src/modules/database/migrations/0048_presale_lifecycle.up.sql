-- Presale (T-023): the lifecycle relayer's per-sale records
-- (modules/presale/lifecycle). One record per (network, presale) that
-- blast-infra's `GET /v1/presales` listed open or funded. The relayer
-- revisits `open`, `funded` and `migrate_blocked` records from
-- `next_check_at`, always from a fresh chain read; `migrated`, `cancelled`
-- and `rejected` are final for it. The chain, not this table, decides an
-- outcome: a sale someone else settled or migrated closes with `external`.
-- `blast_watcher` alone may use it. Object IDs, types and digests are public
-- chain identifiers; nothing here holds a key, a signature, a provider URL or
-- a provider answer.
--
-- States:
-- - `open`: waiting for `end_ms`, then for `settle` (with the venue's
--   `migrate` in the same transaction when the raise is met);
-- - `funded`: settled with the raise met; `migrate` is retried with backoff
--   until the sale leaves Funded;
-- - `migrate_blocked`: funded, and the last migrate attempt failed in
--   simulation (or could not be built); `blocked_abort` names why;
-- - `migrated`, `cancelled`: final, from the chain;
-- - `rejected`: final, the object is not a presale of this deployment.
CREATE TABLE presale_lifecycle_records (
  network TEXT NOT NULL CHECK (network IN ('mainnet', 'localnet')),
  presale_id TEXT NOT NULL CHECK (presale_id ~ '^0x[0-9a-f]{64}$'),
  meme_type TEXT NOT NULL CHECK (char_length(meme_type) BETWEEN 5 AND 1024),
  quote_type TEXT NOT NULL CHECK (char_length(quote_type) BETWEEN 5 AND 1024),
  venue TEXT NOT NULL CHECK (venue IN ('cetus', 'bluefin')),
  end_ms BIGINT NOT NULL CHECK (end_ms >= 0),
  liquidity_deadline_ms BIGINT NOT NULL CHECK (liquidity_deadline_ms >= 0),
  state TEXT NOT NULL CHECK (state IN ('open', 'funded', 'migrate_blocked', 'migrated', 'cancelled', 'rejected')),
  -- Who settled it, judged from the relayer's own digests: `worker` when one of
  -- them did, `external` when someone else did.
  settled_by TEXT CHECK (settled_by IN ('worker', 'external')),
  migrated_by TEXT CHECK (migrated_by IN ('worker', 'external')),
  cancel_reason TEXT CHECK (cancel_reason IN ('raise_missed', 'liquidity_deadline')),
  -- The relayer's latest submission containing `settle` and its shape, and its
  -- latest containing `migrate`, each recorded before the bytes were sent.
  settle_digest TEXT CHECK (settle_digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  settle_shape TEXT CHECK (settle_shape IN ('settle', 'settle-migrate')),
  migrate_digest TEXT CHECK (migrate_digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- Migrate attempts: the combined transaction counts as the first.
  migrate_attempts INTEGER NOT NULL DEFAULT 0 CHECK (migrate_attempts >= 0),
  -- Transactions containing `settle` that executed and failed on chain: the
  -- next settle is `settle` alone, backed off after a failed `settle` alone.
  settle_failures INTEGER NOT NULL DEFAULT 0 CHECK (settle_failures >= 0),
  -- Why migration is blocked: the SDK abort name of a presale-package abort,
  -- `external_abort` for any other simulation failure (contract CL-24), or a
  -- build-time class such as `bluefin-fee-unreadable` or
  -- `bluefin-fee-above-cap`, or a gas class (`insufficient-gas`,
  -- `insufficient-coin-balance`); with the abort's
  -- `<package>::<module>` and code when the node gave them.
  blocked_abort TEXT CHECK (blocked_abort ~ '^[A-Za-z][A-Za-z0-9_-]{0,63}$'),
  blocked_location TEXT CHECK (char_length(blocked_location) BETWEEN 1 AND 200),
  blocked_code BIGINT,
  -- The last visit's retry reason (`^[a-z][a-z0-9-]*$`), cleared on progress.
  error_class TEXT CHECK (error_class ~ '^[a-z][a-z0-9-]{0,63}$'),
  next_check_at TIMESTAMPTZ NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL,
  -- When the relayer first saw the sale Funded (its migrate clock starts here).
  funded_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (network, presale_id),
  CHECK ((state IN ('migrated', 'cancelled', 'rejected')) = (closed_at IS NOT NULL)),
  CHECK (state <> 'migrated' OR migrated_by IS NOT NULL),
  CHECK (state <> 'cancelled' OR cancel_reason IS NOT NULL),
  CHECK (state NOT IN ('funded', 'migrate_blocked') OR funded_at IS NOT NULL),
  CHECK (state <> 'migrate_blocked' OR blocked_abort IS NOT NULL),
  CHECK ((settle_digest IS NULL) = (settle_shape IS NULL))
);

-- The relayer's due scan, its next wake, and its overdue and deadline sweeps.
CREATE INDEX presale_lifecycle_records_due_idx
  ON presale_lifecycle_records (network, next_check_at)
  WHERE state IN ('open', 'funded', 'migrate_blocked');

REVOKE ALL ON TABLE presale_lifecycle_records FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE presale_lifecycle_records TO blast_watcher;
