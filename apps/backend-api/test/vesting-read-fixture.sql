-- Utility table and read views copied verbatim from blast-infra universal_vesting/up.sql.
-- Source SHA256 664648117a353e88fdb64c58d9cdb2a9e02bb89a37bde3e7dbaaa14afc383f00
-- Reduced prerequisites for the existing loopback chain fixture; empty presale link table.
CREATE DOMAIN u32 AS BIGINT CHECK (VALUE BETWEEN 0 AND 4294967295);
CREATE DOMAIN u64 AS NUMERIC CHECK (VALUE BETWEEN 0 AND 18446744073709551615);
CREATE TABLE presale_vesting_schedules(vesting_id TEXT PRIMARY KEY,presale_id TEXT NOT NULL);
ALTER TABLE presale_vesting_schedules OWNER TO blast_indexer;
-- Independent utility history. Never delete a schedule when its Move object disappears.
CREATE TABLE utility_vesting_schedules (
    schedule_id TEXT PRIMARY KEY CHECK (schedule_id ~ '^0x[0-9a-f]{64}$'),
    kind TEXT NOT NULL CHECK (kind IN ('linear', 'checkpoints')),
    coin_type TEXT NOT NULL,
    beneficiary TEXT NOT NULL,
    creator TEXT NOT NULL,
    total u64 NOT NULL CHECK (total > 0),
    released u64 NOT NULL DEFAULT 0 CHECK (released <= total),
    refund_recipient TEXT,
    cancel_cap_id TEXT,
    terms JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled', 'closed')),
    refunded u64 NOT NULL DEFAULT 0,
    created_checkpoint BIGINT NOT NULL,
    created_timestamp_ms BIGINT NOT NULL,
    created_digest TEXT NOT NULL,
    applied_checkpoint BIGINT NOT NULL,
    CHECK ((refund_recipient IS NULL) = (cancel_cap_id IS NULL)),
    CHECK (released + refunded <= total),
    CHECK (status <> 'closed' OR released = total),
    CHECK (status <> 'canceled' OR released + refunded = total)
);
CREATE INDEX utility_vesting_beneficiary ON utility_vesting_schedules (beneficiary, created_checkpoint DESC, schedule_id);
CREATE INDEX utility_vesting_creator ON utility_vesting_schedules (creator, created_checkpoint DESC, schedule_id);
CREATE TABLE utility_vesting_events (
    checkpoint BIGINT NOT NULL,
    tx_slot u32 NOT NULL,
    event_slot u32 NOT NULL,
    schedule_id TEXT NOT NULL REFERENCES utility_vesting_schedules,
    kind TEXT NOT NULL CHECK (kind IN ('created', 'claimed', 'canceled', 'closed')),
    timestamp_ms BIGINT NOT NULL,
    digest TEXT NOT NULL,
    payload JSONB NOT NULL,
    PRIMARY KEY (checkpoint, tx_slot, event_slot)
);
CREATE INDEX utility_vesting_event_schedule ON utility_vesting_events (schedule_id, checkpoint, tx_slot, event_slot);
ALTER TABLE utility_vesting_schedules OWNER TO blast_indexer;
ALTER TABLE utility_vesting_events OWNER TO blast_indexer;
REVOKE ALL ON utility_vesting_schedules, utility_vesting_events FROM PUBLIC, blast_web, blast_watcher, blast_social, blast_replica;
CREATE VIEW chain_read_v1.utility_vesting_schedules AS
SELECT s.*, p.presale_id, m.name AS coin_name, m.symbol AS coin_symbol, m.decimals AS coin_decimals, m.icon_url AS coin_icon_url
FROM utility_vesting_schedules s
LEFT JOIN presale_vesting_schedules p ON p.vesting_id = s.schedule_id
LEFT JOIN chain_read_v1.coin_metadata m ON m.coin_type = s.coin_type;
CREATE VIEW chain_read_v1.utility_vesting_events AS SELECT * FROM utility_vesting_events;
ALTER VIEW chain_read_v1.utility_vesting_schedules OWNER TO blast_indexer;
ALTER VIEW chain_read_v1.utility_vesting_events OWNER TO blast_indexer;
REVOKE ALL ON chain_read_v1.utility_vesting_schedules, chain_read_v1.utility_vesting_events FROM PUBLIC;
GRANT SELECT ON chain_read_v1.utility_vesting_schedules, chain_read_v1.utility_vesting_events TO blast_web, blast_watcher, blast_social, blast_replica;
