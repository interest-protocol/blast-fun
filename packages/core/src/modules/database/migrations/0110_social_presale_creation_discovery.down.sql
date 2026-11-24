CREATE OR REPLACE VIEW social_feed_entries WITH (security_invoker = true) AS
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

DROP VIEW social_published_presales;
