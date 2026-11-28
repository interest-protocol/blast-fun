-- Fixture only. Install blast-infra migrations into a disposable PostgreSQL 16 database first.
BEGIN;
SET LOCAL search_path = blast_infra;
CREATE ROLE live_load_reader LOGIN PASSWORD 'disposable-reader';
GRANT blast_committed_reader TO live_load_reader;
INSERT INTO deployment_identity (network, deployment_fingerprint) VALUES ('mainnet', repeat('a', 64));
INSERT INTO committed_read_labels (whale_trade_usd, whale_holding_bps, top_trader_rank_cutoff) VALUES (1000, 100, 10);
INSERT INTO watermarks (pipeline, epoch_hi_inclusive, checkpoint_hi_inclusive, tx_hi, timestamp_ms_hi_inclusive, reader_lo, pruner_timestamp, pruner_hi)
VALUES ('market', 0, 1, 0, (extract(epoch FROM clock_timestamp()) * 1000)::bigint, 0, now(), 0);
UPDATE committed_read_models SET model_version=1, network='mainnet', deployment_fingerprint=repeat('a',64), seeded_checkpoint=1;
UPDATE committed_read_progress SET revision=1, applied_checkpoint=1, applied_timestamp_ms=(SELECT timestamp_ms_hi_inclusive FROM watermarks WHERE pipeline='market') WHERE pipeline='market';
INSERT INTO financial_price_coverage
SELECT true, 1, 1, timestamp_ms_hi_inclusive, '{}'::jsonb FROM watermarks WHERE pipeline='market';
INSERT INTO financial_quote_configs VALUES (1, '{}'::jsonb);

INSERT INTO pools (pool_key, venue, coin_type, quote_type, orientation, params, meme_reserve, quote_reserve, lifecycle,
                   created_checkpoint, created_tx_slot, created_event_slot, created_part, created_at_ms)
SELECT 'blast_curve:0x' || lpad(to_hex(n),64,'0'), 'blast_curve', '0x' || lpad(to_hex(n+100),64,'0') || '::fixture::COIN',
       CASE WHEN n=17 THEN '0x963331df9a26c8674c33eb97655fe44807d5ff1aa4092bcbe2bdbe044b17b03d::test_sui::TEST_SUI'
            ELSE '0x' || lpad('2',64,'0') || '::sui::SUI' END,
       'meme_first', '{"virtual_quote":"10000","graduation_target":"10000","quote_fee_bps":"1","meme_fee_bps":"1",
         "launch":{"venue":"0x2::cetus::Venue","lp_fee_split":{"routes":[]},"allocation_plan":{"curve_meme_bps":9000,"lp_meme_bps":1000,"lp_quote_bps":10000,"protocol_meme_bps":0,"protocol_quote_bps":0,"recipients":[]},"opening_round_ms":0,"creation_fee":0,"partner_id":null}}',
       10000, 5999 + n % 4, 'live', 1, n, 0, 0, (extract(epoch FROM clock_timestamp()) * 1000)::bigint - 30000 + n
FROM generate_series(1,17) n;
INSERT INTO coins (coin_type,ticket_id,metadata_cap_id,launcher,decimals,initial_supply,burnable,sell_burn_bps,
                   currency_supply,pending_burn_total,pool_key,created_checkpoint,created_tx_slot,created_event_slot,created_part,created_at_ms,metadata)
SELECT coin_type,'0x'||lpad(to_hex(created_tx_slot+1000),64,'0'),'0x'||lpad(to_hex(created_tx_slot+2000),64,'0'),
       '0x'||lpad('1',64,'0'),9,1000000,false,0,1000000,0,pool_key,created_checkpoint,created_tx_slot,created_event_slot,created_part,created_at_ms,
       jsonb_build_object('name','Fixture '||created_tx_slot,'symbol','F'||created_tx_slot,'description','','icon_url','')
FROM pools;
INSERT INTO coin_holder_totals SELECT coin_type, 0, 0 FROM coins;

CREATE TABLE trades_live_discovery_fixture PARTITION OF trades DEFAULT;
COMMIT;
