-- Social feed (T-001): every feed entry, read from blast-infra's
-- `chain_read_v1` activity and presale lifecycle and from the watcher's
-- milestones (0054). Nothing is copied: an entry's id is derived from its
-- chain identity, so it is the same after an indexer rebuild.
--
-- Ordering: blast-infra's migrations must publish `chain_read_v1.activity`
-- and `chain_read_v1.presale_lifecycle` before this migration runs. The view
-- depends on them, so blast-infra may change them only with CREATE OR REPLACE
-- VIEW that appends columns.
DO $$
BEGIN
  IF to_regclass('chain_read_v1.activity') IS NULL OR to_regclass('chain_read_v1.presale_lifecycle') IS NULL THEN
    RAISE EXCEPTION 'social_feed_entries reads chain_read_v1.activity and chain_read_v1.presale_lifecycle: run blast-infra''s migrations first'
      USING ERRCODE = 'undefined_table';
  END IF;
END
$$;

-- `actor` is null for lifecycle and milestone entries; the activity columns
-- are null outside activity entries, and `milestone_value` outside milestones.
-- Activity kinds are open: a kind blast-infra adds appears unchanged.
CREATE VIEW social_feed_entries WITH (security_invoker = true) AS
SELECT
  'a:' || a.activity_id AS entry_id,
  'activity'::text AS source,
  a.kind,
  a.product,
  a.timestamp_ms AS occurred_at_ms,
  a.actor,
  a.presale_id,
  a.coin_type,
  a.digest,
  a.activity_id,
  a.quote_type,
  a.quote_amount,
  a.coin_amount,
  a.quote_refund,
  a.usd_value,
  a.usd_price_as_of_ms,
  NULL::numeric AS milestone_value
FROM chain_read_v1.activity a
UNION ALL
SELECT
  'l:' || l.presale_id || ':' || l.state,
  'lifecycle',
  'presale_' || l.state,
  'presale',
  l.timestamp_ms,
  NULL,
  l.presale_id,
  NULL,
  l.digest,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL
FROM chain_read_v1.presale_lifecycle l
UNION ALL
SELECT
  m.entry_id,
  'milestone',
  'milestone_' || m.kind,
  'presale',
  m.timestamp_ms,
  NULL,
  m.presale_id,
  m.coin_type,
  m.digest,
  m.activity_id,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  NULL,
  m.value
FROM social_milestones m;

REVOKE ALL ON TABLE social_feed_entries FROM PUBLIC;
GRANT SELECT ON TABLE social_feed_entries TO blast_web, blast_watcher, blast_replica;
