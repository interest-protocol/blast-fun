-- Presale holder-reward delivery: the `presale-rewards` role's relay
-- (`presale-reward-relay`) pays each published round's leaves itself, with the
-- rewards key, so holders receive their rewards without claiming. One row per
-- published round (`presale_reward_rounds`, state `published`), opened by the
-- relay; the round's on-chain claimed bitmap, not this row, says which leaves
-- are paid.
--
-- `state`:
-- - `relaying`: leaves marked `relay` (worth at least the Quote's relay
--   minimum) are being paid, in batches;
-- - `waiting`: every `relay` leaf is paid or set aside; only dust
--   (`self_claim`) is unpaid, and the sweep is decided at `next_check_at`
--   (the claim deadline less the sweep lead);
-- - `sweeping`: the sweep found the unpaid dust worth relaying, and every
--   unpaid leaf is paid once;
-- - `delivered` (final): the round paid every leaf;
-- - `ended` (final, `end_reason`): `sweep-skipped` (the dust was not worth
--   relaying: it stays claimable by its holders), `unpayable` (only leaves set
--   aside are left), `deadline` (the claim deadline passed) or `round-closed`
--   (someone closed the round after its deadline).
--
-- `verified_at`: when the round was checked against its stored manifest with
-- the SDK keeper (`pendingRewardAllocations`). `sweep`, `sweep_leaves` and
-- `sweep_value` record the sweep's one decision: the unpaid dust's count and
-- value (Quote atoms at the round's stored price). `relay_digest` is the
-- latest batch, recorded before its bytes were sent; `relay_failures` counts
-- batches that failed on chain since the last one landed (the backoff);
-- `batch_size` is the batch size in force after a shrink; `unpaid_leaves` the
-- leaves set aside as unpayable. `error_class` is kebab-case; abort names go
-- in `blocked_reason`.
CREATE TABLE presale_reward_relays (
  round UUID PRIMARY KEY REFERENCES presale_reward_rounds (id),
  network TEXT NOT NULL CHECK (network ~ '^[a-z][a-z0-9-]{0,31}$'),
  round_id TEXT NOT NULL UNIQUE CHECK (round_id ~ '^0x[0-9a-f]{64}$'),
  state TEXT NOT NULL CHECK (state IN ('relaying', 'waiting', 'sweeping', 'delivered', 'ended')),
  verified_at TIMESTAMPTZ,
  sweep TEXT CHECK (sweep IN ('relay', 'skip')),
  sweep_leaves INTEGER CHECK (sweep_leaves BETWEEN 0 AND 65536),
  sweep_value NUMERIC(40, 0) CHECK (sweep_value >= 0),
  relay_digest TEXT CHECK (relay_digest ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  relay_batches INTEGER NOT NULL DEFAULT 0 CHECK (relay_batches >= 0),
  relay_failures INTEGER NOT NULL DEFAULT 0 CHECK (relay_failures >= 0),
  batch_size INTEGER CHECK (batch_size BETWEEN 1 AND 120),
  blocked_reason TEXT CHECK (char_length(blocked_reason) BETWEEN 1 AND 200),
  unpaid_leaves INTEGER[] NOT NULL DEFAULT '{}' CHECK (array_position(unpaid_leaves, NULL) IS NULL),
  end_reason TEXT CHECK (end_reason IN ('sweep-skipped', 'unpayable', 'deadline', 'round-closed')),
  error_class TEXT CHECK (error_class ~ '^[a-z][a-z0-9-]{0,63}$'),
  next_check_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  ended_at TIMESTAMPTZ,
  CHECK ((state IN ('delivered', 'ended')) = (ended_at IS NOT NULL)),
  CHECK ((state = 'ended') = (end_reason IS NOT NULL)),
  CHECK ((sweep IS NULL) = (sweep_leaves IS NULL) AND (sweep IS NULL) = (sweep_value IS NULL)),
  CHECK (state <> 'sweeping' OR sweep = 'relay')
);

-- The relays each pass visits.
CREATE INDEX presale_reward_relays_due ON presale_reward_relays (network, next_check_at) WHERE ended_at IS NULL;

-- `presale_reward_relay_leaves`: why each unpaid leaf of an open relay is
-- still waiting, for the web's Rewards page: `next` (the relay sends it on a
-- coming pass), `dust` (worth less than the relay minimum: it waits for the
-- sweep, and its holder may claim it meanwhile) or `unpayable` (the relay set
-- it aside; its holder claims it). The relay rewrites the set from the
-- round's claimed bitmap as it reads it: a paid leaf's row is deleted, and an
-- ended relay's rows all go. `decided_at` is when the reason was last set.
CREATE TABLE presale_reward_relay_leaves (
  round UUID NOT NULL REFERENCES presale_reward_relays (round),
  leaf_index INTEGER NOT NULL CHECK (leaf_index BETWEEN 0 AND 65535),
  beneficiary TEXT NOT NULL CHECK (beneficiary ~ '^0x[0-9a-f]{64}$'),
  reason TEXT NOT NULL CHECK (reason IN ('next', 'dust', 'unpayable')),
  decided_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (round, leaf_index)
);

CREATE INDEX presale_reward_relay_leaves_beneficiary ON presale_reward_relay_leaves (beneficiary);

REVOKE ALL ON TABLE presale_reward_relays, presale_reward_relay_leaves FROM PUBLIC;
-- The rewards worker's alone: inserted and updated, never deleted.
GRANT SELECT, INSERT, UPDATE ON TABLE presale_reward_relays TO blast_watcher;
-- The worker keeps the waiting set; the web's Rewards page reads it.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE presale_reward_relay_leaves TO blast_watcher;
GRANT SELECT ON TABLE presale_reward_relay_leaves TO blast_web;
