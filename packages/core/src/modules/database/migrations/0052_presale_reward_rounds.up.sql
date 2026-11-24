-- Presale (T-026): holder-reward rounds, twice a day (00:00 and 12:00 UTC).
-- Two worker processes share one slot per migrated sale:
--
-- - the lifecycle role (`presale-fee-collection`) opens the slot: it finds
--   the sale's vault and pool, holds the sale coin's holder ledger at the
--   chain's latest checkpoint, then submits the venue's `collect_fees` (or
--   records that the venue had no fees). The collection's checkpoint is the
--   round's end; with nothing collected, the held checkpoint is.
-- - the rewards role (`presale-reward-rounds`) takes the collected slot: it
--   moves the hold to the end, waits for the ledger to apply it, reads the
--   weights over `(start, end]` and the vault's unreserved holder share, and
--   skips, blocks, or stores the round (with every allocation, its proof and
--   its delivery mark) before the rewards key signs `publish_round`.
--
-- `presale_reward_slots`: one row per network, sale and slot. States:
-- `pending` (vault or hold not ready), `held` (ledger held, collection due),
-- `collected` (the end is known), `preparing` (the rewards role owns it),
-- `prepared` (its round is stored and awaits publication), and the final
-- `published`, `skipped` (`reason`: zero-budget, zero-weight,
-- all-zero-allocations), `blocked` (`reason`: reward_leaves_exceeded and the
-- like) and `superseded` (a later slot took over its interval before a round
-- was prepared: one catch-up round covers it). `error_class` is kebab-case
-- (why the last visit made no progress); abort names go in `reason`.
--
-- `presale_reward_rounds`: one row per prepared round, stored before signing.
-- `state` is `prepared`, `published` (with the on-chain `Round` ID from
-- `RoundPublished`), `abandoned` (the vault moved on before it published, or
-- its claim deadline passed unpublished) or `mismatched` (the chain published
-- it with other values: never served, never reset, held for an operator).
-- It keeps the accounting: the exclusions used, the total weight, the dust,
-- the price the marks were read at and the relay minimum. `manifest_sha256`
-- is the hash of the exact manifest text written to Blob and served by the
-- manifest route. At most one live round per vault and number.
--
-- `presale_reward_allocations`: each round's leaves by index, with the proof
-- and the delivery mark (`relay` or `self_claim`). Inserted once with the
-- round, never updated or deleted: the watcher may only insert and read them.
--
-- `presale_reward_event_cursors`: how far the chain's `RoundPublished` events
-- have been compared with the stored rounds.
--
-- `presale_reward_chain_rounds`: every `RoundPublished` of the deployment, as
-- the chain gave it, with how it was disposed of: `ours` (a stored round),
-- `recovered` (a round stored `abandoned` that the chain published),
-- `mismatch` (a stored round the chain published with other values) or
-- `foreign` (no stored round). `ledger_outcome` is the holder ledger's answer
-- when the round's end was recorded for a foreign round, or `unreconciled`
-- until an operator records it (`npm run presale:reward-rounds`).
CREATE TABLE presale_reward_rounds (
  id UUID PRIMARY KEY,
  network TEXT NOT NULL CHECK (network ~ '^[a-z][a-z0-9-]{0,31}$'),
  presale_id TEXT NOT NULL CHECK (presale_id ~ '^0x[0-9a-f]{64}$'),
  vault_id TEXT NOT NULL CHECK (vault_id ~ '^0x[0-9a-f]{64}$'),
  meme_type TEXT NOT NULL CHECK (char_length(meme_type) BETWEEN 1 AND 512),
  quote_type TEXT NOT NULL CHECK (char_length(quote_type) BETWEEN 1 AND 512),
  slot_ms BIGINT NOT NULL CHECK (slot_ms >= 0),
  number NUMERIC(20, 0) NOT NULL CHECK (number >= 0),
  start_checkpoint NUMERIC(20, 0) NOT NULL CHECK (start_checkpoint >= 0),
  end_checkpoint NUMERIC(20, 0) NOT NULL CHECK (end_checkpoint > start_checkpoint),
  root TEXT NOT NULL CHECK (root ~ '^[0-9a-f]{64}$'),
  manifest_digest TEXT NOT NULL CHECK (manifest_digest ~ '^[0-9a-f]{64}$'),
  leaf_count INTEGER NOT NULL CHECK (leaf_count BETWEEN 1 AND 65536),
  meme_amount NUMERIC(20, 0) NOT NULL CHECK (meme_amount >= 0),
  quote_amount NUMERIC(20, 0) NOT NULL CHECK (quote_amount >= 0),
  claim_deadline_ms BIGINT NOT NULL CHECK (claim_deadline_ms > slot_ms),
  state TEXT NOT NULL CHECK (state IN ('prepared', 'published', 'abandoned', 'mismatched')),
  policy_version TEXT NOT NULL CHECK (char_length(policy_version) BETWEEN 1 AND 64),
  exclusions TEXT[] NOT NULL,
  total_weight NUMERIC NOT NULL CHECK (total_weight > 0 AND total_weight = trunc(total_weight)),
  meme_dust NUMERIC(20, 0) NOT NULL CHECK (meme_dust >= 0),
  quote_dust NUMERIC(20, 0) NOT NULL CHECK (quote_dust >= 0),
  price_numerator NUMERIC NOT NULL CHECK (price_numerator >= 0),
  price_denominator NUMERIC NOT NULL CHECK (price_denominator > 0),
  relay_minimum NUMERIC(20, 0) NOT NULL CHECK (relay_minimum >= 0),
  manifest_sha256 TEXT NOT NULL CHECK (manifest_sha256 ~ '^[0-9a-f]{64}$'),
  blob_url TEXT CHECK (char_length(blob_url) BETWEEN 1 AND 2048),
  publish_digest TEXT CHECK (publish_digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  round_id TEXT UNIQUE CHECK (round_id ~ '^0x[0-9a-f]{64}$'),
  published_at TIMESTAMPTZ,
  -- The holder ledger's answer to the reset after `RoundPublished` (null until it was recorded).
  reset_outcome TEXT CHECK (reset_outcome ~ '^[a-z][a-z0-9-]{0,63}$'),
  announced_at TIMESTAMPTZ,
  error_class TEXT CHECK (error_class ~ '^[a-z][a-z0-9-]{0,63}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (meme_amount > 0 OR quote_amount > 0),
  CHECK ((state = 'published') = (round_id IS NOT NULL)),
  CHECK ((state = 'published') = (published_at IS NOT NULL))
);

-- At most one live round per vault and number: a round abandoned before it published frees its number.
CREATE UNIQUE INDEX presale_reward_rounds_live ON presale_reward_rounds (network, vault_id, number) WHERE state <> 'abandoned';
CREATE INDEX presale_reward_rounds_state ON presale_reward_rounds (network, state);

CREATE TABLE presale_reward_allocations (
  round UUID NOT NULL REFERENCES presale_reward_rounds (id),
  leaf_index INTEGER NOT NULL CHECK (leaf_index BETWEEN 0 AND 65535),
  beneficiary TEXT NOT NULL CHECK (beneficiary ~ '^0x[0-9a-f]{64}$'),
  meme_amount NUMERIC(20, 0) NOT NULL CHECK (meme_amount >= 0),
  quote_amount NUMERIC(20, 0) NOT NULL CHECK (quote_amount >= 0),
  proof TEXT[] NOT NULL CHECK (cardinality(proof) <= 16),
  delivery TEXT NOT NULL CHECK (delivery IN ('relay', 'self_claim')),
  PRIMARY KEY (round, leaf_index),
  UNIQUE (round, beneficiary),
  CHECK (meme_amount > 0 OR quote_amount > 0)
);

CREATE INDEX presale_reward_allocations_beneficiary ON presale_reward_allocations (beneficiary);

CREATE TABLE presale_reward_slots (
  network TEXT NOT NULL CHECK (network ~ '^[a-z][a-z0-9-]{0,31}$'),
  presale_id TEXT NOT NULL CHECK (presale_id ~ '^0x[0-9a-f]{64}$'),
  slot_ms BIGINT NOT NULL CHECK (slot_ms >= 0),
  meme_type TEXT NOT NULL CHECK (char_length(meme_type) BETWEEN 1 AND 512),
  quote_type TEXT NOT NULL CHECK (char_length(quote_type) BETWEEN 1 AND 512),
  venue TEXT NOT NULL CHECK (venue IN ('cetus', 'bluefin')),
  vault_id TEXT CHECK (vault_id ~ '^0x[0-9a-f]{64}$'),
  vault_initial_shared_version NUMERIC(20, 0),
  pool_id TEXT CHECK (pool_id ~ '^0x[0-9a-f]{64}$'),
  pool_initial_shared_version NUMERIC(20, 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'held', 'collected', 'preparing', 'prepared', 'published', 'skipped', 'blocked', 'superseded')),
  -- The checkpoint the holder ledger is held at for this slot (the slot's tip, then the end).
  hold_checkpoint NUMERIC(20, 0) CHECK (hold_checkpoint >= 0),
  -- The lifecycle key's collection, recorded before its bytes were sent; null when nothing was collected.
  collect_digest TEXT CHECK (collect_digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  collected BOOLEAN,
  end_checkpoint NUMERIC(20, 0) CHECK (end_checkpoint >= 0),
  round UUID REFERENCES presale_reward_rounds (id),
  reason TEXT CHECK (char_length(reason) BETWEEN 1 AND 200),
  error_class TEXT CHECK (error_class ~ '^[a-z][a-z0-9-]{0,63}$'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_check_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  closed_at TIMESTAMPTZ,
  PRIMARY KEY (network, presale_id, slot_ms),
  CHECK ((state IN ('collected', 'preparing', 'prepared', 'published')) <= (end_checkpoint IS NOT NULL)),
  CHECK ((state IN ('prepared', 'published')) <= (round IS NOT NULL)),
  CHECK ((state IN ('published', 'skipped', 'blocked', 'superseded')) = (closed_at IS NOT NULL)),
  CHECK ((state IN ('skipped', 'blocked')) <= (reason IS NOT NULL))
);

-- The open slots each job visits.
CREATE INDEX presale_reward_slots_open ON presale_reward_slots (network, state, next_check_at) WHERE closed_at IS NULL;

CREATE TABLE presale_reward_event_cursors (
  network TEXT PRIMARY KEY CHECK (network ~ '^[a-z][a-z0-9-]{0,31}$'),
  cursor TEXT CHECK (char_length(cursor) BETWEEN 1 AND 1024),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE presale_reward_chain_rounds (
  network TEXT NOT NULL CHECK (network ~ '^[a-z][a-z0-9-]{0,31}$'),
  round_id TEXT NOT NULL CHECK (round_id ~ '^0x[0-9a-f]{64}$'),
  vault_id TEXT NOT NULL CHECK (vault_id ~ '^0x[0-9a-f]{64}$'),
  meme_type TEXT NOT NULL CHECK (char_length(meme_type) BETWEEN 1 AND 512),
  number NUMERIC(20, 0) NOT NULL CHECK (number >= 0),
  start_checkpoint NUMERIC(20, 0) NOT NULL CHECK (start_checkpoint >= 0),
  end_checkpoint NUMERIC(20, 0) NOT NULL CHECK (end_checkpoint > start_checkpoint),
  digest TEXT NOT NULL CHECK (digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  disposition TEXT NOT NULL CHECK (disposition IN ('ours', 'recovered', 'mismatch', 'foreign')),
  stored_round UUID REFERENCES presale_reward_rounds (id),
  ledger_outcome TEXT CHECK (ledger_outcome ~ '^[a-z][a-z0-9-]{0,63}$'),
  observed_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (network, round_id),
  UNIQUE (network, vault_id, number)
);

REVOKE ALL ON TABLE presale_reward_rounds, presale_reward_allocations, presale_reward_slots, presale_reward_event_cursors, presale_reward_chain_rounds FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE ON TABLE presale_reward_slots, presale_reward_event_cursors, presale_reward_chain_rounds TO blast_watcher;
-- A round's stored header (interval, root, digest, leaves, amounts, deadline, accounting) is what the rewards key
-- signs: it never changes after the round and its allocations are stored. The worker updates only its progress.
GRANT SELECT, INSERT ON TABLE presale_reward_rounds TO blast_watcher;
GRANT UPDATE (state, blob_url, publish_digest, round_id, published_at, reset_outcome, announced_at, error_class, updated_at) ON TABLE presale_reward_rounds TO blast_watcher;
-- Allocations are written once, with their round: their marks never change.
GRANT SELECT, INSERT ON TABLE presale_reward_allocations TO blast_watcher;
-- The web's manifest and wallet reward routes read the rounds and their allocations.
GRANT SELECT ON TABLE presale_reward_rounds, presale_reward_allocations TO blast_web;
