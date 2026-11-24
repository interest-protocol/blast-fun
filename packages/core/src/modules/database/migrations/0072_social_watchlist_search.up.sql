-- Social feed UI-12 (canonical UI §12 Search, and the watchlist star of
-- owner decision OA-11).
--
-- - `social_watchlist`: the presales an account starred, a saved list
--   separate from following (OA-11). Private: only the web runtime reads and
--   writes it, for the account itself; the replica never sees it. Adding and
--   removing are idempotent (the primary key); the page index serves the
--   keyset list, newest first.
-- - `social_account_search`: who search may find, with the public identity
--   a result row shows. Two branches, each matched through its own trigram
--   index (pg_trgm, `LIKE '%term%'` on a lowercased haystack):
--     1. Blast accounts that are public: a new account's own callsign and
--        name, or a member's Blast name override (its callsign lives on the
--        profile, so its haystack holds the override only);
--     2. Mission Control members (their profile's callsign and name), with
--        or without an account row yet (a member's profile page creates the
--        row on its first read), unless the account is private.
--   A member whose Blast name overrides the profile's still matches the
--   profile branch by its old name; the reader re-checks every match against
--   the row's current callsign and name (`search/read.ts`), so an old name
--   never finds anyone. Private accounts are never in the view. Like
--   `social_account_identities` it runs with its owner's rights, so the
--   replica reads these public columns and nothing else of a profile.
--
-- The extension stays on the way down: it holds no data and another schema
-- (blast-infra's) may use it.

CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE social_watchlist (
  account_id UUID NOT NULL REFERENCES social_accounts (account_id),
  presale_id TEXT NOT NULL CONSTRAINT social_watchlist_presale_id CHECK (presale_id ~ '^0x[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, presale_id)
);

CREATE INDEX social_watchlist_page_idx ON social_watchlist (account_id, created_at DESC, presale_id DESC);

CREATE VIEW social_account_search AS
SELECT
  COALESCE(p.callsign, a.callsign) AS callsign,
  COALESCE(a.display_name, p.display_name) AS display_name,
  CASE a.picture
    WHEN 'upload' THEN a.picture_url
    WHEN 'none' THEN NULL
    ELSE CASE WHEN a.profile_id IS NULL THEN a.x_avatar_url ELSE COALESCE(p.avatar_reference, p.x_avatar_reference) END
  END AS avatar_url,
  CASE WHEN a.profile_id IS NULL THEN a.x_subject IS NOT NULL ELSE p.x_subject IS NOT NULL END AS verified,
  lower(COALESCE(a.callsign, '') || ' ' || COALESCE(a.display_name, '')) AS haystack
FROM social_accounts a
LEFT JOIN LATERAL (
  SELECT mp.callsign, mp.display_name, mp.avatar_reference, mp.x_avatar_reference, mp.x_subject
  FROM mission_control_profiles mp WHERE mp.profile_id = a.profile_id LIMIT 1
) p ON TRUE
WHERE a.privacy = 'public'
UNION ALL
SELECT
  p.callsign,
  COALESCE(a.display_name, p.display_name) AS display_name,
  CASE a.picture
    WHEN 'upload' THEN a.picture_url
    WHEN 'none' THEN NULL
    ELSE COALESCE(p.avatar_reference, p.x_avatar_reference)
  END AS avatar_url,
  p.x_subject IS NOT NULL AS verified,
  lower(p.callsign || ' ' || COALESCE(p.display_name, '')) AS haystack
FROM mission_control_profiles p
LEFT JOIN LATERAL (
  SELECT sa.account_id, sa.display_name, sa.picture, sa.picture_url, sa.privacy
  FROM social_accounts sa WHERE sa.profile_id = p.profile_id LIMIT 1
) a ON TRUE
WHERE a.account_id IS NULL OR a.privacy = 'public';

-- One trigram index per branch, on exactly the branch's haystack expression
-- (and, for accounts, its privacy filter), so a pushed-down `LIKE` uses it.
-- Each branch reaches its other table by a unique key per matched row (the
-- LATERAL ... LIMIT 1 keeps the planner from joining every account to every
-- profile: 1.2 ms against 5.6 ms for "luca" at 10k accounts).
CREATE INDEX social_accounts_search_trgm_idx ON social_accounts
  USING gin (lower(COALESCE(callsign, '') || ' ' || COALESCE(display_name, '')) gin_trgm_ops)
  WHERE privacy = 'public';
CREATE INDEX social_profiles_search_trgm_idx ON mission_control_profiles
  USING gin (lower(callsign || ' ' || COALESCE(display_name, '')) gin_trgm_ops);

-- The web runtime stars and unstars for its accounts and reads them back; the
-- replica reads only the public search view.
REVOKE ALL ON TABLE social_watchlist FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON TABLE social_watchlist TO blast_web;
REVOKE ALL ON TABLE social_account_search FROM PUBLIC;
GRANT SELECT ON TABLE social_account_search TO blast_web, blast_replica;
