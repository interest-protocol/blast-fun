import type { Pool } from "pg";

/**
 * Test fixtures for the shared-database roles. Test-only, like testing.ts.
 */
export const ROLES = [
  "blast_indexer",
  "blast_migration",
  "blast_web",
  "blast_watcher",
  "blast_social",
  "blast_replica",
] as const;
export type Role = (typeof ROLES)[number];

/** The same database as a runtime login that holds `role`: a distinct connection string. */
export function urlAs(databaseUrl: string, role: Role): string {
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c role=${role}`);
  return url.toString();
}

/** The fixture's committed checkpoint, chain id (hex), network and SDK deployment fingerprint. */
export const FIXTURE_CHECKPOINT = 326_274_009;
export const FIXTURE_CHAIN_ID = "35834a8a";
export const FIXTURE_NETWORK = "mainnet";
export const FIXTURE_FINGERPRINT =
  "5d2f2a4be1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c";

/** This reduced fixture's complete inventory; daily-reward suites provide their own additional views. */
export const CHAIN_FIXTURE_VIEWS = [
  "chain_read_v1.activity",
  "chain_read_v1.blast_pnl_activity",
  "chain_read_v1.blast_pnl_period",
  "chain_read_v1.checkpoint_headers",
  "chain_read_v1.coin_balances",
  "chain_read_v1.wallet_balances",
  "chain_read_v1.wallet_sync",
  "chain_read_v1.coin_holder_history",
  "chain_read_v1.coin_metadata",
  "chain_read_v1.coin_unavailable",
  "chain_read_v1.coins",
  "chain_read_v1.presale_coin_supply",
  "chain_read_v1.lifecycle_planning",
  "chain_read_v1.pool_reserves",
  "chain_read_v1.pools",
  "chain_read_v1.presale_lifecycle",
  "chain_read_v1.presale_pool_price_history",
  "chain_read_v1.presale_pool_prices",
  "chain_read_v1.presale_pool_swaps",
  "chain_read_v1.presale_positions",
  "chain_read_v1.presales",
  "chain_read_v1.price_history",
  "chain_read_v1.prices",
  "chain_read_v1.projection_coverage",
  "chain_read_v1.transaction_evidence",
  "chain_read_v1.vesting_schedules",
  "chain_read_v1.vault_rounds",
  "chain_read_v1.vault_reward_payouts",
  "chain_read_v1.vaults",
  "chain_read_v1.watermark",
] as const;

/**
 * Native intake/cut gates mirror the shared-intake migration; fixture transaction
 * evidence is explicitly supplied by tests in the production view format.
 * blast-infra's `2026-09-30-000000_database_roles` and
 * `2026-09-30-100000_chain_read_views` over a reduced chain schema, mirrored
 * from blast-infra `lst/T-003-1@0de1de7`; review it when either migration
 * changes (the one-off cross-repository grant check compared them). Like the
 * first it creates the six roles when missing and grants `blast_indexer` to
 * `blast_migration`, guarded because roles and memberships are cluster-wide
 * and other databases race to create them, so the fixture holds on a fresh
 * server. `blast_indexer` owns the tables and keeps CREATE on `public`. Like
 * the second, the engine's `deployment_identity` names the indexed deployment,
 * the `chain_read_v1` views (the same definitions) are the only chain
 * relations the four readers may read, and the framework's `watermarks` row
 * says which checkpoint the data reaches (committed now).
 *
 * The presale views mirror blast-infra `sfd/integration@48f54df` exactly
 * (column names, order, types and nullability): `presales`,
 * `presale_lifecycle`, `presale_positions` and `prices` from its migration
 * `2026-10-05-000000_chain_read_presale` (T-034), `vesting_schedules` from
 * `2026-10-06-000000_presale_vesting` (T-036, OA-18) with the steps of
 * `2026-12-19-000000_vesting_schedule_periods`, and the watermark's
 * appended per-pipeline columns. Remaining claims mirror
 * `2026-10-27-000000_presale_claimable_positions`. `price_history` mirrors blast-infra's
 * `2026-10-09-000000_chain_read_price_history` and its sale-coin rows of
 * `2026-10-18-000000_sale_coin_price_history` (R3-20, integration c81c5fd;
 * the six columns, their order and the tiers): one row per coin, tier (`5m`,
 * `1h`, `1d`) and epoch-aligned bucket, the price at its end and that
 * price's own time, `source` `pyth` (a quote coin) or `pool` (a sale coin);
 * the fixture keeps the rows in one table keyed `(coin_type, resolution,
 * bucket_ms)`, the order of blast-infra's keys. Their real semantics, which every reader
 * handles: `sale_*` is NULL until the sale coin's metadata is seen,
 * `quote_*` NULL for a quote the engine's quote table omits, `venue` NULL
 * for a migration witness other than Cetus's or Bluefin's; `start_ms` and
 * `end_ms` are 0 until the sale opens; an allowlisted sale has
 * `min_commitment` 1 and `wallet_cap` NULL; `last_commit_ms` is NULL for a
 * position known only from its claim; Pyth prices have one-second
 * `as_of_ms`; vesting `cliff_ms` and `end_ms` are NUMERIC (beyond BIGINT).
 * `activity` (T-033), `coin_balances`, `coin_holder_history` and pool
 * `prices` rows (T-037) still mirror the social feed's contract (social-feed
 * T-001) until blast-infra publishes them; `activity`'s slots are blast-infra's
 * u32 cursor parts as its view publishes them (BIGINT, so a T-038 trade row's
 * `event_slot` 4294967295 fits). Rows live in the test-only
 * `blast_infra_fixture` schema, which `chain-read-rows.ts` seeds; the fixture
 * starts them empty.
 */
export const CHAIN_FIXTURE = `
  DO $$
  DECLARE
    name TEXT;
  BEGIN
    FOREACH name IN ARRAY ARRAY[
      'blast_migration', 'blast_indexer', 'blast_web', 'blast_watcher', 'blast_social', 'blast_replica'
    ] LOOP
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = name) THEN
        BEGIN
          EXECUTE format('CREATE ROLE %I NOLOGIN', name);
        EXCEPTION WHEN duplicate_object OR unique_violation THEN
          NULL;
        END;
      END IF;
    END LOOP;
    IF NOT EXISTS (
      SELECT FROM pg_auth_members
      WHERE roleid = 'blast_indexer'::regrole AND member = 'blast_migration'::regrole
    ) THEN
      BEGIN
        GRANT blast_indexer TO blast_migration WITH INHERIT TRUE, SET TRUE;
      EXCEPTION WHEN unique_violation THEN
        NULL;
      END;
    END IF;
  END
  $$;
  CREATE TABLE coins (
    coin_type TEXT PRIMARY KEY,
    decimals SMALLINT NOT NULL,
    launcher TEXT NOT NULL,
    creator TEXT,
    metadata JSONB,
    pool_key TEXT,
    created_checkpoint BIGINT NOT NULL,
    created_at_ms BIGINT NOT NULL,
    currency_supply NUMERIC NOT NULL DEFAULT 0,
    balance_0x0 NUMERIC NOT NULL DEFAULT 0
  );
  CREATE TABLE presale_coin_metadata (coin_type TEXT PRIMARY KEY, total_supply NUMERIC);
  CREATE TABLE pools (
    pool_key TEXT PRIMARY KEY,
    venue TEXT NOT NULL,
    coin_type TEXT NOT NULL,
    quote_type TEXT NOT NULL,
    lifecycle TEXT NOT NULL,
    created_checkpoint BIGINT NOT NULL,
    created_at_ms BIGINT NOT NULL,
    quote_reserve NUMERIC,
    params JSONB
  );
  CREATE TABLE watermarks (
    pipeline TEXT PRIMARY KEY,
    epoch_hi_inclusive BIGINT NOT NULL,
    checkpoint_hi_inclusive BIGINT NOT NULL,
    tx_hi BIGINT NOT NULL,
    timestamp_ms_hi_inclusive BIGINT NOT NULL,
    reader_lo BIGINT NOT NULL,
    pruner_timestamp TIMESTAMP NOT NULL,
    pruner_hi BIGINT NOT NULL,
    chain_id BYTEA
  );
  CREATE TABLE deployment_identity (
    singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
    network TEXT NOT NULL,
    deployment_fingerprint TEXT NOT NULL
  );
  GRANT USAGE, CREATE ON SCHEMA public TO blast_indexer;
  ALTER TABLE coins OWNER TO blast_indexer;
  ALTER TABLE presale_coin_metadata OWNER TO blast_indexer;
  ALTER TABLE pools OWNER TO blast_indexer;
  ALTER TABLE watermarks OWNER TO blast_indexer;
  ALTER TABLE deployment_identity OWNER TO blast_indexer;
  REVOKE ALL ON coins, pools, watermarks, deployment_identity
    FROM PUBLIC, blast_web, blast_watcher, blast_social, blast_replica;

  CREATE SCHEMA chain_read_v1;
  REVOKE ALL ON SCHEMA chain_read_v1 FROM PUBLIC;
  GRANT USAGE, CREATE ON SCHEMA chain_read_v1 TO blast_indexer;
  GRANT USAGE ON SCHEMA chain_read_v1 TO blast_web, blast_watcher, blast_social, blast_replica;
  CREATE VIEW chain_read_v1.coins AS
  SELECT coin_type, metadata ->> 'name' AS name, metadata ->> 'symbol' AS symbol,
    metadata ->> 'description' AS description, metadata ->> 'icon_url' AS icon_url,
    decimals, launcher, creator, pool_key, created_checkpoint, created_at_ms,
    greatest(currency_supply - balance_0x0, 0) AS supply, currency_supply AS total_supply
  FROM public.coins;
  CREATE VIEW chain_read_v1.presale_coin_supply AS
  SELECT coin_type, total_supply FROM presale_coin_metadata WHERE total_supply IS NOT NULL;
  CREATE VIEW chain_read_v1.pools AS
  SELECT pool_key, venue, split_part(pool_key, ':', 2) AS pool_id, coin_type, quote_type, lifecycle,
    created_checkpoint, created_at_ms, quote_reserve::NUMERIC AS quote_reserve,
    (params->>'graduation_target')::NUMERIC AS graduation_target
  FROM public.pools;
  CREATE VIEW chain_read_v1.watermark AS
  SELECT d.network, d.deployment_fingerprint, encode(w.chain_id, 'hex') AS chain_id,
    w.checkpoint_hi_inclusive AS checkpoint, w.timestamp_ms_hi_inclusive AS timestamp_ms,
    (extract(epoch FROM statement_timestamp()) * 1000)::BIGINT AS observed_ms,
    CASE WHEN w.timestamp_ms_hi_inclusive IS NOT NULL THEN greatest(
      (extract(epoch FROM statement_timestamp()) * 1000)::BIGINT - w.timestamp_ms_hi_inclusive, 0
    ) END AS lag_ms,
    w.checkpoint_hi_inclusive AS market_checkpoint, w.timestamp_ms_hi_inclusive AS market_timestamp_ms,
    p.checkpoint_hi_inclusive AS presale_checkpoint, p.timestamp_ms_hi_inclusive AS presale_timestamp_ms
  FROM public.deployment_identity d
  LEFT JOIN public.watermarks w ON w.pipeline = 'market' AND w.reader_lo <= w.checkpoint_hi_inclusive
  LEFT JOIN public.watermarks p ON p.pipeline = 'presale' AND p.reader_lo <= p.checkpoint_hi_inclusive;
  ALTER VIEW chain_read_v1.coins OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.presale_coin_supply OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.pools OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.watermark OWNER TO blast_indexer;
  REVOKE ALL ON chain_read_v1.coins, chain_read_v1.presale_coin_supply, chain_read_v1.pools, chain_read_v1.watermark FROM PUBLIC;
  GRANT SELECT ON chain_read_v1.coins, chain_read_v1.presale_coin_supply, chain_read_v1.pools, chain_read_v1.watermark
    TO blast_web, blast_watcher, blast_social, blast_replica;

-- Native evidence is committed before any domain decoder sees it. It is not part of
-- the yearly projection archive: unfinished consumers must retain their replay inputs.
CREATE TABLE checkpoint_journal (
    checkpoint BIGINT PRIMARY KEY CHECK (checkpoint >= 0),
    network TEXT NOT NULL,
    digest TEXT NOT NULL UNIQUE,
    previous_digest TEXT,
    epoch BIGINT NOT NULL CHECK (epoch >= 0),
    timestamp_ms BIGINT NOT NULL CHECK (timestamp_ms >= 0),
    total_transactions BIGINT NOT NULL CHECK (total_transactions >= 0),
    format_version INTEGER NOT NULL CHECK (format_version = 1),
    payload BYTEA NOT NULL CHECK (octet_length(payload) <= 134217728),
    payload_hash BYTEA NOT NULL CHECK (octet_length(payload_hash) = 32)
);

CREATE TABLE native_transactions (
    checkpoint BIGINT NOT NULL REFERENCES checkpoint_journal(checkpoint),
    tx_slot BIGINT NOT NULL CHECK (tx_slot > 0),
    tx_digest TEXT NOT NULL UNIQUE,
    sender TEXT NOT NULL,
    gas_owner TEXT NOT NULL,
    success BOOLEAN NOT NULL,
    net_gas BIGINT NOT NULL,
    PRIMARY KEY (checkpoint, tx_slot)
);

CREATE TABLE native_events (
    checkpoint BIGINT NOT NULL,
    tx_slot BIGINT NOT NULL,
    event_slot BIGINT NOT NULL CHECK (event_slot >= 0),
    package TEXT NOT NULL,
    event_type TEXT NOT NULL,
    sender TEXT NOT NULL,
    bcs BYTEA NOT NULL,
    PRIMARY KEY (checkpoint, tx_slot, event_slot),
    FOREIGN KEY (checkpoint, tx_slot) REFERENCES native_transactions(checkpoint, tx_slot)
);

CREATE TABLE projection_faults (
    pipeline TEXT PRIMARY KEY,
    checkpoint BIGINT NOT NULL CHECK (checkpoint >= 0),
    event_type TEXT NOT NULL,
    reason TEXT NOT NULL
);

ALTER TABLE checkpoint_journal OWNER TO blast_indexer;
ALTER TABLE native_transactions OWNER TO blast_indexer;
ALTER TABLE native_events OWNER TO blast_indexer;
ALTER TABLE projection_faults OWNER TO blast_indexer;

CREATE VIEW chain_read_v1.projection_coverage AS
SELECT w.pipeline, d.network, d.deployment_fingerprint,
       CASE WHEN w.reader_lo <= w.checkpoint_hi_inclusive
            THEN w.checkpoint_hi_inclusive END AS checkpoint,
       CASE WHEN w.reader_lo <= w.checkpoint_hi_inclusive
            THEN w.timestamp_ms_hi_inclusive END AS timestamp_ms,
       j.digest AS checkpoint_digest, w.reader_lo AS first_checkpoint,
       f.checkpoint AS fault_checkpoint, f.event_type AS fault_event_type, f.reason AS fault_reason
FROM watermarks w CROSS JOIN deployment_identity d
LEFT JOIN projection_faults f ON f.pipeline = w.pipeline
LEFT JOIN checkpoint_journal j ON j.checkpoint = w.checkpoint_hi_inclusive;

ALTER VIEW chain_read_v1.projection_coverage OWNER TO blast_indexer;
REVOKE ALL ON chain_read_v1.projection_coverage FROM PUBLIC;
GRANT SELECT ON chain_read_v1.projection_coverage TO blast_web, blast_watcher, blast_social, blast_replica;

-- Call inside the same repeatable-read transaction as the data reads. On a replica,
-- absent/lagged rows raise an error; they cannot be mistaken for a zero balance.
CREATE FUNCTION chain_read_v1.require_cut(
    expected_network TEXT, expected_fingerprint TEXT, at_checkpoint BIGINT, expected_digest TEXT, projections TEXT[]
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, pg_catalog AS $$
BEGIN
    IF current_setting('transaction_isolation') NOT IN ('repeatable read', 'serializable') THEN
        RAISE EXCEPTION 'cut-bound reads require a repeatable-read transaction';
    END IF;
    IF at_checkpoint IS NULL OR at_checkpoint < 0 OR expected_network IS NULL OR expected_digest IS NULL
       OR projections IS NULL OR cardinality(projections) = 0
       OR array_position(projections, NULL) IS NOT NULL THEN
        RAISE EXCEPTION 'invalid complete cut';
    END IF;
    IF NOT EXISTS (SELECT FROM deployment_identity WHERE network = expected_network
                   AND deployment_fingerprint IS NOT DISTINCT FROM expected_fingerprint) THEN
        RAISE EXCEPTION 'deployment identity does not match the requested cut';
    END IF;
    IF NOT EXISTS (SELECT FROM checkpoint_journal
                   WHERE checkpoint = at_checkpoint AND network = expected_network
                     AND digest = expected_digest) THEN
        RAISE EXCEPTION 'native checkpoint cut is unavailable';
    END IF;
    IF EXISTS (
        SELECT FROM unnest(projections || ARRAY['intake']) requested(pipeline)
        LEFT JOIN chain_read_v1.projection_coverage coverage USING (pipeline)
        WHERE coverage.network IS DISTINCT FROM expected_network
           OR coverage.checkpoint IS NULL OR coverage.checkpoint < at_checkpoint
           OR coverage.first_checkpoint > at_checkpoint
           OR coverage.fault_checkpoint <= at_checkpoint
    ) THEN
        RAISE EXCEPTION 'required projection cut is unavailable or faulty';
    END IF;
END
$$;

ALTER FUNCTION chain_read_v1.require_cut(TEXT, TEXT, BIGINT, TEXT, TEXT[]) OWNER TO blast_indexer;
REVOKE ALL ON FUNCTION chain_read_v1.require_cut(TEXT, TEXT, BIGINT, TEXT, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION chain_read_v1.require_cut(TEXT, TEXT, BIGINT, TEXT, TEXT[])
TO blast_web, blast_watcher, blast_social, blast_replica;

  CREATE SCHEMA blast_infra_fixture AUTHORIZATION blast_indexer;
  REVOKE ALL ON SCHEMA blast_infra_fixture FROM PUBLIC;
  CREATE TABLE blast_infra_fixture.transaction_evidence (
    digest TEXT PRIMARY KEY,
    checkpoint BIGINT NOT NULL REFERENCES checkpoint_journal(checkpoint),
    timestamp_ms BIGINT NOT NULL,
    sender TEXT NOT NULL,
    success BOOLEAN NOT NULL,
    events JSONB NOT NULL CHECK (jsonb_typeof(events) = 'array')
  );
  ALTER TABLE blast_infra_fixture.transaction_evidence OWNER TO blast_indexer;
  CREATE VIEW chain_read_v1.transaction_evidence AS
  SELECT digest, checkpoint, timestamp_ms, sender, success, events
  FROM blast_infra_fixture.transaction_evidence;
  ALTER VIEW chain_read_v1.transaction_evidence OWNER TO blast_indexer;
  REVOKE ALL ON chain_read_v1.transaction_evidence FROM PUBLIC;
  GRANT SELECT ON chain_read_v1.transaction_evidence TO blast_web, blast_watcher, blast_social, blast_replica;
  CREATE TABLE blast_infra_fixture.activity (
    checkpoint BIGINT NOT NULL,
    tx_slot BIGINT NOT NULL CHECK (tx_slot BETWEEN 0 AND 4294967295),
    event_slot BIGINT NOT NULL CHECK (event_slot BETWEEN 0 AND 4294967295),
    part BIGINT NOT NULL CHECK (part BETWEEN 0 AND 4294967295),
    timestamp_ms BIGINT NOT NULL,
    digest TEXT NOT NULL,
    kind TEXT NOT NULL,
    product TEXT NOT NULL,
    actor TEXT NOT NULL,
    tx_sender TEXT NOT NULL,
    presale_id TEXT,
    coin_type TEXT,
    quote_type TEXT NOT NULL,
    quote_amount NUMERIC NOT NULL,
    coin_amount NUMERIC,
    quote_refund NUMERIC,
    usd_value NUMERIC,
    usd_price_as_of_ms BIGINT,
    venue TEXT,
    participants_after BIGINT,
    total_commitments_after NUMERIC,
    market_cap_usd NUMERIC,
    PRIMARY KEY (checkpoint, tx_slot, event_slot, part)
  );
  CREATE TABLE blast_infra_fixture.presale_lifecycle (
    presale_id TEXT NOT NULL,
    state TEXT NOT NULL,
    digest TEXT NOT NULL,
    timestamp_ms BIGINT NOT NULL,
    checkpoint BIGINT NOT NULL,
    PRIMARY KEY (presale_id, state)
  );
  -- Reduced Home coin-discovery projection of the standalone vault reader.
  CREATE TABLE blast_infra_fixture.vaults (
    vault_id TEXT PRIMARY KEY, presale_id TEXT, meme_type TEXT NOT NULL,
    name TEXT, symbol TEXT, icon_url TEXT, decimals SMALLINT,
    venue_type TEXT NOT NULL, pool_id TEXT NOT NULL, quote_type TEXT NOT NULL,
    quote_symbol TEXT, quote_decimals SMALLINT, created_checkpoint BIGINT NOT NULL,
    canonical_market_pool BOOLEAN NOT NULL DEFAULT TRUE,
    origin_kind TEXT NOT NULL DEFAULT 'launch', origin_id TEXT UNIQUE,
    venue TEXT NOT NULL DEFAULT 'cetus', created_tx_slot INTEGER NOT NULL DEFAULT 0,
    created_event_slot INTEGER NOT NULL DEFAULT 0, fee_split JSONB NOT NULL DEFAULT '{"routes":[]}'
  );
  CREATE VIEW chain_read_v1.vaults AS SELECT * FROM blast_infra_fixture.vaults;
  ALTER VIEW chain_read_v1.vaults OWNER TO blast_indexer;
  GRANT SELECT ON blast_infra_fixture.vaults TO blast_indexer;
  REVOKE ALL ON chain_read_v1.vaults FROM PUBLIC;
  GRANT SELECT ON chain_read_v1.vaults TO blast_web, blast_watcher, blast_social, blast_replica;
  CREATE TABLE blast_infra_fixture.vault_rounds (
    round_id TEXT PRIMARY KEY, vault_id TEXT NOT NULL REFERENCES blast_infra_fixture.vaults,
    number NUMERIC NOT NULL, UNIQUE (vault_id, number)
  );
  CREATE TABLE blast_infra_fixture.vault_reward_payouts (
    round_id TEXT NOT NULL REFERENCES blast_infra_fixture.vault_rounds,
    index NUMERIC NOT NULL, vault_id TEXT NOT NULL REFERENCES blast_infra_fixture.vaults,
    beneficiary TEXT NOT NULL, meme_amount NUMERIC NOT NULL, quote_amount NUMERIC NOT NULL,
    checkpoint BIGINT NOT NULL, tx_slot INTEGER NOT NULL, event_slot INTEGER NOT NULL,
    timestamp_ms BIGINT NOT NULL, tx_digest TEXT NOT NULL, relayed_by TEXT,
    PRIMARY KEY (round_id, index)
  );
  CREATE VIEW chain_read_v1.vault_rounds AS SELECT * FROM blast_infra_fixture.vault_rounds;
  CREATE VIEW chain_read_v1.vault_reward_payouts AS SELECT * FROM blast_infra_fixture.vault_reward_payouts;
  ALTER TABLE blast_infra_fixture.vault_rounds OWNER TO blast_indexer;
  ALTER TABLE blast_infra_fixture.vault_reward_payouts OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.vault_rounds OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.vault_reward_payouts OWNER TO blast_indexer;
  REVOKE ALL ON chain_read_v1.vault_rounds, chain_read_v1.vault_reward_payouts FROM PUBLIC;
  GRANT SELECT ON chain_read_v1.vault_rounds, chain_read_v1.vault_reward_payouts
    TO blast_web, blast_watcher, blast_social, blast_replica;
  CREATE TABLE blast_infra_fixture.presales (
    presale_id TEXT PRIMARY KEY,
    creator TEXT,
    created_at_ms BIGINT,
    sale_token TEXT NOT NULL,
    quote_type TEXT NOT NULL,
    sale_symbol TEXT,
    sale_name TEXT,
    sale_icon_url TEXT,
    sale_decimals SMALLINT,
    quote_symbol TEXT,
    quote_decimals SMALLINT,
    lifecycle TEXT NOT NULL CHECK (lifecycle IN ('pending', 'open', 'funded', 'migrated', 'cancelled')),
    start_ms BIGINT NOT NULL,
    liquidity_deadline_ms NUMERIC,
    pool_creation_id TEXT,
    end_ms BIGINT NOT NULL,
    raise_target NUMERIC NOT NULL,
    min_commitment NUMERIC NOT NULL,
    wallet_cap NUMERIC,
    total_commitments NUMERIC NOT NULL,
    participants BIGINT NOT NULL,
    -- aftermath: the Aftermath DAO-pool vendor (blast-infra's generation-2 view), whose pool_id is the AMM pool.
    venue TEXT CHECK (venue IN ('cetus', 'bluefin', 'aftermath')),
    pool_id TEXT,
    updated_checkpoint BIGINT NOT NULL,
    partner_id TEXT,
    -- The sale coin's metadata arrives as one row, and so does the quote's.
    CHECK (num_nulls(sale_symbol, sale_name, sale_icon_url, sale_decimals) IN (0, 4)),
    CHECK (num_nulls(quote_symbol, quote_decimals) IN (0, 2))
  );
  CREATE TABLE blast_infra_fixture.presale_positions (
    presale_id TEXT NOT NULL,
    wallet TEXT NOT NULL,
    commitment NUMERIC NOT NULL,
    last_commit_ms BIGINT,
    claim_digest TEXT,
    claimed_tokens NUMERIC,
    claimed_quote_refund NUMERIC,
    claimed_ms BIGINT,
    claimable_tokens NUMERIC,
    claimable_quote_refund NUMERIC,
    participant_vesting JSONB,
    claim_vesting_id TEXT,
    PRIMARY KEY (presale_id, wallet)
  );
  CREATE TABLE blast_infra_fixture.coin_balances (
    coin_type TEXT NOT NULL,
    owner TEXT NOT NULL,
    balance NUMERIC NOT NULL,
    updated_checkpoint BIGINT NOT NULL,
    PRIMARY KEY (coin_type, owner)
  );
  CREATE TABLE blast_infra_fixture.coin_holder_history (
    coin_type TEXT NOT NULL,
    checkpoint BIGINT NOT NULL,
    timestamp_ms BIGINT NOT NULL,
    holders BIGINT NOT NULL,
    PRIMARY KEY (coin_type, checkpoint)
  );
  CREATE TABLE blast_infra_fixture.prices (
    coin_type TEXT PRIMARY KEY,
    usd_price NUMERIC NOT NULL,
    as_of_ms BIGINT NOT NULL,
    source TEXT NOT NULL
  );
  -- blast-infra's usd_price_buckets keyed as the view reads it: one coin's tier over a range of buckets.
  CREATE TABLE blast_infra_fixture.price_history (
    coin_type TEXT NOT NULL,
    resolution TEXT NOT NULL CHECK (resolution IN ('5m', '1h', '1d')),
    bucket_ms BIGINT NOT NULL,
    usd_price NUMERIC NOT NULL,
    as_of_ms BIGINT NOT NULL,
    source TEXT NOT NULL,
    CHECK (bucket_ms % CASE resolution WHEN '5m' THEN 300000 WHEN '1h' THEN 3600000 ELSE 86400000 END = 0),
    CHECK (as_of_ms >= bucket_ms AND as_of_ms < bucket_ms + CASE resolution WHEN '5m' THEN 300000 WHEN '1h' THEN 3600000 ELSE 86400000 END),
    PRIMARY KEY (coin_type, resolution, bucket_ms)
  );
  CREATE TABLE blast_infra_fixture.vesting_schedules (
    schedule_id TEXT PRIMARY KEY,
    presale_id TEXT NOT NULL,
    beneficiary TEXT NOT NULL,
    total NUMERIC NOT NULL,
    claimed NUMERIC NOT NULL,
    start_ms BIGINT NOT NULL,
    cliff_ms NUMERIC NOT NULL,
    end_ms NUMERIC NOT NULL,
    share TEXT NOT NULL DEFAULT 'token',
    asset TEXT NOT NULL DEFAULT 'sale_token',
    period_ms NUMERIC,
    periods NUMERIC,
    CHECK (start_ms + cliff_ms <= end_ms)
  );
  ALTER TABLE blast_infra_fixture.activity OWNER TO blast_indexer;
  ALTER TABLE blast_infra_fixture.presale_lifecycle OWNER TO blast_indexer;
  ALTER TABLE blast_infra_fixture.presales OWNER TO blast_indexer;
  ALTER TABLE blast_infra_fixture.presale_positions OWNER TO blast_indexer;
  ALTER TABLE blast_infra_fixture.coin_balances OWNER TO blast_indexer;
  ALTER TABLE blast_infra_fixture.coin_holder_history OWNER TO blast_indexer;
  ALTER TABLE blast_infra_fixture.prices OWNER TO blast_indexer;
  ALTER TABLE blast_infra_fixture.vesting_schedules OWNER TO blast_indexer;
  ALTER TABLE blast_infra_fixture.price_history OWNER TO blast_indexer;

  CREATE VIEW chain_read_v1.activity AS
  SELECT checkpoint || ':' || tx_slot || ':' || event_slot || ':' || part AS activity_id,
    checkpoint, tx_slot, event_slot, part, timestamp_ms, digest, kind, product, actor, tx_sender,
    presale_id, coin_type, quote_type, quote_amount, coin_amount, quote_refund, usd_value, usd_price_as_of_ms,
    venue, participants_after, total_commitments_after, market_cap_usd
  FROM blast_infra_fixture.activity;
  CREATE TABLE blast_infra_fixture.pnl_accounting_period (
    singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
    first_checkpoint bigint
  );
  INSERT INTO blast_infra_fixture.pnl_accounting_period VALUES(true,1);
  ALTER TABLE blast_infra_fixture.pnl_accounting_period OWNER TO blast_indexer;
  CREATE VIEW chain_read_v1.blast_pnl_period AS
    SELECT first_checkpoint FROM blast_infra_fixture.pnl_accounting_period WHERE first_checkpoint IS NOT NULL;
  ALTER VIEW chain_read_v1.blast_pnl_period OWNER TO blast_indexer;
  REVOKE ALL ON chain_read_v1.blast_pnl_period FROM PUBLIC;
  GRANT SELECT ON chain_read_v1.blast_pnl_period TO blast_web, blast_watcher, blast_social, blast_replica;
  CREATE VIEW chain_read_v1.blast_pnl_activity AS
    SELECT a.*, a.kind <> 'trade_unresolved' AND NOT (a.event_slot = 4294967295 AND EXISTS (
      SELECT 1 FROM blast_infra_fixture.activity native
      WHERE native.checkpoint = a.checkpoint AND native.tx_slot = a.tx_slot
        AND native.event_slot <> 4294967295
        AND native.coin_type = a.coin_type AND native.kind <> a.kind
        AND native.kind IN ('trade_buy', 'trade_sell')
    )) AS accounting_complete FROM chain_read_v1.activity a
    CROSS JOIN blast_infra_fixture.pnl_accounting_period period
    WHERE a.checkpoint >= period.first_checkpoint;
  ALTER VIEW chain_read_v1.blast_pnl_activity OWNER TO blast_indexer;
  REVOKE ALL ON chain_read_v1.blast_pnl_activity FROM PUBLIC;
  GRANT SELECT ON chain_read_v1.blast_pnl_activity TO blast_web, blast_watcher, blast_social, blast_replica;
  CREATE VIEW chain_read_v1.presale_lifecycle AS
  SELECT presale_id, state, digest, timestamp_ms, checkpoint FROM blast_infra_fixture.presale_lifecycle;
  CREATE VIEW chain_read_v1.presales AS
  SELECT presale_id, sale_token, quote_type, sale_symbol, sale_name, sale_icon_url, sale_decimals, quote_symbol,
    quote_decimals, lifecycle, start_ms, end_ms, raise_target, min_commitment, wallet_cap, total_commitments,
    participants, venue, pool_id, updated_checkpoint, creator, created_at_ms, partner_id
  FROM blast_infra_fixture.presales;
  CREATE TABLE blast_infra_fixture.coin_metadata (
    coin_type TEXT PRIMARY KEY,
    name TEXT,
    symbol TEXT,
    description TEXT,
    icon_url TEXT,
    decimals SMALLINT
  );
  CREATE VIEW chain_read_v1.coin_metadata AS
  SELECT coin_type, name, symbol, description, icon_url, decimals FROM blast_infra_fixture.coin_metadata;
  CREATE TABLE blast_infra_fixture.coin_unavailable (
    coin_type TEXT PRIMARY KEY, scope TEXT, reason TEXT, detail TEXT, event_type TEXT,
    checkpoint BIGINT, tx_slot BIGINT, event_slot BIGINT, since_ms BIGINT
  );
  CREATE VIEW chain_read_v1.coin_unavailable AS SELECT * FROM blast_infra_fixture.coin_unavailable;
  ALTER TABLE blast_infra_fixture.coin_unavailable OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.coin_unavailable OWNER TO blast_indexer;
  REVOKE ALL ON chain_read_v1.coin_unavailable FROM PUBLIC;
  GRANT SELECT ON chain_read_v1.coin_unavailable TO blast_web, blast_watcher, blast_social, blast_replica;
  ALTER TABLE blast_infra_fixture.coin_metadata OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.coin_metadata OWNER TO blast_indexer;
  REVOKE ALL ON chain_read_v1.coin_metadata FROM PUBLIC;
  GRANT SELECT ON chain_read_v1.coin_metadata TO blast_web, blast_watcher, blast_social, blast_replica;
  CREATE VIEW chain_read_v1.lifecycle_planning AS
  SELECT presale_id,sale_token,quote_type,lifecycle,venue,end_ms,liquidity_deadline_ms,pool_creation_id,updated_checkpoint
  FROM blast_infra_fixture.presales;
  ALTER VIEW chain_read_v1.lifecycle_planning OWNER TO blast_indexer;
  REVOKE ALL ON chain_read_v1.lifecycle_planning FROM PUBLIC;
  GRANT SELECT ON chain_read_v1.lifecycle_planning TO blast_web,blast_watcher,blast_social,blast_replica;
  CREATE VIEW chain_read_v1.presale_positions AS
  SELECT presale_id, wallet, commitment, last_commit_ms, claim_digest, claimed_tokens, claimed_quote_refund, claimed_ms, claimable_tokens, claimable_quote_refund, participant_vesting, claim_vesting_id
  FROM blast_infra_fixture.presale_positions;
  CREATE TABLE blast_infra_fixture.wallet_sync (
    owner TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'ready', checkpoint BIGINT DEFAULT 80001,
    timestamp_ms BIGINT NOT NULL, refreshed_at TIMESTAMPTZ DEFAULT now()
  );
  CREATE VIEW chain_read_v1.wallet_balances AS
    SELECT owner, coin_type, balance FROM blast_infra_fixture.coin_balances WHERE balance > 0;
  CREATE VIEW chain_read_v1.wallet_sync AS SELECT * FROM blast_infra_fixture.wallet_sync;
  ALTER TABLE blast_infra_fixture.wallet_sync OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.wallet_balances OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.wallet_sync OWNER TO blast_indexer;
  GRANT SELECT ON chain_read_v1.wallet_balances, chain_read_v1.wallet_sync TO blast_web, blast_watcher, blast_social, blast_replica;
  CREATE VIEW chain_read_v1.coin_balances AS
  SELECT coin_type, owner, balance, updated_checkpoint FROM blast_infra_fixture.coin_balances;
  CREATE VIEW chain_read_v1.coin_holder_history AS
  SELECT coin_type, checkpoint, timestamp_ms, holders FROM blast_infra_fixture.coin_holder_history;
  CREATE VIEW chain_read_v1.prices AS
  SELECT coin_type, usd_price, as_of_ms, source FROM blast_infra_fixture.prices;
  CREATE VIEW chain_read_v1.vesting_schedules AS
  SELECT schedule_id, presale_id, beneficiary, total, claimed, start_ms, cliff_ms, end_ms, share, asset, period_ms, periods FROM blast_infra_fixture.vesting_schedules;
  CREATE VIEW chain_read_v1.price_history AS
  SELECT coin_type, resolution, bucket_ms, trim_scale(usd_price) AS usd_price, as_of_ms, source FROM blast_infra_fixture.price_history;
  CREATE TABLE blast_infra_fixture.native_coin_prices (
    coin_type TEXT NOT NULL, cutoff_ms BIGINT NOT NULL, usd_price NUMERIC NOT NULL, as_of_ms BIGINT NOT NULL,
    PRIMARY KEY (coin_type, cutoff_ms, as_of_ms)
  );
  ALTER TABLE blast_infra_fixture.native_coin_prices OWNER TO blast_indexer;
  CREATE FUNCTION chain_read_v1.native_coin_price_at(TEXT, BIGINT)
    RETURNS TABLE (usd_price NUMERIC, as_of_ms BIGINT)
    LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
      SELECT p.usd_price, p.as_of_ms FROM blast_infra_fixture.native_coin_prices p
      WHERE p.coin_type = $1 AND p.cutoff_ms = $2 AND p.as_of_ms <= $2
      ORDER BY p.as_of_ms DESC LIMIT 1
    $$;
  ALTER FUNCTION chain_read_v1.native_coin_price_at(TEXT, BIGINT) OWNER TO blast_indexer;
  REVOKE ALL ON FUNCTION chain_read_v1.native_coin_price_at(TEXT, BIGINT) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION chain_read_v1.native_coin_price_at(TEXT, BIGINT)
    TO blast_web, blast_watcher, blast_social, blast_replica;
  CREATE FUNCTION chain_read_v1.coin_price_in_window(TEXT, BIGINT, BIGINT, BOOLEAN)
    RETURNS TABLE (usd_price NUMERIC, as_of_ms BIGINT)
    LANGUAGE sql STABLE SECURITY DEFINER ROWS 1 SET search_path = pg_catalog AS $$
      WITH native AS MATERIALIZED (
        SELECT p.usd_price, p.as_of_ms FROM blast_infra_fixture.native_coin_prices p
        WHERE p.coin_type = $1 AND p.cutoff_ms <= $2 AND p.as_of_ms > $2 AND p.as_of_ms <= $3 AND p.as_of_ms > p.cutoff_ms
        ORDER BY CASE WHEN $4 THEN p.as_of_ms ELSE -p.as_of_ms END LIMIT 1
      )
      SELECT observed.usd_price, observed.as_of_ms
      FROM (
        SELECT native.*, true AS is_native FROM native
        UNION ALL
        SELECT ph.usd_price, ph.as_of_ms, false
        FROM blast_infra_fixture.price_history ph
        WHERE ph.coin_type = $1 AND ph.resolution = '5m' AND ph.usd_price > 0
          AND ph.as_of_ms > $2 AND ph.as_of_ms <= $3 AND (NOT $4 OR NOT EXISTS (SELECT FROM native))
      ) observed
      ORDER BY CASE WHEN $4 THEN observed.as_of_ms ELSE -observed.as_of_ms END, observed.is_native DESC
      LIMIT 1
    $$;
  ALTER FUNCTION chain_read_v1.coin_price_in_window(TEXT, BIGINT, BIGINT, BOOLEAN) OWNER TO blast_indexer;
  REVOKE ALL ON FUNCTION chain_read_v1.coin_price_in_window(TEXT, BIGINT, BIGINT, BOOLEAN) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION chain_read_v1.coin_price_in_window(TEXT, BIGINT, BIGINT, BOOLEAN)
    TO blast_web, blast_watcher, blast_social, blast_replica;
  CREATE TABLE blast_infra_fixture.presale_pool_prices (
    presale_id TEXT PRIMARY KEY, coin_type TEXT NOT NULL, quote_type TEXT NOT NULL,
    quote_symbol TEXT NOT NULL, price_quote NUMERIC NOT NULL, as_of_ms BIGINT NOT NULL
  );
  CREATE TABLE blast_infra_fixture.presale_pool_price_history (
    presale_id TEXT NOT NULL, resolution TEXT NOT NULL, bucket_ms BIGINT NOT NULL,
    price_quote NUMERIC NOT NULL, as_of_ms BIGINT NOT NULL,
    PRIMARY KEY (presale_id, resolution, bucket_ms)
  );
  CREATE VIEW chain_read_v1.presale_pool_prices AS SELECT * FROM blast_infra_fixture.presale_pool_prices;
  CREATE TABLE blast_infra_fixture.presale_pool_swaps (
    presale_id TEXT NOT NULL, coin_type TEXT NOT NULL, quote_type TEXT NOT NULL,
    pool_id TEXT NOT NULL, venue TEXT NOT NULL, checkpoint BIGINT NOT NULL,
    tx_slot BIGINT NOT NULL, event_slot BIGINT NOT NULL, timestamp_ms BIGINT NOT NULL,
    coin_amount NUMERIC, quote_amount NUMERIC,
    PRIMARY KEY (coin_type, checkpoint, tx_slot, event_slot)
  );
  CREATE TABLE blast_infra_fixture.checkpoint_headers (checkpoint BIGINT PRIMARY KEY, digest TEXT, timestamp_ms BIGINT NOT NULL);
  CREATE VIEW chain_read_v1.checkpoint_headers AS SELECT * FROM blast_infra_fixture.checkpoint_headers;
  ALTER TABLE blast_infra_fixture.checkpoint_headers OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.checkpoint_headers OWNER TO blast_indexer;
  REVOKE ALL ON chain_read_v1.checkpoint_headers FROM PUBLIC;
  GRANT SELECT ON chain_read_v1.checkpoint_headers TO blast_web, blast_watcher, blast_social, blast_replica;
  CREATE VIEW chain_read_v1.presale_pool_swaps AS SELECT * FROM blast_infra_fixture.presale_pool_swaps;
  ALTER TABLE blast_infra_fixture.presale_pool_swaps OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.presale_pool_swaps OWNER TO blast_indexer;
  REVOKE ALL ON chain_read_v1.presale_pool_swaps FROM PUBLIC;
  GRANT SELECT ON chain_read_v1.presale_pool_swaps TO blast_web, blast_watcher, blast_social, blast_replica;
  CREATE VIEW chain_read_v1.presale_pool_price_history AS SELECT * FROM blast_infra_fixture.presale_pool_price_history;
  ALTER VIEW chain_read_v1.presale_pool_prices OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.presale_pool_price_history OWNER TO blast_indexer;
  ALTER TABLE blast_infra_fixture.presale_pool_prices OWNER TO blast_indexer;
  ALTER TABLE blast_infra_fixture.presale_pool_price_history OWNER TO blast_indexer;
  REVOKE ALL ON chain_read_v1.presale_pool_prices, chain_read_v1.presale_pool_price_history FROM PUBLIC;
  GRANT SELECT ON chain_read_v1.presale_pool_prices, chain_read_v1.presale_pool_price_history TO blast_web, blast_watcher, blast_social, blast_replica;
  -- blast-infra's sale_coin_pools with their balances: one row per tracked coin.
  CREATE TABLE blast_infra_fixture.pool_reserves (
    coin_type TEXT PRIMARY KEY, quote_type TEXT NOT NULL, presale_id TEXT NOT NULL, pool_id TEXT NOT NULL,
    venue TEXT NOT NULL, coin_reserve NUMERIC NOT NULL, quote_reserve NUMERIC NOT NULL,
    checkpoint BIGINT NOT NULL, timestamp_ms BIGINT NOT NULL
  );
  CREATE VIEW chain_read_v1.pool_reserves AS SELECT * FROM blast_infra_fixture.pool_reserves;
  ALTER TABLE blast_infra_fixture.pool_reserves OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.pool_reserves OWNER TO blast_indexer;
  REVOKE ALL ON chain_read_v1.pool_reserves FROM PUBLIC;
  GRANT SELECT ON chain_read_v1.pool_reserves TO blast_web, blast_watcher, blast_social, blast_replica;
  ALTER VIEW chain_read_v1.activity OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.presale_lifecycle OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.presales OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.presale_positions OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.coin_balances OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.coin_holder_history OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.prices OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.vesting_schedules OWNER TO blast_indexer;
  ALTER VIEW chain_read_v1.price_history OWNER TO blast_indexer;
  REVOKE ALL ON chain_read_v1.activity, chain_read_v1.presale_lifecycle, chain_read_v1.presales,
    chain_read_v1.presale_positions, chain_read_v1.coin_balances, chain_read_v1.coin_holder_history,
    chain_read_v1.prices, chain_read_v1.vesting_schedules, chain_read_v1.price_history
  FROM PUBLIC;
  GRANT SELECT ON chain_read_v1.activity, chain_read_v1.presale_lifecycle, chain_read_v1.presales,
    chain_read_v1.presale_positions, chain_read_v1.coin_balances, chain_read_v1.coin_holder_history,
    chain_read_v1.prices, chain_read_v1.vesting_schedules, chain_read_v1.price_history
  TO blast_web, blast_watcher, blast_social, blast_replica;

  INSERT INTO coins (coin_type, decimals, launcher, creator, metadata, pool_key, created_checkpoint, created_at_ms)
  VALUES ('0x1::meme::MEME', 9, '0xc0ffee', '0xc0ffee',
    '{"name":"Meme","symbol":"MEME","description":"","icon_url":"https://i/meme.png"}',
    'blast_curve:0xpool', 900, 1790000000000);
  INSERT INTO pools (pool_key, venue, coin_type, quote_type, lifecycle, created_checkpoint, created_at_ms)
  VALUES ('blast_curve:0xpool', 'blast_curve', '0x1::meme::MEME', '0x2::sui::SUI', 'live', 900, 1790000000000);
  INSERT INTO deployment_identity (network, deployment_fingerprint)
  VALUES ('${FIXTURE_NETWORK}', '${FIXTURE_FINGERPRINT}');
  INSERT INTO watermarks
  SELECT pipeline, 900, ${FIXTURE_CHECKPOINT}, 1000, floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint,
    0, now(), 0, decode('${FIXTURE_CHAIN_ID}', 'hex')
  FROM unnest(ARRAY['market', 'presale', 'intake']) AS pipeline;
  INSERT INTO checkpoint_journal
  (checkpoint, network, digest, previous_digest, epoch, timestamp_ms, total_transactions, format_version, payload, payload_hash)
  SELECT ${FIXTURE_CHECKPOINT}, '${FIXTURE_NETWORK}', '${"1".repeat(32)}', NULL, 900,
    timestamp_ms_hi_inclusive, 0, 1, ''::bytea, decode(repeat('00',32),'hex')
  FROM watermarks WHERE pipeline = 'intake';
`;

/** blast-infra's `pipeline` committing a checkpoint `ageMs` before now, as its commit path advances the watermark. */
export function advanceWatermark(
  checkpoint: number,
  ageMs = 0,
  pipeline: "market" | "presale" = "market",
): string {
  return `UPDATE watermarks
    SET checkpoint_hi_inclusive = ${checkpoint},
        timestamp_ms_hi_inclusive = floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint - ${ageMs}
    WHERE pipeline = '${pipeline}'`;
}

export async function resetSharedDatabase(admin: Pool): Promise<void> {
  await admin.query(`
    DROP SCHEMA IF EXISTS chain_v1 CASCADE;
    DROP SCHEMA IF EXISTS chain_read_v1 CASCADE;
    DROP SCHEMA IF EXISTS blast_infra_fixture CASCADE;
    DROP SCHEMA public CASCADE;
    CREATE SCHEMA public;
    ALTER SCHEMA public OWNER TO pg_database_owner;
    GRANT USAGE ON SCHEMA public TO PUBLIC;
  `);
}
