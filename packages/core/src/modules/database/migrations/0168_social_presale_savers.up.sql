-- Home Trending ranks presales next to coins, an upcoming sale too (Jose
-- 2026-11-25). Before a sale opens its only traction is the people who saved
-- it to their watchlist (`social_watchlist`, 0072). This view serves that as
-- counts per presale: how many X-verified accounts saved it, and how many of
-- those saved it in the last hour and the last day.
--
-- Only verified accounts count (X linked, `social_account_identities`), so a
-- burst of fresh accounts cannot lift a sale. The watchlist stays private:
-- the view returns counts only, never an account, and its owner's rights
-- read the table, so the replica gets the counts without the rows.
--
-- `social_watchlist_presale_idx` serves the per-presale lookup that Home's
-- read pushes into the view (`WHERE presale_id = ...`). A watchlist row keyed
-- by a coin type (0163) is not a presale and is left out. `security_barrier`
-- keeps a caller's predicate from running before those filters.
-- Fail fast rather than queue stars behind a long transaction (as 0163).
SET LOCAL lock_timeout = '3s';

CREATE INDEX social_watchlist_presale_idx ON social_watchlist (presale_id, created_at);

CREATE VIEW social_presale_savers WITH (security_barrier) AS
SELECT
  w.presale_id,
  count(*)::int AS savers,
  (count(*) FILTER (WHERE w.created_at > now() - interval '1 hour'))::int AS gained_1h,
  (count(*) FILTER (WHERE w.created_at > now() - interval '24 hours'))::int AS gained_24h
FROM social_watchlist w
JOIN social_account_identities i ON i.account_id = w.account_id AND i.verified
WHERE w.presale_id ~ '^0x[0-9a-f]{64}$'
GROUP BY w.presale_id;

-- Read by the web on the primary and the replica. Counts only.
REVOKE ALL ON TABLE social_presale_savers FROM PUBLIC;
GRANT SELECT ON TABLE social_presale_savers TO blast_web, blast_replica;
