-- 0066's definition, exactly: whys on trade entries (event_slot u32::MAX)
-- fail their insert again. Whys stored meanwhile keep the sale they got.
CREATE OR REPLACE FUNCTION social_whys_presale_of(entry_id TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT a.presale_id
  FROM chain_read_v1.activity a
  WHERE entry_id ~ '^a:[0-9]+:[0-9]+:[0-9]+:[0-9]+$'
    AND a.checkpoint = split_part(entry_id, ':', 2)::bigint
    AND a.tx_slot = split_part(entry_id, ':', 3)::integer
    AND a.event_slot = split_part(entry_id, ':', 4)::integer
    AND a.part = split_part(entry_id, ':', 5)::integer
$$;
