-- Social feed (R3-32's finding, before R3-55 lets a trade carry a why): 0066's
-- `social_whys_presale_of` read an activity entry id's slots as `integer`.
-- blast-infra's cursor parts are `u32` (`<checkpoint>:<tx_slot>:<event_slot>:<part>`,
-- `chain_read_v1.activity` publishes them as BIGINT), and T-038's trade rows,
-- found by balance changes rather than an event, carry `event_slot`
-- 4294967295 (u32::MAX). `4294967295::integer` is out of range, so a why on a
-- trade's entry (`a:<checkpoint>:<tx_slot>:4294967295:<part>`) failed its
-- insert (22003) in the trigger instead of storing the trade's sale.
--
-- The function now reads every part as `bigint`, and only from an id whose
-- parts fit: a checkpoint of at most 18 digits and slots of at most 10, so no
-- id the why route accepts can make the cast fail (an id outside that shape
-- is not an activity row's, and keeps a null sale as before). The guard is a
-- CASE inside each comparison, so it holds whatever order the planner
-- evaluates the conditions in. The comparisons are still the view's key, so
-- the lookup is the same index probe.
--
-- 0066 is not edited in place: the migration runner checks the checksum of
-- every applied migration, and a database that applied 0066 must keep
-- starting. The rest of 0066 (the column, the trigger, the index) is
-- unchanged. No grant changes: the function keeps its owner, and the roles
-- that insert whys (`blast_web`, `blast_watcher`) already read the view.
CREATE OR REPLACE FUNCTION social_whys_presale_of(entry_id TEXT)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT a.presale_id
  FROM chain_read_v1.activity a
  WHERE a.checkpoint = CASE WHEN entry_id ~ '^a:[0-9]{1,18}:[0-9]{1,10}:[0-9]{1,10}:[0-9]{1,10}$'
      THEN split_part(entry_id, ':', 2)::bigint END
    AND a.tx_slot = CASE WHEN entry_id ~ '^a:[0-9]{1,18}:[0-9]{1,10}:[0-9]{1,10}:[0-9]{1,10}$'
      THEN split_part(entry_id, ':', 3)::bigint END
    AND a.event_slot = CASE WHEN entry_id ~ '^a:[0-9]{1,18}:[0-9]{1,10}:[0-9]{1,10}:[0-9]{1,10}$'
      THEN split_part(entry_id, ':', 4)::bigint END
    AND a.part = CASE WHEN entry_id ~ '^a:[0-9]{1,18}:[0-9]{1,10}:[0-9]{1,10}:[0-9]{1,10}$'
      THEN split_part(entry_id, ':', 5)::bigint END
$$;
