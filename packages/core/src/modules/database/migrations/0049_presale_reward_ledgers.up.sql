-- Presale (T-025): the `presale-rewards` worker's holder ledger, one per sale
-- coin. Each row holds the SDK's `HolderLedger` JSON
-- (`@interest-protocol/blast-sdk/holder-rewards`) and its watermark: the next
-- checkpoint to apply (`next_checkpoint`), the last applied checkpoint's
-- digest and timestamp. These columns are the ledger's position, overlaid on
-- the JSON when it is loaded. The worker updates the ledger and its watermark
-- in one transaction per applied batch of at most 100 checkpoints, guarded by
-- `revision`, so a killed batch leaves the last committed watermark and a
-- second writer can never interleave. A batch that changed no account moves
-- only the watermark columns: the JSON (the accounts) is written only when it
-- changes.
--
-- A row starts when the sale appears in blast-infra's `GET /v1/presales`.
-- `ledger` stays null until the coin package's creation checkpoint is known;
-- the ledger then starts there. Weight accrues from `vault_checkpoint`, the
-- checkpoint of the vault's `PresaleVaultCreated` (the worker resets weights
-- right after applying it). Until the vault is known, the worker applies
-- nothing past `vault_bound` (blast-infra's position when it last reported the
-- sale unmigrated; null when the bound no longer applies).
--
-- `hold_checkpoint` is a round's end: the worker applies nothing past it, so
-- the round reads weights at exactly that checkpoint; a rebuild keeps it.
-- `reset_checkpoints` are the confirmed rounds' ends, always recorded: weights
-- reset right after each, and a rebuild replays them. A halt (`halted_reason`)
-- stops the coin's ledger until an operator resumes or rebuilds it; only a
-- rebuild clears `vault-passed` and `reset-passed`
-- (docs/presale/runbooks/holder-ledger-rebuild.md). A cancelled sale never
-- has a vault: its ledger stops (`cancelled`).
--
-- Blast's fee destinations come from chain data, per fee policy:
-- `presale_reward_fee_destinations` holds the publisher (the destination
-- `init` sets, with no event) and every `DestinationChanged`, each with the
-- checkpoint it took effect; `presale_reward_fee_policies` how far the
-- policy's history is known. A round ending at E excludes every destination
-- set at or before E, and waits until the history is known through E.
CREATE TABLE presale_reward_ledgers (
  coin_type TEXT PRIMARY KEY CHECK (coin_type ~ '^0x[0-9a-f]{64}::[A-Za-z_][A-Za-z0-9_]*::[A-Za-z_][A-Za-z0-9_]*$'),
  presale_id TEXT NOT NULL UNIQUE CHECK (presale_id ~ '^0x[0-9a-f]{64}$'),
  -- The deployment's fee policy object, whose destinations this coin excludes.
  fee_policy_id TEXT CHECK (fee_policy_id ~ '^0x[0-9a-f]{64}$'),
  cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  creation_checkpoint NUMERIC(20, 0) CHECK (creation_checkpoint >= 0),
  vault_id TEXT CHECK (vault_id ~ '^0x[0-9a-f]{64}$'),
  vault_checkpoint NUMERIC(20, 0) CHECK (vault_checkpoint >= creation_checkpoint),
  vault_bound NUMERIC(20, 0) DEFAULT 0 CHECK (vault_bound >= 0),
  ledger JSONB,
  -- The accounts live in `presale_reward_ledger_accounts` (the JSON's `accounts` is then empty).
  accounts_external BOOLEAN NOT NULL DEFAULT FALSE,
  next_checkpoint NUMERIC(20, 0),
  last_digest TEXT,
  last_timestamp_ms NUMERIC(20, 0),
  hold_checkpoint NUMERIC(20, 0) CHECK (hold_checkpoint >= 0),
  hold_since TIMESTAMPTZ,
  reset_checkpoints NUMERIC(20, 0)[] NOT NULL DEFAULT '{}',
  -- The vault, the presale, its pool, the sponsor and the three worker keys.
  protocol_exclusions TEXT[] NOT NULL DEFAULT '{}',
  -- The vault's configured exclusion list (`npm run presale:reward-ledger -- exclude`).
  excluded_addresses TEXT[] NOT NULL DEFAULT '{}',
  -- Holders that are objects (pools, positions, wrappers): never an address balance.
  object_owners TEXT[] NOT NULL DEFAULT '{}',
  halted_reason TEXT CHECK (halted_reason IN ('gap', 'digest-mismatch', 'negative-balance', 'timestamp-backwards', 'invalid-checkpoint', 'vault-passed', 'reset-passed')),
  halted_checkpoint NUMERIC(20, 0),
  halted_detail TEXT CHECK (char_length(halted_detail) <= 500),
  revision BIGINT NOT NULL DEFAULT 0,
  tracked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((ledger IS NULL) = (next_checkpoint IS NULL)),
  -- The columns are the position; the JSON is rewritten only when an account changes, so its own position may trail them.
  CHECK (ledger IS NULL OR (ledger ->> 'nextCheckpoint')::NUMERIC <= next_checkpoint),
  CHECK (ledger IS NULL OR ledger ->> 'coinType' = coin_type),
  CHECK ((halted_reason IS NULL) = (halted_checkpoint IS NULL)),
  CHECK ((hold_checkpoint IS NULL) = (hold_since IS NULL))
);

-- The accounts of a ledger whose JSON grew past the configured size
-- (`PRESALE_REWARDS_LEDGER_INLINE_MAX_BYTES`): the SDK's account record, one
-- row per holder, written with the ledger row in the same transaction.
CREATE TABLE presale_reward_ledger_accounts (
  coin_type TEXT NOT NULL REFERENCES presale_reward_ledgers (coin_type) ON DELETE CASCADE,
  address TEXT NOT NULL CHECK (address ~ '^0x[0-9a-f]{64}$'),
  balance NUMERIC(20, 0) NOT NULL CHECK (balance >= 0),
  weight NUMERIC NOT NULL CHECK (weight >= 0 AND weight = trunc(weight)),
  timestamp_ms NUMERIC(20, 0) NOT NULL CHECK (timestamp_ms >= 0),
  PRIMARY KEY (coin_type, address)
);

-- How far a fee policy's history is known: its newest version walked, and
-- the checkpoint height of the node that read that head (no change at or
-- before it is missing); both null until the first walk completes. A walk
-- in progress (`walk_*`) continues across passes within each pass's budget:
-- the head it walks from, the height its read saw, the next transaction to
-- read, the destinations found so far, and the steps taken.
CREATE TABLE presale_reward_fee_policies (
  fee_policy_id TEXT PRIMARY KEY CHECK (fee_policy_id ~ '^0x[0-9a-f]{64}$'),
  head_version NUMERIC(20, 0) CHECK (head_version > 0),
  through_checkpoint NUMERIC(20, 0) CHECK (through_checkpoint >= 0),
  walk_head_version NUMERIC(20, 0) CHECK (walk_head_version > 0),
  walk_through NUMERIC(20, 0) CHECK (walk_through >= 0),
  walk_next_digest TEXT CHECK (char_length(walk_next_digest) BETWEEN 1 AND 128),
  walk_found JSONB NOT NULL DEFAULT '[]',
  walk_steps INTEGER NOT NULL DEFAULT 0 CHECK (walk_steps >= 0),
  revision BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK ((head_version IS NULL) = (through_checkpoint IS NULL)),
  CHECK ((walk_head_version IS NULL) = (walk_next_digest IS NULL) AND (walk_head_version IS NULL) = (walk_through IS NULL))
);

-- Every address that has been the policy's destination, from the checkpoint
-- it first became one.
CREATE TABLE presale_reward_fee_destinations (
  fee_policy_id TEXT NOT NULL REFERENCES presale_reward_fee_policies (fee_policy_id) ON DELETE CASCADE,
  address TEXT NOT NULL CHECK (address ~ '^0x[0-9a-f]{64}$'),
  since_checkpoint NUMERIC(20, 0) NOT NULL CHECK (since_checkpoint >= 0),
  digest TEXT NOT NULL CHECK (char_length(digest) BETWEEN 1 AND 128),
  source TEXT NOT NULL CHECK (source IN ('publisher', 'destination-changed')),
  PRIMARY KEY (fee_policy_id, address)
);

REVOKE ALL ON TABLE presale_reward_ledgers, presale_reward_ledger_accounts, presale_reward_fee_policies, presale_reward_fee_destinations FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE presale_reward_ledgers, presale_reward_ledger_accounts, presale_reward_fee_policies, presale_reward_fee_destinations TO blast_watcher;
